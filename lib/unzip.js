const { spawnSync } = require( 'child_process' );
const fs            = require( 'fs' );

/**
 * Unzip once. Windows Expand-Archive; elsewhere unzip.
 *
 * @param {string} zipPath
 * @param {string} dest
 */
function unzipOnce( zipPath, dest ) {

	fs.mkdirSync( dest, { recursive: true } );

	let result;

	if ( 'win32' === process.platform ) {
		result = spawnSync(
			'powershell',
			[
				'-NoProfile',
				'-Command',
				`Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${dest}' -Force`,
			],
			{ stdio: 'inherit' },
		);
	} else {
		result = spawnSync(
			'unzip',
			[ '-o', zipPath, '-d', dest ],
			{ stdio: 'inherit' },
		);
	}

	if ( result.status )
		throw new Error( `Unzip failed for ${zipPath}.` );
}

module.exports = { unzipOnce };
