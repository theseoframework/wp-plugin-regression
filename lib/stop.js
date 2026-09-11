const { spawnSync } = require( 'child_process' );
const fs   = require( 'fs' );
const path = require( 'path' );

const { pidAlive, readRun, runJsonPath, siteDir } = require( './state' );

const WAIT_MS    = 250;
const WAIT_TRIES = 40;

/**
 * @param {number} ms
 */
function sleep( ms ) {
	Atomics.wait( new Int32Array( new SharedArrayBuffer( 4 ) ), 0, 0, ms );
}

/**
 * @param {Function} test
 * @param {number}   tries
 * @return {Boolean}
 */
function waitUntil( test, tries ) {

	for ( let i = 0; i < tries; i++ ) {
		if ( test() )
			return true;

		sleep( WAIT_MS );
	}

	return test();
}

/**
 * @param {string} file
 * @return {Boolean}
 */
function sqliteIdle( file ) {

	if ( ! fs.existsSync( file ) )
		return true;

	try {
		fs.closeSync( fs.openSync( file, 'r+' ) );

		return true;
	} catch {
		return false;
	}
}

/**
 * @param {number}  pid
 * @param {Boolean} force
 */
function killWindowsTree( pid, force ) {

	const args = [ '/PID', String( pid ), '/T' ];

	if ( force )
		args.push( '/F' );

	spawnSync( 'taskkill', args, { stdio: 'ignore' } );
}

/**
 * @param {Object} flags
 */
function stop( flags ) {

	const root = flags.root;

	if ( ! root )
		throw new Error( '--root is required.' );

	const run = readRun( root );

	if ( ! run || ! run.pid ) {
		console.log( 'No running Playground.' );

		return;
	}

	const sqlite = path.join(
		siteDir( root, run.site || 'default' ),
		'database',
		'.ht.sqlite',
	);

	if ( pidAlive( run.pid ) ) {
		if ( 'win32' === process.platform ) {
			killWindowsTree( run.pid, false );
			waitUntil( () => ! pidAlive( run.pid ), WAIT_TRIES );

			if ( pidAlive( run.pid ) )
				killWindowsTree( run.pid, true );
		} else {
			try {
				process.kill( run.pid, 'SIGTERM' );
			} catch {}
		}

		waitUntil( () => ! pidAlive( run.pid ), WAIT_TRIES );

		if ( 'win32' !== process.platform && pidAlive( run.pid ) ) {
			try {
				process.kill( run.pid, 'SIGKILL' );
			} catch {}

			waitUntil( () => ! pidAlive( run.pid ), WAIT_TRIES );
		}
	}

	if ( ! waitUntil( () => sqliteIdle( sqlite ), WAIT_TRIES ) )
		throw new Error(
			`SQLite still locked at ${sqlite}. Retry stop, or launch --site with a new id.`,
		);

	const file = runJsonPath( root );

	if ( fs.existsSync( file ) )
		fs.unlinkSync( file );

	console.log( `Stopped pid ${run.pid}.` );
}

module.exports = { stop };
