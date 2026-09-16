/**
 * @param {Object} flags
 * @param {string} key
 * @param {string|true} val
 */
function setFlag( flags, key, val ) {

	if ( ! Object.prototype.hasOwnProperty.call( flags, key ) ) {
		flags[ key ] = val;

		return;
	}

	if ( ! Array.isArray( flags[ key ] ) )
		flags[ key ] = [ flags[ key ] ];

	flags[ key ].push( val );
}

/**
 * Parses argv into flags and positionals.
 *
 * Repeated flags become an array so `--extra-plugin-zip` can stack.
 *
 * @param {string[]} argv process.argv slice after the command.
 * @return {{flags: Object<string, string|true|Array>, rest: string[]}}
 */
function parseArgs( argv ) {

	const flags = {};
	const rest  = [];

	for ( let i = 0; i < argv.length; i++ ) {
		const token = argv[ i ];

		if ( ! token.startsWith( '--' ) ) {
			rest.push( token );
			continue;
		}

		const eq = token.indexOf( '=' );

		if ( -1 !== eq ) {
			setFlag( flags, token.slice( 2, eq ), token.slice( eq + 1 ) );
			continue;
		}

		const key  = token.slice( 2 );
		const next = argv[ i + 1 ];

		if ( next && ! next.startsWith( '--' ) ) {
			setFlag( flags, key, next );
			i++;
			continue;
		}

		setFlag( flags, key, true );
	}

	return { flags, rest };
}

module.exports = { parseArgs };
