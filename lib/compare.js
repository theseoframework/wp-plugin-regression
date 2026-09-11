const fs   = require( 'fs' );
const path = require( 'path' );

const { playgroundDir, readRun } = require( './state' );

/**
 * @param {string} text
 * @param {string} origin
 * @param {string[]} [strips] Regex sources applied after origin rewrite.
 * @return {string}
 */
function normalize( text, origin, strips ) {

	let out = String( text ?? '' );

	if ( origin )
		out = out.split( origin ).join( '{{origin}}' );

	out = out.replace(
		/<meta\s+name=["']generator["']\s+content=["']WordPress[^"']*["'][^>]*>/gi,
		'',
	);

	if ( ! Array.isArray( strips ) )
		return out;

	for ( const pattern of strips )
		out = out.replace( new RegExp( pattern, 'g' ), '' );

	return out;
}

/**
 * @param {string} a
 * @param {string} b
 * @return {string}
 */
function lineDiff( a, b ) {

	const left  = a.split( /\r?\n/ );
	const right = b.split( /\r?\n/ );
	const max   = Math.max( left.length, right.length );
	const lines = [];

	for ( let i = 0; i < max; i++ ) {
		if ( left[ i ] === right[ i ] )
			continue;

		if ( undefined !== left[ i ] )
			lines.push( `- ${left[ i ]}` );

		if ( undefined !== right[ i ] )
			lines.push( `+ ${right[ i ]}` );
	}

	return lines.join( '\n' );
}

/**
 * @param {Object} plugin
 * @param {Object} flags
 */
function compare( plugin, flags ) {

	const root   = flags.root;
	const before = flags.before;
	const after  = flags.after;

	if ( ! root )
		throw new Error( '--root is required.' );

	if ( ! before || ! after )
		throw new Error( '--before and --after are required.' );

	const run    = readRun( root );
	const origin = run && run.url ? run.url : '';
	const dirA   = path.join( playgroundDir( root ), 'captures', before );
	const dirB   = path.join( playgroundDir( root ), 'captures', after );

	if ( ! fs.existsSync( dirA ) )
		throw new Error( `Missing capture ${dirA}.` );

	if ( ! fs.existsSync( dirB ) )
		throw new Error( `Missing capture ${dirB}.` );

	const files = [ ...new Set( [
		...fs.readdirSync( dirA ).filter( f => f.endsWith( '.json' ) ),
		...fs.readdirSync( dirB ).filter( f => f.endsWith( '.json' ) ),
	] ) ].sort();

	let failed  = false;
	let changed = 0;

	for ( const file of files ) {
		const pathA = path.join( dirA, file );
		const pathB = path.join( dirB, file );

		if ( ! fs.existsSync( pathA ) || ! fs.existsSync( pathB ) ) {
			console.log( `ONLY ${file}` );
			failed = true;
			continue;
		}

		const a = JSON.parse( fs.readFileSync( pathA, 'utf8' ) );
		const b = JSON.parse( fs.readFileSync( pathB, 'utf8' ) );

		if ( a.status >= 500 || b.status >= 500 ) {
			console.log( `FAIL ${file} status ${a.status} -> ${b.status}` );
			failed = true;
			continue;
		}

		if ( plugin.headMarkers && ( null === a.extracted || null === b.extracted ) ) {
			console.log( `FAIL ${file} missing head markers` );
			failed = true;
			continue;
		}

		const left  = normalize( a.extracted, origin, plugin.strips );
		const right = normalize( b.extracted, origin, plugin.strips );

		if ( left === right )
			continue;

		changed++;
		console.log( `DIFF ${file}` );
		console.log( lineDiff( left, right ) );
	}

	if ( failed )
		throw new Error( 'Compare failed.' );

	console.log( changed ? `${changed} artifact(s) differ.` : 'No artifact diffs.' );
}

module.exports = { compare, normalize };
