/**
 * WordPress Playground regression dispatcher.
 *
 * Usage: node run.js <launch|stop|capture|compare|harness> --root <dir> [flags]
 */

/**
 * WordPress plugin regression via Playground
 * Copyright (C) 2026 Sybre Waaijer, CyberWire B.V. (https://cyberwire.nl/)
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License version 3 as published
 * by the Free Software Foundation.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

const { parseArgs }      = require( './lib/args' );
const { launch }         = require( './lib/launch' );
const { stop }           = require( './lib/stop' );
const { capture }        = require( './lib/capture' );
const { compare }        = require( './lib/compare' );
const { harness }        = require( './lib/harness' );
const { loadPluginJson } = require( './lib/state' );

const USAGE = `Usage: node run.js <command> --root <consumer> [--plugin-json <file>]

Commands: launch, stop, capture, compare, harness
`;

/**
 * Runs one command.
 */
async function main() {

	const argv    = process.argv.slice( 2 );
	const command = argv[0];
	const parsed  = parseArgs( argv.slice( 1 ) );
	const flags   = parsed.flags;

	if ( ! command || command.startsWith( '--' ) ) {
		process.stderr.write( USAGE );
		process.exit( 1 );
	}

	try {
		if (
			   [ 'launch', 'capture', 'compare' ].includes( command )
			&& ! flags['plugin-json']
		) {
			throw new Error( '--plugin-json is required.' );
		}

		switch ( command ) {
			case 'launch':
				await launch( loadPluginJson( flags['plugin-json'] ), flags );
				break;
			case 'stop':
				stop( flags );
				break;
			case 'capture':
				await capture( loadPluginJson( flags['plugin-json'] ), flags );
				break;
			case 'compare':
				compare( loadPluginJson( flags['plugin-json'] ), flags );
				break;
			case 'harness':
				await harness( flags, parsed.rest );
				break;
			default:
				throw new Error( `Unknown command ${command}.` );
		}
	} catch ( err ) {
		process.stderr.write( `${err.message}\n` );
		process.exit( 1 );
	}
}

main();
