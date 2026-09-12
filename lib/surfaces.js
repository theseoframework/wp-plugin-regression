/**
 * Resolves capture entries from plugin.json and --feature / --types.
 *
 * @param {Object} plugin
 * @param {Object} flags
 * @return {Object[]}
 */
function selectedEntries( plugin, flags ) {

	const all = Array.isArray( plugin.entries ) && plugin.entries.length
		? plugin.entries
		: ( plugin.paths || [] ).map( p => ( {
			id:   pathToId( p ),
			type: 'path',
			path: p,
		} ) );

	let types = null;

	if ( flags.feature ) {
		const mapped = plugin.surfaces && plugin.surfaces[ flags.feature ];

		if ( ! Array.isArray( mapped ) )
			throw new Error( `Unknown feature ${flags.feature}.` );

		types = new Set( mapped );
	}

	if ( flags.types ) {
		const extra = String( flags.types )
			.split( ',' )
			.map( s => s.trim() )
			.filter( Boolean );

		types = types
			? new Set( extra.filter( t => types.has( t ) ) )
			: new Set( extra );
	}

	if ( ! types )
		return [ ...all ];

	return all.filter( e => types.has( e.type ) );
}

/**
 * @param {string} p
 * @return {string}
 */
function pathToId( p ) {

	if ( '/' === p )
		return 'home';

	return p.replace( /^\//, '' ).replace( /[/?&=]/g, '_' ).replace( /_+$/, '' ) || 'home';
}

/**
 * Prints one feature or filter and the entries it selects.
 *
 * @param {Object} plugin
 * @param {Object} flags
 */
function printSelection( plugin, flags ) {

	const entries = selectedEntries( plugin, flags );
	const label   = flags.feature || flags.types || 'all';
	const types   = [ ...new Set( entries.map( e => e.type ) ) ];

	console.log( `${label}: ${types.join( ', ' )}` );

	for ( const entry of entries ) {
		const frame = entry.frame ? ` [${entry.frame}]` : '';

		console.log( `  ${entry.id} ${entry.path}${frame}` );
	}
}

/**
 * Prints feature → entry lines.
 *
 * @param {Object} plugin
 */
function printSurfaces( plugin ) {

	const surfaces = plugin.surfaces || {};
	const keys     = Object.keys( surfaces ).sort();

	if ( ! keys.length ) {
		console.log( 'No surfaces in plugin.json.' );

		return;
	}

	for ( const key of keys ) {
		printSelection( plugin, { feature: key } );
		console.log( '' );
	}
}

module.exports = {
	pathToId,
	printSelection,
	printSurfaces,
	selectedEntries,
};
