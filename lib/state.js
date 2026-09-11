const crypto = require( 'crypto' );
const fs     = require( 'fs' );
const path   = require( 'path' );

const ENGINE_ROOT = path.resolve( __dirname, '..' );

/**
 * Consumer playground directory.
 *
 * @param {string} root Consumer repo root.
 * @return {string}
 */
function playgroundDir( root ) {
	return path.join( root, '.local', 'playground' );
}

/**
 * Persisted wp-content for a site id.
 *
 * @param {string} root Consumer repo root.
 * @param {string} id   Site id.
 * @return {string}
 */
function siteDir( root, id ) {
	return path.join( playgroundDir( root ), 'sites', id );
}

/**
 * @param {string} root Consumer repo root.
 * @return {string}
 */
function runJsonPath( root ) {
	return path.join( playgroundDir( root ), 'run.json' );
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
		data.paths = [
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
 * @param {string} root Consumer repo root.
 * @return {Object|null}
 */
function readRun( root ) {

	const file = runJsonPath( root );

	if ( ! fs.existsSync( file ) )
		return null;

	return JSON.parse( fs.readFileSync( file, 'utf8' ) );
}

/**
 * @param {string} root Consumer repo root.
 * @param {Object} data Run state.
 */
function writeRun( root, data ) {

	const dir = playgroundDir( root );

	fs.mkdirSync( dir, { recursive: true } );
	fs.writeFileSync(
		runJsonPath( root ),
		JSON.stringify( data, null, '\t' ) + '\n',
	);
}

/**
 * Creates a harness key if missing.
 *
 * @param {string} root Consumer repo root.
 * @return {string}
 */
function ensureHarnessKey( root ) {

	const file = path.join( playgroundDir( root ), 'harness-key.txt' );

	if ( fs.existsSync( file ) )
		return fs.readFileSync( file, 'utf8' ).trim();

	const key = crypto.randomBytes( 24 ).toString( 'hex' );

	fs.mkdirSync( playgroundDir( root ), { recursive: true } );
	fs.writeFileSync( file, key + '\n' );

	return key;
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

module.exports = {
	ENGINE_ROOT,
	ensureHarnessKey,
	loadPluginJson,
	pidAlive,
	playgroundDir,
	readRun,
	runJsonPath,
	siteDir,
	writeRun,
};
