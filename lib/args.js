/**
 * Parses argv into flags and positionals.
 *
 * @param {string[]} argv process.argv slice after the command.
 * @return {{flags: Object<string, string|true>, rest: string[]}}
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
			flags[ token.slice( 2, eq ) ] = token.slice( eq + 1 );
			continue;
		}

		const key  = token.slice( 2 );
		const next = argv[ i + 1 ];

		if ( next && ! next.startsWith( '--' ) ) {
			flags[ key ] = next;
			i++;
			continue;
		}

		flags[ key ] = true;
	}

	return { flags, rest };
}

module.exports = { parseArgs };
