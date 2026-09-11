const { spawn, spawnSync } = require( 'child_process' );
const fs    = require( 'fs' );
const http  = require( 'http' );
const https = require( 'https' );
const path  = require( 'path' );

const { prepareMounts, pluginSourceRoot } = require( './mounts' );
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
 */
function writeBlueprint( plugin, wp, php, dest ) {

	const template = path.join( ENGINE_ROOT, 'blueprints', 'vanilla.json' );
	const data     = JSON.parse( fs.readFileSync( template, 'utf8' ) );
	const seed     = [
		'<?php',
		"require_once '/wordpress/wp-load.php';",
		"update_option( 'permalink_structure', '/%postname%/' );",
		"delete_option( 'rewrite_rules' );",
		"if ( is_file( '/internal/shared/mu-plugins/sitemap-redirect.php' ) )",
		"\tfile_put_contents( '/internal/shared/mu-plugins/sitemap-redirect.php', '<?php\\n' );",
	].join( '\n' );

	data.preferredVersions = {
		php,
		wp,
	};
	data.login = false;
	data.steps = [
		{
			step:       'activatePlugin',
			pluginPath: `/wordpress/wp-content/plugins/${plugin.slug}/${plugin.mainFile}`,
		},
		{
			step: 'runPHP',
			code: seed,
		},
	];

	fs.writeFileSync( dest, JSON.stringify( data, null, '\t' ) + '\n' );
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

	let sourceRoot = root;

	if ( 'wporg' === source )
		sourceRoot = await ensureWporg( root, plugin.wporgSlug, plugin.mainFile );

	const shim = plugin.shim ? path.resolve( root, plugin.shim ) : '';

	const dirMounts = prepareMounts( {
		sourceRoot,
		siteWpContent:  wpContent,
		slug:           plugin.slug,
		mounts:         plugin.mounts,
		engineMuPlugin: path.join( ENGINE_ROOT, 'mu-plugin' ),
		shim,
		harnessKey:     key,
	} );

	writeBlueprint( plugin, wp, php, blueprint );

	const sqlite = path.join( wpContent, 'database', '.ht.sqlite' );
	const mode   = fs.existsSync( sqlite )
		? 'install-from-existing-files-if-needed'
		: 'download-and-install';

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
