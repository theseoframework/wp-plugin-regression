const fs   = require( 'fs' );
const path = require( 'path' );

const { harnessKeyPath, readRun } = require( './state' );

/**
 * POSTs a harness action.
 *
 * @param {string}  root
 * @param {Object}  body
 * @param {Boolean} [quiet]
 * @return {Promise<{ok: Boolean, status: number, data: Object, text: string}>}
 */
async function postHarness( root, body, quiet, port ) {

	const run = readRun( root, { port } );

	if ( ! run || ! run.url )
		throw new Error( 'Playground is not running. Launch first.' );

	const keyFile = harnessKeyPath( run.slug );

	if ( ! fs.existsSync( keyFile ) )
		throw new Error( 'Missing harness key. Launch first.' );

	const key = fs.readFileSync( keyFile, 'utf8' ).trim();
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
	let data   = {};

	try {
		data = JSON.parse( text );
	} catch {
		data = { error: text };
	}

	if ( ! quiet )
		console.log( text );

	return {
		ok:     res.ok,
		status: res.status,
		data,
		text,
	};
}

/**
 * @param {Object} flags
 * @param {string[]} rest Extra JSON tokens.
 */
async function harness( flags, rest ) {

	const root = flags.root;

	if ( ! root )
		throw new Error( '--root is required.' );

	let body = {};

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

	const out = await postHarness( root, body, false, flags.port );

	if ( ! out.ok )
		throw new Error( `Harness HTTP ${out.status}.` );
}

module.exports = {
	harness,
	postHarness,
};
