const fs   = require( 'fs' );
const path = require( 'path' );

/**
 * Hardlinks a directory tree onto dest. Files stay live via inode.
 *
 * @param {string} src
 * @param {string} dest
 */
function hardlinkTree( src, dest ) {

	fs.mkdirSync( dest, { recursive: true } );

	for ( const name of fs.readdirSync( src ) ) {
		if ( '.' === name || '..' === name || '.git' === name )
			continue;

		const from = path.join( src, name );
		const to   = path.join( dest, name );

		if ( fs.statSync( from ).isDirectory() ) {
			hardlinkTree( from, to );
			continue;
		}

		ensureHardlink( from, to );
	}
}

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
 * Mounts one plugin tree: directory --mount-dir pairs and file hardlinks.
 *
 * @param {string}   sourceRoot     Plugin files on disk.
 * @param {string}   siteWpContent  Persisted wp-content.
 * @param {string}   slug
 * @param {string[]} mounts         Relative files and directories.
 * @return {string[][]} Pairs of [host, vfs].
 */
function mountPluginTree( sourceRoot, siteWpContent, slug, mounts ) {

	const pairs       = [];
	const pluginVfs   = `/wordpress/wp-content/plugins/${slug}`;
	const persistPlug = path.join( siteWpContent, 'plugins', slug );

	fs.mkdirSync( persistPlug, { recursive: true } );

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

	return pairs;
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
 * @param {string} [opts.consumerRoot] Consumer repo root. Used for extraPlugins.dir and extraMounts.
 * @param {Object[]} [opts.extraPlugins] More { slug, dir, mainFile, mounts } entries.
 * @param {string[][]} [opts.extraMounts] [ hostRel, vfs ] pairs resolved from consumerRoot.
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
	consumerRoot,
	extraPlugins,
	extraMounts,
} ) {

	const persistMu = path.join( siteWpContent, 'mu-plugins' );

	fs.mkdirSync( persistMu, { recursive: true } );
	fs.mkdirSync( path.join( siteWpContent, 'uploads' ), { recursive: true } );

	const pairs = mountPluginTree(
		sourceRoot,
		siteWpContent,
		slug,
		mounts,
	);

	const extras = Array.isArray( extraPlugins ) ? extraPlugins : [];

	for ( const extra of extras ) {
		if ( ! extra.slug || ! extra.mainFile || ! Array.isArray( extra.mounts ) )
			throw new Error(
				'extraPlugins entries need slug, mainFile, and mounts.',
			);

		const extraRoot = extra.dir && consumerRoot
			? path.resolve( consumerRoot, extra.dir )
			: sourceRoot;

		pairs.push(
			...mountPluginTree(
				extraRoot,
				siteWpContent,
				extra.slug,
				extra.mounts,
			),
		);
	}

	const mountsExtra = Array.isArray( extraMounts ) ? extraMounts : [];

	for ( const pair of mountsExtra ) {
		if ( ! Array.isArray( pair ) || 2 !== pair.length )
			throw new Error( 'extraMounts entries must be [ hostRel, vfs ].' );

		const hostRel = pair[0];
		const vfs     = pair[1];

		if ( ! consumerRoot )
			throw new Error( 'extraMounts requires the consumer --root.' );

		const host = path.resolve( consumerRoot, hostRel );

		if ( ! fs.existsSync( host ) )
			throw new Error( `extraMounts source missing: ${host}.` );

		if ( ! fs.statSync( host ).isDirectory() )
			throw new Error( `extraMounts source must be a directory: ${host}.` );

		const vfsNorm = vfs.replace( /\\/g, '/' );
		const prefix  = '/wordpress/wp-content/';

		if ( vfsNorm.startsWith( prefix ) ) {
			const rel = vfsNorm.slice( prefix.length );

			hardlinkTree(
				host,
				path.join( siteWpContent, ...rel.split( '/' ) ),
			);
		}

		pairs.push( [ host, vfsNorm ] );
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
	hardlinkTree,
	mountPluginTree,
	pluginSourceRoot,
	prepareMounts,
};
