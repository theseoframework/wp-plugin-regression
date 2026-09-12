const { readRun } = require( './state' );
const { loadBundle } = require( './capture' );
const { printSelection, selectedEntries } = require( './surfaces' );

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
 * Keeps status/location and feature needles from a record dump.
 *
 * @param {string} text
 * @param {string} [feature]
 * @param {Object} [plugin]
 * @return {string}
 */
function filterRecord( text, feature, plugin ) {

	const matchers = feature
		&& plugin
		&& plugin.surfaceLines
		&& plugin.surfaceLines[ feature ];

	if ( ! Array.isArray( matchers ) || ! matchers.length )
		return text;

	return String( text )
		.split( /\r?\n/ )
		.filter( line => {

			if ( line.startsWith( 'status ' ) )
				return true;

			if ( line.startsWith( 'location ' ) )
				return true;

			if ( line.startsWith( 'x-robots-tag ' ) && 'robots' === feature )
				return true;

			return matchers.some( needle => line.includes( needle ) );
		} )
		.join( '\n' );
}

/**
 * @param {Object} rec
 * @return {string}
 */
function recordText( rec ) {

	if ( ! rec )
		return '';

	const loc    = rec.headers && rec.headers.location ? rec.headers.location : '';
	const robots = rec.headers && rec.headers['x-robots-tag'] ? rec.headers['x-robots-tag'] : '';

	return [
		`status ${rec.status}`,
		loc ? `location ${loc}` : '',
		robots ? `x-robots-tag ${robots}` : '',
		rec.extracted || '',
	].filter( Boolean ).join( '\n' );
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
	const origin = run && run.url ? run.url.replace( /\/$/, '' ) : '';
	const leftB  = loadBundle( root, before );
	const rightB = loadBundle( root, after );

	if ( ! leftB )
		throw new Error( `Missing capture ${before}.` );

	if ( ! rightB )
		throw new Error( `Missing capture ${after}.` );

	const pick   = selectedEntries( plugin, flags );
	const want   = new Set( pick.map( e => e.id ) );
	const filter = flags.feature || flags.types;
	const ids    = [ ...new Set( [
		...Object.keys( leftB.entries || {} ),
		...Object.keys( rightB.entries || {} ),
	] ) ].filter( id => ! filter || want.has( id ) ).sort();

	printSelection( plugin, flags );

	let failed  = false;
	let changed = 0;

	for ( const id of ids ) {
		const a = leftB.entries[ id ];
		const b = rightB.entries[ id ];

		if ( ! a || ! b ) {
			console.log( `ONLY ${id}` );
			failed = true;
			continue;
		}

		if ( a.status >= 500 || b.status >= 500 ) {
			console.log( `FAIL ${id} status ${a.status} -> ${b.status}` );
			failed = true;
			continue;
		}

		if ( plugin.headMarkers && ( null === a.extracted || null === b.extracted ) ) {
			console.log( `FAIL ${id} missing head markers` );
			failed = true;
			continue;
		}

		const left  = filterRecord(
			normalize( recordText( a ), origin, plugin.strips ),
			flags.feature,
			plugin,
		);
		const right = filterRecord(
			normalize( recordText( b ), origin, plugin.strips ),
			flags.feature,
			plugin,
		);

		if ( left === right )
			continue;

		changed++;
		console.log( `DIFF ${id}` );
		console.log( lineDiff( left, right ) );
	}

	if ( failed )
		throw new Error( 'Compare failed.' );

	console.log(
		changed
			? `Compared ${ids.length}, ${changed} differ.`
			: `Compared ${ids.length}, no artifact diffs.`,
	);
}

module.exports = {
	compare,
	normalize,
};
