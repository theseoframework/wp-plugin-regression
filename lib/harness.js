const fs   = require( 'fs' );
const path = require( 'path' );

const { playgroundDir, readRun } = require( './state' );

/**
 * @param {Object} flags
 * @param {string[]} rest Extra JSON tokens.
 */
async function harness( flags, rest ) {

	const root = flags.root;

	if ( ! root )
		throw new Error( '--root is required.' );

	const run = readRun( root );

	if ( ! run || ! run.url )
		throw new Error( 'Playground is not running. Launch first.' );

	const keyFile = path.join( playgroundDir( root ), 'harness-key.txt' );

	if ( ! fs.existsSync( keyFile ) )
		throw new Error( 'Missing harness key. Launch first.' );

	const key = fs.readFileSync( keyFile, 'utf8' ).trim();
	let body  = {};

	if ( flags.action )
		body.action = flags.action;

	if ( flags['json-file'] ) {
		const jsonFile =
			   path.isAbsolute( flags['json-file'] )
			? flags['json-file']
			: path.resolve( root, flags['json-file'] );

		if ( ! fs.existsSync( jsonFile ) )
			throw new Error( `Missing --json-file ${jsonFile}.` );

		body = {
			...body,
			...JSON.parse( fs.readFileSync( jsonFile, 'utf8' ) ),
		};
	}

	if ( flags.json )
		body = { ...body, ...JSON.parse( flags.json ) };

	if ( rest.length )
		body = { ...body, ...JSON.parse( rest.join( ' ' ) ) };

	if ( ! body.action )
		throw new Error( '--action or JSON with action is required.' );

	const url = new URL( '/?wp-plugin-regression=1', run.url );
	const res = await fetch( url, {
		method:  'POST',
		headers: {
			'Content-Type': 'application/json',
			'X-WPR-Key':    key,
		},
		body: JSON.stringify( body ),
	} );
	const text = await res.text();

	console.log( text );

	if ( ! res.ok )
		throw new Error( `Harness HTTP ${res.status}.` );
}

module.exports = { harness };
