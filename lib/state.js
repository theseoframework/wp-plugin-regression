const crypto = require( 'crypto' );
const fs     = require( 'fs' );
const os     = require( 'os' );
const path   = require( 'path' );

const ENGINE_ROOT = path.resolve( __dirname, '..' );

/**
 * Playground's home. Official zips land here as <version>.zip.
 *
 * @return {string}
 */
function playgroundHome() {
	return path.join( os.homedir(), '.wordpress-playground' );
}

/**
 * Extracted --extra-plugin-zip trees. Same volume as persist. Not the consumer repo.
 *
 * @return {string}
 */
function extraPluginsCacheDir() {
	return path.join( playgroundHome(), 'extra-plugins' );
}

/**
 * Consumer-only files (captures). Not site persist.
 *
 * @param {string} root Consumer repo root.
 * @return {string}
 */
function playgroundDir( root ) {
	return path.join( root, '.local', 'playground' );
}

/**
 * @param {string} version
 * @return {string}
 */
function safeVersion( version ) {
	return String( version ).replace( /[^\w.-]+/g, '_' );
}

/**
 * @param {string} slug plugin.json slug.
 * @return {string}
 */
function testsDir( slug ) {
	return path.join( playgroundHome(), 'tests', slug );
}

/**
 * Slim Core unpack. Same version token as Playground's zip name.
 *
 * @param {string}        wpVersion resolveWordPressRelease().version
 * @param {string[]|null} extraKeep
 * @return {string}
 */
function slimWorkDir( wpVersion, extraKeep ) {

	const safe = safeVersion( wpVersion );

	if ( null === extraKeep )
		return path.join( playgroundHome(), 'wp', `${safe}-full` );

	if ( extraKeep.length )
		return path.join(
			playgroundHome(),
			'wp',
			`${safe}-keep-${extraKeep.join( '-' )}`,
		);

	return path.join( playgroundHome(), 'wp', safe );
}

/**
 * Fresh wp-content persist. Outside the consumer repo.
 *
 * @param {string} slug
 * @param {string} wpVersion
 * @param {string} id
 * @return {string}
 */
function siteDir( slug, wpVersion, id ) {
	return path.join( testsDir( slug ), safeVersion( wpVersion ), id );
}

/**
 * @param {string} slug plugin.json slug (wporg folder name may differ).
 * @return {string}
 */
function wporgCacheDir( slug ) {
	return path.join( testsDir( slug ), 'wporg' );
}

/**
 * @return {string}
 */
function runsPath() {
	return path.join( playgroundHome(), 'tests', 'runs.json' );
}

/**
 * @param {string} file Path to plugin.json.
 * @return {Object}
 */
function loadPluginJson( file ) {

	if ( ! fs.existsSync( file ) )
		throw new Error( `Missing plugin.json at ${file}.` );

	const data = JSON.parse( fs.readFileSync( file, 'utf8' ) );

	if ( ! data.slug || ! data.mainFile || ! Array.isArray( data.mounts ) )
		throw new Error( 'plugin.json needs slug, mainFile, and mounts.' );

	if ( ! data.wporgSlug )
		data.wporgSlug = data.slug;

	if ( ! Array.isArray( data.paths ) ) {
		data.paths = data.entries
			? []
			: [
				'/',
				'/hello-world/',
				'/sample-page/',
				'/robots.txt',
				'/sitemap.xml',
			];
	}

	return data;
}

/**
 * Whether pid is still running.
 *
 * @param {number} pid
 * @return {Boolean}
 */
function pidAlive( pid ) {

	if ( ! pid )
		return false;

	try {
		process.kill( pid, 0 );

		return true;
	} catch {
		return false;
	}
}

/**
 * @return {Object[]}
 */
function readRuns() {

	const file = runsPath();

	if ( ! fs.existsSync( file ) )
		return [];

	try {
		const data = JSON.parse( fs.readFileSync( file, 'utf8' ) );

		return Array.isArray( data ) ? data : [];
	} catch {
		return [];
	}
}

/**
 * @param {Object[]} runs
 */
function writeRuns( runs ) {

	const file = runsPath();

	fs.mkdirSync( path.dirname( file ), { recursive: true } );
	fs.writeFileSync(
		file,
		JSON.stringify( runs, null, '\t' ) + '\n',
	);
}

/**
 * @param {string} root
 * @return {Object[]}
 */
function readRunsForRoot( root ) {

	const resolved = path.resolve( root );

	return readRuns().filter(
		run => run.root && path.resolve( run.root ) === resolved,
	);
}

/**
 * Live run for this consumer. --port or --site when more than one.
 *
 * @param {string} root
 * @param {Object} [pick]
 * @param {string} [pick.port]
 * @param {string} [pick.site]
 * @return {Object|null}
 */
function readRun( root, pick ) {

	const want = pick || {};
	const live = readRunsForRoot( root ).filter( run => pidAlive( run.pid ) );

	if ( want.port ) {
		const match = live.find(
			run => String( run.port ) === String( want.port ),
		);

		return match || null;
	}

	if ( want.site ) {
		const match = live.find( run => run.site === want.site );

		if ( match )
			return match;
	}

	if ( 1 === live.length )
		return live[0];

	if ( ! live.length )
		return null;

	throw new Error(
		'Multiple Playground runs. Pass --port or --site.',
	);
}

/**
 * @param {Object} data
 */
function upsertRun( data ) {

	const runs = readRuns().filter(
		run => String( run.port ) !== String( data.port ),
	);

	runs.push( data );
	writeRuns( runs );
}

/**
 * @param {string} port
 */
function removeRun( port ) {

	writeRuns(
		readRuns().filter( run => String( run.port ) !== String( port ) ),
	);
}

/**
 * @param {string} slug
 * @return {string}
 */
function ensureHarnessKey( slug ) {

	const file = path.join( testsDir( slug ), 'harness-key.txt' );

	if ( fs.existsSync( file ) )
		return fs.readFileSync( file, 'utf8' ).trim();

	const key = crypto.randomBytes( 24 ).toString( 'hex' );

	fs.mkdirSync( path.dirname( file ), { recursive: true } );
	fs.writeFileSync( file, key + '\n' );

	return key;
}

/**
 * @param {string} slug
 * @return {string}
 */
function harnessKeyPath( slug ) {
	return path.join( testsDir( slug ), 'harness-key.txt' );
}

module.exports = {
	ENGINE_ROOT,
	ensureHarnessKey,
	extraPluginsCacheDir,
	harnessKeyPath,
	loadPluginJson,
	pidAlive,
	playgroundDir,
	playgroundHome,
	readRun,
	readRuns,
	readRunsForRoot,
	removeRun,
	safeVersion,
	siteDir,
	slimWorkDir,
	testsDir,
	upsertRun,
	wporgCacheDir,
};
