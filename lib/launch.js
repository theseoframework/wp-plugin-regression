const { spawn } = require( 'child_process' );
const fs    = require( 'fs' );
const http  = require( 'http' );
const https = require( 'https' );
const net   = require( 'net' );
const os    = require( 'os' );
const path  = require( 'path' );

const { mergeExtraPlugins } = require( './extra-plugins' );
const { hardlinkTree, prepareMounts, pluginSourceRoot } = require( './mounts' );
const { unzipOnce } = require( './unzip' );
const {
	ENGINE_ROOT,
	ensureHarnessKey,
	pidAlive,
	readRun,
	readRuns,
	readRunsForRoot,
	safeVersion,
	siteDir,
	slimWorkDir,
	upsertRun,
	wporgCacheDir,
} = require( './state' );

const DEFAULT_WP   = 'latest';
const DEFAULT_PHP  = '8.3';
const DEFAULT_SITE = 'default';
const PORT_FIRST   = 9001;
const PORT_LAST    = 9099;
const READY_MS     = 2000;
const READY_TRIES  = 90;
const CLI_READY    = 'Ready! WordPress is running';

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
 * Playground writes opcache.max_accelerated_files=1000 in initializeRuntime
 * when /internal/shared/php.ini is missing. That cap is PHP_INI_SYSTEM and
 * large plugin trees overflow it. --php-extension stages lib/php-ini/php.ini
 * during preRun so initializeRuntime skips the default and php_wasm_init
 * reads the operator OPcache list. JIT stays off (PHP-WASM has no backend).
 *
 * @param {string} php
 * @return {string[]}
 */
function opcacheExtensionArgs( php ) {

	const manifest = path.join( ENGINE_ROOT, 'lib', 'php-ini', 'manifest.json' );

	if ( ! fs.existsSync( manifest ) )
		return [];

	try {
		const data = JSON.parse( fs.readFileSync( manifest, 'utf8' ) );
		const ok   = ( data.artifacts || [] ).some(
			item => item.phpVersion === php,
		);

		if ( ! ok )
			return [];
	} catch {
		return [];
	}

	return [ '--php-extension', manifest ];
}

/**
 * Playground --workers. Their unset default is min(6, cpus-1) and
 * auto is cpus-1. Both can drop below 6, which they warn deadlocks
 * on file locks. Default here is max(6, cpus-1).
 *
 * @param {Object} flags
 * @return {string[]}
 */
function workerArgs( flags ) {

	const auto = Math.max( 6, os.cpus().length - 1 );
	const raw  = flags.workers;

	if ( undefined === raw || true === raw || 'auto' === String( raw ) )
		return [ `--workers=${auto}` ];

	if ( ! /^\d+$/.test( String( raw ) ) || Number( raw ) < 1 )
		throw new Error( '--workers must be a positive integer or auto.' );

	return [ `--workers=${raw}` ];
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

	return 'Playground process exited. See the site server.log under ~/.wordpress-playground/tests/.';
}

/**
 * @param {string} [logFile]
 * @param {string} needle
 * @return {Boolean}
 */
function logIncludes( logFile, needle ) {

	if ( ! logFile ) return false;

	try {
		return fs.readFileSync( logFile, 'utf8' ).includes( needle );
	} catch {
		return false;
	}
}

/**
 * Waits until the Playground CLI finishes the blueprint. HTTP can answer
 * during install-from-existing-files before activatePlugin runs.
 *
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

		if ( logIncludes( logFile, 'Error when executing the blueprint' ) )
			throw new Error( exitReason( logFile ) );

		if ( logIncludes( logFile, CLI_READY ) && await isReady( url ) )
			return;

		await new Promise( r => setTimeout( r, READY_MS ) );
	}

	throw new Error( `Playground did not become ready at ${url}.` );
}

/**
 * @param {string} port
 * @return {Object|undefined}
 */
function liveRunOnPort( port ) {
	return readRuns().find(
		run => pidAlive( run.pid ) && String( run.port ) === String( port ),
	);
}

/**
 * @param {string} port
 * @return {Promise<Boolean>}
 */
function tcpInUse( port ) {
	return new Promise( resolve => {

		const server = net.createServer();

		server.once( 'error', () => resolve( true ) );
		server.once( 'listening', () => {
			server.close( () => resolve( false ) );
		} );
		server.listen( Number( port ), '127.0.0.1' );
	} );
}

/**
 * A live run for the same consumer + site is reuse, not blocked.
 *
 * @param {string} port
 * @param {string} root
 * @param {string} site
 * @return {Promise<Boolean>}
 */
async function portBlocked( port, root, site ) {

	const run = liveRunOnPort( port );

	if ( run ) {
		return ! (
			run.root
			&& path.resolve( run.root ) === path.resolve( root )
			&& run.site === site
		);
	}

	return tcpInUse( port );
}

/**
 * @param {string} root
 * @param {string} site
 * @return {Object|undefined}
 */
function liveRunForSite( root, site ) {

	if ( ! root )
		return undefined;

	return readRunsForRoot( root )
		.filter( run => pidAlive( run.pid ) )
		.find( run => run.site === site );
}

/**
 * Next consecutive free ports in 9001–9099. One pool for every consumer.
 *
 * @param {string}   root
 * @param {string[]} sites
 * @return {Promise<string[]>}
 */
async function nextFreePorts( root, sites ) {

	const need = sites.length;

	for ( let n = PORT_FIRST; n + need - 1 <= PORT_LAST; n++ ) {
		const ports = [];
		let   ok    = true;

		for ( let i = 0; i < need; i++ ) {
			const port = String( n + i );

			if ( await portBlocked( port, root, sites[ i ] ) ) {
				ok = false;
				break;
			}

			ports.push( port );
		}

		if ( ok )
			return ports;
	}

	throw new Error(
		`No free ports in ${PORT_FIRST}–${PORT_LAST} for ${need} site(s).`,
	);
}

/**
 * @param {Object} flags
 * @return {Promise<string>}
 */
async function resolveListenPort( flags ) {

	if ( flags.port )
		return String( flags.port );

	const site = flags.site || DEFAULT_SITE;
	const live = liveRunForSite( flags.root, site );

	if ( live )
		return String( live.port );

	const [ port ] = await nextFreePorts( flags.root, [ site ] );

	if ( port !== String( PORT_FIRST ) )
		console.log( `Port ${PORT_FIRST} in use. Using ${port}.` );

	return port;
}

/**
 * Next two consecutive free ports. Same pool as a single launch.
 *
 * @param {Object} flags
 * @return {Promise<{before: string, after: string}>}
 */
async function resolvePairPorts( flags ) {

	const root       = flags.root;
	const siteBefore = flags['site-before'] || 'before';
	const siteAfter  = flags['site-after'] || 'after';

	if ( flags['port-before'] || flags['port-after'] )
		return {
			before: String( flags['port-before'] || PORT_FIRST ),
			after:  String( flags['port-after'] || PORT_FIRST + 1 ),
		};

	const before = liveRunForSite( root, siteBefore );
	const after  = liveRunForSite( root, siteAfter );

	if ( before && after )
		return {
			before: String( before.port ),
			after:  String( after.port ),
		};

	const ports = await nextFreePorts( root, [ siteBefore, siteAfter ] );

	if ( ports[0] !== String( PORT_FIRST ) )
		console.log( `Using ${ports[0]}/${ports[1]}.` );

	return {
		before: ports[0],
		after:  ports[1],
	};
}

/**
 * plugin.json `name`, else Plugin Name header, else slug.
 *
 * @param {Object} plugin
 * @param {string} sourceRoot Working-tree plugin root.
 * @return {string}
 */
function pluginDisplayName( plugin, sourceRoot ) {

	if ( plugin.name && String( plugin.name ).trim() )
		return String( plugin.name ).trim();

	try {
		const head  = fs.readFileSync(
			path.join( sourceRoot, plugin.mainFile ),
			'utf8',
		).slice( 0, 16 * 1024 );
		const match = /^[ \t\/*#@]*Plugin Name:\s*(.+)$/im.exec( head );

		if ( match && match[1].trim() )
			return match[1].trim();
	} catch {}

	return plugin.slug;
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
 * @param {string} pluginSlug plugin.json slug (tests folder).
 * @param {string} wporgSlug
 * @param {string} mainFile
 * @return {Promise<string>}
 */
async function ensureWporg( pluginSlug, wporgSlug, mainFile ) {

	const cache = path.join( wporgCacheDir( pluginSlug ), wporgSlug );
	const zip   = path.join( wporgCacheDir( pluginSlug ), `${wporgSlug}.zip` );

	try {
		return pluginSourceRoot( cache, wporgSlug, mainFile );
	} catch {}

	fs.mkdirSync( path.dirname( zip ), { recursive: true } );

	if ( ! fs.existsSync( zip ) ) {
		const url = `https://downloads.wordpress.org/plugin/${wporgSlug}.latest-stable.zip`;
		console.log( `Downloading ${url}` );
		await downloadFile( url, zip );
	}

	unzipOnce( zip, cache );

	return pluginSourceRoot( cache, wporgSlug, mainFile );
}

/**
 * @param {Object} plugin
 * @param {string} wp
 * @param {string} php
 * @param {string} dest
 * @param {string} [themeSlug]
 * @param {string} siteTitle Default blogname. Agents may change it later.
 */
function writeBlueprint( plugin, wp, php, dest, themeSlug, siteTitle ) {

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

	// Playground's default is "My WordPress Site". Agents may change
	// blogname after launch (title tests, fixtures, etc.).
	if ( siteTitle )
		steps.push( {
			step:    'setSiteOptions',
			options: {
				blogname: siteTitle,
			},
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
 * @param {string}        wp
 * @param {string[]|null} extraKeep
 * @return {Promise<{wpRoot: string, themeSlug: string, version: string}>}
 */
async function ensureSlimWordPress( wp, extraKeep ) {

	const details  = await wordpressRelease( wp );
	const work     = slimWorkDir( details.version, extraKeep );
	const extract  = path.join( work, 'extract' );
	const stamp    = path.join( work, 'source.json' );
	let   zipPath  = playgroundCachedZip( wp, details );

	if ( ! zipPath ) {
		zipPath = path.join( work, `${safeVersion( details.version )}.zip` );

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

	return {
		wpRoot,
		themeSlug,
		version: details.version,
	};
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

	if ( true === flags.pair ) {
		const ports = await resolvePairPorts( flags );

		await launch( plugin, {
			...flags,
			pair:    undefined,
			plugin:  'wporg',
			port:    ports.before,
			site:    flags['site-before'] || 'before',
			keep:    flags.keep,
		} );
		await launch( plugin, {
			...flags,
			pair:    undefined,
			plugin:  'working',
			port:    ports.after,
			site:    flags['site-after'] || 'after',
			keep:    flags.keep,
		} );

		return;
	}

	if ( ! flags.root )
		throw new Error( '--root is required.' );

	const root   = flags.root;
	const wp     = flags.wp || DEFAULT_WP;
	const php    = flags.php || DEFAULT_PHP;
	const port   = await resolveListenPort( flags );
	const site   = flags.site || DEFAULT_SITE;
	const source = flags.plugin || 'working';
	const url    = `http://127.0.0.1:${port}`;

	const existing = readRun( root, { port } );

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
			`Port ${port} is already in use (pid ${existing.pid}). Run stop --port=${port} first.`,
		);

	const taken = readRuns().find(
		run => pidAlive( run.pid ) && String( run.port ) === port,
	);

	if ( taken )
		throw new Error(
			`Port ${port} is already in use (pid ${taken.pid}).`,
		);

	const extraKeep = extraThemeKeepSlugs( plugin );
	const slim      = await ensureSlimWordPress( wp, extraKeep );
	const wpContent = siteDir( plugin.slug, slim.version, site );
	const key       = ensureHarnessKey( plugin.slug );
	const blueprint = path.join( wpContent, 'blueprint.json' );
	const logFile   = path.join( wpContent, 'server.log' );

	if ( ! flags.keep && fs.existsSync( wpContent ) ) {
		console.log( `Wiping ${wpContent}` );
		fs.rmSync( wpContent, { recursive: true, force: true } );
	}

	fs.mkdirSync( wpContent, { recursive: true } );

	let sourceRoot = plugin.dir
		? path.resolve( root, plugin.dir )
		: root;

	const nameRoot = sourceRoot;

	if ( 'wporg' === source )
		sourceRoot = await ensureWporg(
			plugin.slug,
			plugin.wporgSlug,
			plugin.mainFile,
		);

	const shim  = plugin.shim ? path.resolve( root, plugin.shim ) : '';
	const shims = ( plugin.shims || [] ).map( s => path.resolve( root, s ) );
	const extraPlugins = mergeExtraPlugins( plugin, flags, root );

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
		extraPlugins,
		extraMounts:    plugin.extraMounts || [],
	} );

	if ( extraKeep )
		seedPersistThemes( slim.wpRoot, wpContent, extraKeep );

	writeBlueprint(
		{ ...plugin, extraPlugins },
		wp,
		php,
		blueprint,
		slim.themeSlug,
		`${pluginDisplayName( plugin, nameRoot )} Playground`,
	);

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
		...opcacheExtensionArgs( php ),
		...workerArgs( flags ),
	];

	// After-install --mount-dir is too late for keep-mode seed runPHP.
	// cwd-relative require_once then misses files that live only on the mount.
	for ( const [ host, vfs ] of dirMounts ) {
		args.push( '--mount-dir-before-install', host, vfs );
	}

	const log = fs.openSync( logFile, 'a' );
	const child = spawn( process.execPath, args, {
		cwd:         ENGINE_ROOT,
		detached:    true,
		stdio:       [ 'ignore', log, log ],
		windowsHide: true,
	} );

	child.unref();

	upsertRun( {
		pid:       child.pid,
		url,
		wp,
		wpVersion: slim.version,
		php,
		plugin:    source,
		slug:      plugin.slug,
		site,
		port,
		root:      path.resolve( root ),
		started:   new Date().toISOString(),
	} );

	console.log( `Starting Playground at ${url} (pid ${child.pid}).` );
	await waitReady( url, READY_TRIES, child.pid, logFile );
	console.log( `Ready. Admin is ${url}/wp-admin/ (admin / password).` );
}

module.exports = { launch };
