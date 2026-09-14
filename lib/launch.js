const { spawn, spawnSync } = require( 'child_process' );
const fs    = require( 'fs' );
const http  = require( 'http' );
const https = require( 'https' );
const os    = require( 'os' );
const path  = require( 'path' );

const { hardlinkTree, prepareMounts, pluginSourceRoot } = require( './mounts' );
const {
	ENGINE_ROOT,
	ensureHarnessKey,
	pidAlive,
	playgroundDir,
	readRun,
	siteDir,
	writeRun,
} = require( './state' );

const DEFAULT_WP   = 'latest';
const DEFAULT_PHP  = '8.3';
const DEFAULT_PORT = '9400';
const DEFAULT_SITE = 'default';
const READY_MS     = 2000;
const READY_TRIES  = 90;

/**
 * @param {string} spec Package subpath.
 * @return {string}
 */
function resolveCli() {

	let pkg;

	try {
		pkg = require.resolve( '@wp-playground/cli/package.json' );
	} catch {
		throw new Error(
			`@wp-playground/cli missing in ${ENGINE_ROOT}. Run npm install.`,
		);
	}

	const bin = path.join( path.dirname( pkg ), 'wp-playground.js' );

	if ( ! fs.existsSync( bin ) )
		throw new Error(
			`@wp-playground/cli bin missing at ${bin}. Run npm install.`,
		);

	return bin;
}

/**
 * @param {string} url
 * @return {Promise<Boolean>}
 */
function isReady( url ) {
	return new Promise( resolve => {

		const req = http.get( url, res => {
			req.destroy();
			resolve( res.statusCode > 0 && res.statusCode < 500 );
		} );

		req.on( 'error', () => resolve( false ) );
		req.end();
	} );
}

/**
 * @param {string} [logFile]
 * @return {string}
 */
function exitReason( logFile ) {

	let tail = '';

	try {
		if ( logFile )
			tail = fs.readFileSync( logFile, 'utf8' ).slice( -2000 );
	} catch {}

	if ( tail.includes( 'Error connecting to the SQLite database' ) )
		return 'SQLite failed to open. Retry launch, or use --site with a new id, or delete sites/<id>/database/.ht.sqlite.';

	return 'Playground process exited. See .local/playground/server.log.';
}

/**
 * @param {string} url
 * @param {number} tries
 * @param {number} [pid]
 * @param {string} [logFile]
 * @return {Promise<void>}
 */
async function waitReady( url, tries, pid, logFile ) {

	for ( let i = 0; i < tries; i++ ) {
		if ( pid && ! pidAlive( pid ) )
			throw new Error( exitReason( logFile ) );

		if ( await isReady( url ) )
			return;

		await new Promise( r => setTimeout( r, READY_MS ) );
	}

	throw new Error( `Playground did not become ready at ${url}.` );
}

/**
 * @param {string} zipUrl
 * @param {string} dest
 * @return {Promise<void>}
 */
function downloadFile( zipUrl, dest ) {
	return new Promise( ( resolve, reject ) => {

		const file = fs.createWriteStream( dest );

		https.get( zipUrl, res => {

			if ( res.statusCode >= 300 && res.statusCode < 400 && res.headers.location ) {
				file.close();
				fs.unlinkSync( dest );
				downloadFile( res.headers.location, dest ).then( resolve, reject );

				return;
			}

			if ( 200 !== res.statusCode ) {
				file.close();
				reject( new Error( `Download failed ${res.statusCode}: ${zipUrl}` ) );

				return;
			}

			res.pipe( file );
			file.on( 'finish', () => file.close( resolve ) );
		} ).on( 'error', reject );
	} );
}

/**
 * Unzip once. Windows Expand-Archive; elsewhere unzip.
 *
 * @param {string} zipPath
 * @param {string} dest
 */
function unzipOnce( zipPath, dest ) {

	fs.mkdirSync( dest, { recursive: true } );

	let result;

	if ( 'win32' === process.platform ) {
		result = spawnSync(
			'powershell',
			[
				'-NoProfile',
				'-Command',
				`Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${dest}' -Force`,
			],
			{ stdio: 'inherit' },
		);
	} else {
		result = spawnSync(
			'unzip',
			[ '-o', zipPath, '-d', dest ],
			{ stdio: 'inherit' },
		);
	}

	if ( result.status )
		throw new Error( `Unzip failed for ${zipPath}.` );
}

/**
 * @param {string} root
 * @param {string} slug
 * @param {string} mainFile
 * @return {Promise<string>}
 */
async function ensureWporg( root, slug, mainFile ) {

	const cache = path.join( playgroundDir( root ), 'cache', slug );
	const zip   = path.join( playgroundDir( root ), 'cache', `${slug}.zip` );

	try {
		return pluginSourceRoot( cache, slug, mainFile );
	} catch {}

	fs.mkdirSync( path.dirname( zip ), { recursive: true } );

	if ( ! fs.existsSync( zip ) ) {
		const url = `https://downloads.wordpress.org/plugin/${slug}.latest-stable.zip`;
		console.log( `Downloading ${url}` );
		await downloadFile( url, zip );
	}

	unzipOnce( zip, cache );

	return pluginSourceRoot( cache, slug, mainFile );
}

/**
 * @param {Object} plugin
 * @param {string} wp
 * @param {string} php
 * @param {string} dest
 * @param {string} [themeSlug]
 */
function writeBlueprint( plugin, wp, php, dest, themeSlug ) {

	const template = path.join( ENGINE_ROOT, 'blueprints', 'vanilla.json' );
	const data     = JSON.parse( fs.readFileSync( template, 'utf8' ) );

	// Pretty permalinks. Do not flush_rewrite_rules() here — that writes
	// incomplete rules and post URLs fall through to home. delete_option so
	// a later init rebuilds them after post types exist.
	//
	// Workaround until
	// https://github.com/WordPress/wordpress-playground/issues/4325 is patched.
	// @wp-playground/wordpress writes it into the PHP VFS at
	// /internal/shared/mu-plugins/ and 301s /sitemap.xml to /wp-sitemap.xml.
	// Overwrite with a valid no-op when that VFS file is present. A single-quoted
	// '<?php\n' is a parse error. Drop this overwrite when 4325 lands.
	const seed     = [
		'<?php',
		"require_once '/wordpress/wp-load.php';",
		"update_option( 'permalink_structure', '/%postname%/' );",
		"delete_option( 'rewrite_rules' );",
		"if ( is_file( '/internal/shared/mu-plugins/sitemap-redirect.php' ) )",
		"\tfile_put_contents(",
		"\t\t'/internal/shared/mu-plugins/sitemap-redirect.php',",
		"\t\t'<?php // Workaround: https://github.com/WordPress/wordpress-playground/issues/4325' . chr( 10 ),",
		"\t);",
	].join( '\n' );

	data.preferredVersions = {
		php,
		wp,
	};
	data.login = false;

	const steps = pluginsToActivate( plugin ).map( item => ( {
		step:       'activatePlugin',
		pluginPath: `/wordpress/wp-content/plugins/${item.slug}/${item.mainFile}`,
	} ) );

	if ( themeSlug )
		steps.push( {
			step:            'activateTheme',
			themeFolderName: themeSlug,
		} );

	steps.push( {
		step: 'runPHP',
		code: seed,
	} );

	data.steps = steps;

	fs.writeFileSync( dest, JSON.stringify( data, null, '\t' ) + '\n' );
}

/**
 * Theme folder names mounted via extraMounts. Those trees are consumer-owned.
 *
 * @param {Object} plugin
 * @return {string[]|null} Slugs to keep, or null when extraMounts owns all themes.
 */
function extraThemeKeepSlugs( plugin ) {

	const slugs = [];

	for ( const pair of plugin.extraMounts || [] ) {
		if ( ! Array.isArray( pair ) || 2 !== pair.length )
			continue;

		const vfs = String( pair[1] ).replace( /\\/g, '/' ).replace( /\/+$/, '' );

		if ( '/wordpress/wp-content/themes' === vfs )
			return null;

		const match = /^\/wordpress\/wp-content\/themes\/([^/]+)$/.exec( vfs );

		if ( match && /^[a-z0-9-]+$/.test( match[1] ) )
			slugs.push( match[1] );
	}

	return slugs;
}

/**
 * Playground's Core zip for this --wp slug. Reuses ~/.wordpress-playground.
 *
 * @param {string} wp
 * @return {Promise<{version: string, releaseUrl: string}>}
 */
async function wordpressRelease( wp ) {

	let resolve;

	try {
		( { resolveWordPressRelease: resolve } = require( '@wp-playground/wordpress' ) );
	} catch {
		throw new Error(
			`@wp-playground/wordpress missing in ${ENGINE_ROOT}. Run npm install.`,
		);
	}

	return resolve( wp );
}

/**
 * @param {string} wp
 * @param {{version: string}} details
 * @return {string|null}
 */
function playgroundCachedZip( wp, details ) {

	const home = path.join( os.homedir(), '.wordpress-playground' );
	const names = [ `${details.version}.zip` ];

	if ( wp && ! /^https?:/i.test( wp ) ) {
		const slug = 'nightly' === wp ? 'trunk' : wp;

		if ( slug !== details.version )
			names.push( `${slug}.zip` );
	}

	for ( const name of names ) {
		const file = path.join( home, name );

		if ( fs.existsSync( file ) )
			return file;
	}

	return null;
}

/**
 * @param {string} dir
 * @return {string}
 */
function findWpRoot( dir ) {

	if ( fs.existsSync( path.join( dir, 'wp-load.php' ) ) )
		return dir;

	for ( const name of fs.readdirSync( dir ) ) {
		const nested = path.join( dir, name );

		try {
			if (
				   fs.statSync( nested ).isDirectory()
				&& fs.existsSync( path.join( nested, 'wp-load.php' ) )
			)
				return nested;
		} catch {}
	}

	throw new Error( `Could not find wp-load.php under ${dir}.` );
}

/**
 * @param {string} wpRoot
 * @return {string}
 */
function readDefaultTheme( wpRoot ) {

	const file = path.join( wpRoot, 'wp-includes', 'default-constants.php' );

	if ( ! fs.existsSync( file ) )
		throw new Error( `Missing default-constants.php in ${wpRoot}.` );

	const match = /define\(\s*'WP_DEFAULT_THEME',\s*'([^']+)'/.exec(
		fs.readFileSync( file, 'utf8' ),
	);

	if ( ! match )
		throw new Error( `Could not read WP_DEFAULT_THEME from ${file}.` );

	return match[1];
}

/**
 * Drops bundled Twenty* themes other than WP_DEFAULT_THEME and extraKeep.
 *
 * @param {string}   wpRoot
 * @param {string[]} extraKeep
 */
function stripExtraThemes( wpRoot, extraKeep ) {

	const keep   = new Set( extraKeep );
	const themes = path.join( wpRoot, 'wp-content', 'themes' );

	keep.add( readDefaultTheme( wpRoot ) );

	if ( ! fs.existsSync( themes ) )
		return;

	for ( const name of fs.readdirSync( themes ) ) {
		if ( ! /^twenty[a-z]+$/.test( name ) || keep.has( name ) )
			continue;

		const dir = path.join( themes, name );

		if ( fs.statSync( dir ).isDirectory() )
			fs.rmSync( dir, { recursive: true, force: true } );
	}
}

/**
 * Copies remaining slim-tree themes into the persisted wp-content overlay.
 *
 * @param {string}   wpRoot
 * @param {string}   wpContent
 * @param {string[]} extraKeep
 */
function seedPersistThemes( wpRoot, wpContent, extraKeep ) {

	const srcThemes  = path.join( wpRoot, 'wp-content', 'themes' );
	const destThemes = path.join( wpContent, 'themes' );
	const keep       = new Set( extraKeep );

	keep.add( readDefaultTheme( wpRoot ) );
	fs.mkdirSync( destThemes, { recursive: true } );

	if ( fs.existsSync( srcThemes ) ) {
		for ( const name of fs.readdirSync( srcThemes ) ) {
			const from = path.join( srcThemes, name );

			if ( fs.statSync( from ).isDirectory() )
				hardlinkTree( from, path.join( destThemes, name ) );
		}
	}

	for ( const name of fs.readdirSync( destThemes ) ) {
		if ( ! /^twenty[a-z]+$/.test( name ) || keep.has( name ) )
			continue;

		const dir = path.join( destThemes, name );

		if ( fs.statSync( dir ).isDirectory() )
			fs.rmSync( dir, { recursive: true, force: true } );
	}
}

/**
 * Official Core zip unpacked once, extras stripped. Playground mounts this
 * tree instead of extracting the full zip.
 *
 * @param {string}        cacheRoot
 * @param {string}        wp
 * @param {string[]|null} extraKeep
 * @return {Promise<{wpRoot: string, themeSlug: string}>}
 */
async function ensureSlimWordPress( cacheRoot, wp, extraKeep ) {

	const details  = await wordpressRelease( wp );
	const safe     = details.version.replace( /[^\w.-]+/g, '_' );
	const work     = path.join( cacheRoot, 'cache', 'wp', safe );
	const extract  = path.join( work, 'extract' );
	const stamp    = path.join( work, 'source.json' );
	let   zipPath  = playgroundCachedZip( wp, details );

	if ( ! zipPath ) {
		zipPath = path.join( work, `${safe}.zip` );

		if ( ! fs.existsSync( zipPath ) ) {
			fs.mkdirSync( work, { recursive: true } );
			console.log( `Downloading ${details.releaseUrl}` );
			await downloadFile( details.releaseUrl, zipPath );
		}
	}

	const zipStat = fs.statSync( zipPath );
	const ready   = slimTreeReady( extract, stamp, zipStat, extraKeep );

	if ( ! ready ) {
		fs.rmSync( extract, { recursive: true, force: true } );
		console.log( `Unpacking ${path.basename( zipPath )} (strip extra Twenty* themes).` );
		unzipOnce( zipPath, extract );

		const wpRoot = findWpRoot( extract );

		if ( extraKeep )
			stripExtraThemes( wpRoot, extraKeep );

		fs.writeFileSync(
			stamp,
			JSON.stringify( {
				version: details.version,
				size:    zipStat.size,
				mtimeMs: zipStat.mtimeMs,
				keep:    extraKeep,
			}, null, '\t' ) + '\n',
		);
	}

	const wpRoot    = findWpRoot( extract );
	const themeSlug = extraKeep
		? readDefaultTheme( wpRoot )
		: '';

	return { wpRoot, themeSlug };
}

/**
 * @param {string}        extract
 * @param {string}        stamp
 * @param {fs.Stats}      zipStat
 * @param {string[]|null} extraKeep
 * @return {Boolean}
 */
function slimTreeReady( extract, stamp, zipStat, extraKeep ) {

	if ( ! fs.existsSync( extract ) || ! fs.existsSync( stamp ) )
		return false;

	try {
		const data = JSON.parse( fs.readFileSync( stamp, 'utf8' ) );

		return data.size === zipStat.size
			&& data.mtimeMs === zipStat.mtimeMs
			&& JSON.stringify( data.keep ) === JSON.stringify( extraKeep );
	} catch {
		return false;
	}
}

/**
 * Plugins the blueprint should activate.
 *
 * `activate` defaults to true. Omit all activate steps when none qualify.
 *
 * @param {Object} plugin
 * @return {{slug: string, mainFile: string}[]}
 */
function pluginsToActivate( plugin ) {

	const list = [];

	if ( false !== plugin.activate )
		list.push( {
			slug:     plugin.slug,
			mainFile: plugin.mainFile,
		} );

	for ( const extra of plugin.extraPlugins || [] ) {
		if ( false === extra.activate ) continue;

		list.push( {
			slug:     extra.slug,
			mainFile: extra.mainFile,
		} );
	}

	return list;
}

/**
 * @param {Object} plugin
 * @param {Object} flags
 */
async function launch( plugin, flags ) {

	const root   = flags.root;
	const wp     = flags.wp || DEFAULT_WP;
	const php    = flags.php || DEFAULT_PHP;
	const port   = String( flags.port || DEFAULT_PORT );
	const site   = flags.site || DEFAULT_SITE;
	const source = flags.plugin || 'working';
	const url    = `http://127.0.0.1:${port}`;

	if ( ! root )
		throw new Error( '--root is required.' );

	const existing = readRun( root );

	if (
		   existing
		&& pidAlive( existing.pid )
		&& existing.url === url
		&& existing.wp === wp
		&& existing.php === php
		&& existing.plugin === source
		&& existing.site === site
		&& await isReady( url )
	) {
		console.log( `Playground already running at ${url} (pid ${existing.pid}).` );

		return;
	}

	if ( existing && pidAlive( existing.pid ) )
		throw new Error(
			`Playground already running (pid ${existing.pid}) with different flags. Run stop first.`,
		);

	const wpContent = siteDir( root, site );
	const key       = ensureHarnessKey( root );
	const local     = playgroundDir( root );
	const blueprint = path.join( local, 'blueprint.runtime.json' );
	const logFile   = path.join( local, 'server.log' );

	fs.mkdirSync( wpContent, { recursive: true } );
	fs.mkdirSync( local, { recursive: true } );

	let sourceRoot = plugin.dir
		? path.resolve( root, plugin.dir )
		: root;

	if ( 'wporg' === source )
		sourceRoot = await ensureWporg( root, plugin.wporgSlug, plugin.mainFile );

	const shim  = plugin.shim ? path.resolve( root, plugin.shim ) : '';
	const shims = ( plugin.shims || [] ).map( s => path.resolve( root, s ) );

	const dirMounts = prepareMounts( {
		sourceRoot,
		siteWpContent:  wpContent,
		slug:           plugin.slug,
		mounts:         plugin.mounts,
		engineMuPlugin: path.join( ENGINE_ROOT, 'mu-plugin' ),
		shim,
		shims,
		harnessKey:     key,
		consumerRoot:   root,
		extraPlugins:   plugin.extraPlugins || [],
		extraMounts:    plugin.extraMounts || [],
	} );

	const extraKeep = extraThemeKeepSlugs( plugin );
	const slim      = await ensureSlimWordPress( local, wp, extraKeep );

	if ( extraKeep )
		seedPersistThemes( slim.wpRoot, wpContent, extraKeep );

	writeBlueprint( plugin, wp, php, blueprint, slim.themeSlug );

	const sqlite = path.join( wpContent, 'database', '.ht.sqlite' );
	const mode   = fs.existsSync( sqlite )
		? 'install-from-existing-files-if-needed'
		: 'install-from-existing-files';

	const cli  = resolveCli();
	const args = [
		cli,
		'server',
		`--wp=${wp}`,
		`--php=${php}`,
		`--port=${port}`,
		'--wordpress-install-mode',
		mode,
		'--blueprint',
		blueprint,
		// Slim tree already lacks extra Twenty* themes. Do not use
		// download-and-install: that would unpack the full official zip
		// onto this mount and put them back.
		'--mount-dir-before-install',
		slim.wpRoot,
		'/wordpress',
		'--mount-dir-before-install',
		wpContent,
		'/wordpress/wp-content',
	];

	for ( const [ host, vfs ] of dirMounts ) {
		args.push( '--mount-dir', host, vfs );
	}

	const log = fs.openSync( logFile, 'a' );
	const child = spawn( process.execPath, args, {
		cwd:         ENGINE_ROOT,
		detached:    true,
		stdio:       [ 'ignore', log, log ],
		windowsHide: true,
	} );

	child.unref();

	writeRun( root, {
		pid:    child.pid,
		url,
		wp,
		php,
		plugin: source,
		site,
		port,
		started: new Date().toISOString(),
	} );

	console.log( `Starting Playground at ${url} (pid ${child.pid}).` );
	await waitReady( url, READY_TRIES, child.pid, logFile );
	console.log( `Ready. Admin is ${url}/wp-admin/ (admin / password).` );
}

module.exports = { launch };
