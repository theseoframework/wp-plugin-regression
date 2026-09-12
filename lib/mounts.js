const fs   = require( 'fs' );
const path = require( 'path' );

/**
 * Hardlink src onto dest. Same volume required. Does not copy.
 *
 * @param {string} src
 * @param {string} dest
 */
function ensureHardlink( src, dest ) {

	if ( ! fs.existsSync( src ) )
		throw new Error( `Missing mount source ${src}.` );

	fs.mkdirSync( path.dirname( dest ), { recursive: true } );

	if ( fs.existsSync( dest ) ) {
		const from = fs.statSync( src );
		const to   = fs.statSync( dest );

		if ( from.ino === to.ino && from.dev === to.dev )
			return;

		fs.unlinkSync( dest );
	}

	try {
		fs.linkSync( src, dest );
	} catch ( err ) {
		throw new Error(
			`Could not hardlink ${src} -> ${dest}: ${err.message}. Same volume required.`,
		);
	}
}

/**
 * Resolves the folder that contains mainFile after a wordpress.org unzip.
 *
 * @param {string} extractDir
 * @param {string} slug
 * @param {string} mainFile
 * @return {string}
 */
function pluginSourceRoot( extractDir, slug, mainFile ) {

	if ( fs.existsSync( path.join( extractDir, mainFile ) ) )
		return extractDir;

	const nested = path.join( extractDir, slug );

	if ( fs.existsSync( path.join( nested, mainFile ) ) )
		return nested;

	throw new Error( `Could not find ${mainFile} under ${extractDir}.` );
}

/**
 * Builds --mount-dir pairs and hardlinks root files into persisted wp-content.
 *
 * @param {Object} opts
 * @param {string} opts.sourceRoot Plugin files on disk (working tree or wporg extract).
 * @param {string} opts.siteWpContent Persisted wp-content.
 * @param {string} opts.slug
 * @param {string[]} opts.mounts Relative files and directories.
 * @param {string} opts.engineMuPlugin Engine harness directory.
 * @param {string} [opts.shim] Consumer shim php path.
 * @param {string[]} [opts.shims] Extra consumer shim php paths.
 * @param {string} opts.harnessKey
 * @return {string[][]} Pairs of [host, vfs].
 */
function prepareMounts( {
	sourceRoot,
	siteWpContent,
	slug,
	mounts,
	engineMuPlugin,
	shim,
	shims,
	harnessKey,
} ) {

	const pairs      = [];
	const pluginVfs  = `/wordpress/wp-content/plugins/${slug}`;
	const persistPlug = path.join( siteWpContent, 'plugins', slug );
	const persistMu   = path.join( siteWpContent, 'mu-plugins' );

	fs.mkdirSync( persistPlug, { recursive: true } );
	fs.mkdirSync( persistMu, { recursive: true } );
	fs.mkdirSync( path.join( siteWpContent, 'uploads' ), { recursive: true } );

	for ( const rel of mounts ) {
		const host = path.join( sourceRoot, rel );

		if ( ! fs.existsSync( host ) )
			throw new Error( `plugin.json mount missing: ${host}.` );

		if ( fs.statSync( host ).isDirectory() ) {
			pairs.push( [ host, `${pluginVfs}/${rel.replace( /\\/g, '/' )}` ] );
			continue;
		}

		ensureHardlink( host, path.join( persistPlug, rel ) );
	}

	ensureHardlink(
		path.join( engineMuPlugin, 'wp-plugin-regression-harness.php' ),
		path.join( persistMu, 'wp-plugin-regression-harness.php' ),
	);

	fs.writeFileSync(
		path.join( persistMu, 'wp-plugin-regression.key' ),
		harnessKey + '\n',
	);

	const shimList = [];

	if ( shim )
		shimList.push( shim );

	if ( Array.isArray( shims ) )
		shimList.push( ...shims );

	const seenShim = new Set();

	for ( const file of shimList ) {
		if ( seenShim.has( file ) ) continue;

		seenShim.add( file );

		if ( ! fs.existsSync( file ) )
			throw new Error( `Shim missing: ${file}.` );

		ensureHardlink(
			file,
			path.join( persistMu, path.basename( file ) ),
		);
	}

	return pairs;
}

module.exports = {
	ensureHardlink,
	pluginSourceRoot,
	prepareMounts,
};
