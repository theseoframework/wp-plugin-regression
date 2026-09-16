const crypto = require( 'crypto' );
const fs     = require( 'fs' );
const path   = require( 'path' );

const { extraPluginsCacheDir } = require( './state' );
const { pluginSourceRoot }     = require( './mounts' );
const { unzipOnce }            = require( './unzip' );

const SKIP_DIR = new Set( [
	'.git',
	'__MACOSX',
	'node_modules',
	'vendor',
] );

/**
 * @param {string} zipPath
 * @return {string}
 */
function zipCacheKey( zipPath ) {

	const st = fs.statSync( zipPath );

	return crypto
		.createHash( 'sha256' )
		.update( `${path.resolve( zipPath )}\0${st.size}\0${st.mtimeMs}` )
		.digest( 'hex' )
		.slice( 0, 16 );
}

/**
 * @param {string} zipPath
 * @return {string}
 */
function zipHintSlug( zipPath ) {
	return path.basename( zipPath, '.zip' ).replace( /\.\d+(?:\.\d+)*$/, '' );
}

/**
 * @param {string} file
 * @return {string}
 */
function phpPluginName( file ) {

	const head = fs.readFileSync( file, 'utf8' ).slice( 0, 8192 );
	const hit  = head.match( /^[ \t]*(?:\*[ \t]*)?Plugin Name:\s*(.+)$/m );

	return hit ? hit[1].trim() : '';
}

/**
 * @param {string}   dir
 * @param {number}   depth
 * @param {number}   maxDepth
 * @param {string[]} out
 */
function findPluginPhpFiles( dir, depth, maxDepth, out ) {

	if ( depth > maxDepth )
		return;

	let names;

	try {
		names = fs.readdirSync( dir );
	} catch {
		return;
	}

	for ( const name of names ) {
		if ( SKIP_DIR.has( name ) )
			continue;

		const full = path.join( dir, name );
		let st;

		try {
			st = fs.statSync( full );
		} catch {
			continue;
		}

		if ( st.isDirectory() ) {
			findPluginPhpFiles( full, depth + 1, maxDepth, out );
			continue;
		}

		if ( name.endsWith( '.php' ) )
			out.push( full );
	}
}

/**
 * @param {string} pluginRoot
 * @return {string[]}
 */
function listMounts( pluginRoot ) {

	return fs.readdirSync( pluginRoot ).filter( name => {
		if ( '.' === name || '..' === name || '.git' === name || '__MACOSX' === name )
			return false;

		return true;
	} );
}

/**
 * @param {string} extractDir
 * @param {string} hintSlug
 * @param {string} [wantSlug]
 * @param {string} [wantMain]
 * @return {{ slug: string, dir: string, mainFile: string, mounts: string[] }}
 */
function discoverZipPlugin( extractDir, hintSlug, wantSlug, wantMain ) {

	if ( wantSlug && wantMain ) {
		const root = pluginSourceRoot(
			extractDir,
			wantSlug,
			wantMain,
		);

		return {
			slug:     wantSlug,
			dir:      root,
			mainFile: wantMain,
			mounts:   listMounts( root ),
		};
	}

	const files = [];

	findPluginPhpFiles( extractDir, 0, 1, files );

	const named = files.filter( file => phpPluginName( file ) );

	if ( ! named.length )
		throw new Error(
			`No Plugin Name header under ${extractDir}.`,
		);

	let main = named.find( file => {
		const folder = path.basename( path.dirname( file ) );

		return folder === hintSlug || path.basename( file ) === `${hintSlug}.php`;
	} );

	if ( ! main && 1 === named.length )
		main = named[0];

	if ( ! main )
		throw new Error(
			`Ambiguous plugin zip under ${extractDir}: ${named.join( ', ' )}.`,
		);

	const dir  = path.dirname( main );
	const slug = path.basename( dir ) === path.basename( extractDir )
		? hintSlug || path.basename( dir )
		: path.basename( dir );

	return {
		slug,
		dir,
		mainFile: path.basename( main ),
		mounts:   listMounts( dir ),
	};
}

/**
 * Extracts a plugin zip into ~/.wordpress-playground/extra-plugins.
 *
 * @param {string} zipPath
 * @param {{ slug?: string, mainFile?: string }} [want]
 * @return {{ slug: string, dir: string, mainFile: string, mounts: string[] }}
 */
function ensureZipPlugin( zipPath, want ) {

	if ( ! fs.existsSync( zipPath ) )
		throw new Error( `Plugin zip missing: ${zipPath}.` );

	const key   = zipCacheKey( zipPath );
	const cache = path.join( extraPluginsCacheDir(), key );
	const tree  = path.join( cache, 'tree' );
	const meta  = path.join( cache, '.wpr.json' );

	if ( fs.existsSync( meta ) ) {
		const saved = JSON.parse( fs.readFileSync( meta, 'utf8' ) );

		return {
			slug:     saved.slug,
			dir:      path.join( cache, saved.rel ),
			mainFile: saved.mainFile,
			mounts:   saved.mounts,
		};
	}

	if ( ! fs.existsSync( tree ) ) {
		console.log( `Extracting ${zipPath}` );
		unzipOnce( zipPath, tree );
	}

	const found = discoverZipPlugin(
		tree,
		zipHintSlug( zipPath ),
		want && want.slug,
		want && want.mainFile,
	);

	fs.mkdirSync( cache, { recursive: true } );
	fs.writeFileSync(
		meta,
		JSON.stringify(
			{
				slug:     found.slug,
				mainFile: found.mainFile,
				rel:      path.relative( cache, found.dir ),
				mounts:   found.mounts,
			},
			null,
			'\t',
		) + '\n',
	);

	return found;
}

/**
 * @param {Object} flags
 * @param {string} root
 * @return {string[]}
 */
function extraPluginZipPaths( flags, root ) {

	const raw = flags['extra-plugin-zip'];

	if ( true === raw )
		throw new Error( '--extra-plugin-zip needs a path.' );

	if ( ! raw )
		return [];

	const list = Array.isArray( raw ) ? raw : String( raw ).split( ',' );

	return list
		.map( item => String( item ).trim() )
		.filter( Boolean )
		.map( item => path.resolve( root, item ) );
}

/**
 * Resolves plugin.json extraPlugins and --extra-plugin-zip into mount entries.
 *
 * Zip extracts stay under ~/.wordpress-playground/extra-plugins, never the
 * consumer repo.
 *
 * @param {Object} plugin
 * @param {Object} flags
 * @param {string} root
 * @return {Object[]}
 */
function mergeExtraPlugins( plugin, flags, root ) {

	const declared = Array.isArray( plugin.extraPlugins )
		? plugin.extraPlugins
		: [];

	const fromJson = declared.map( extra => {
		if ( ! extra.zip )
			return extra;

		const found = ensureZipPlugin(
			path.resolve( root, extra.zip ),
			extra,
		);

		return {
			...extra,
			slug:     extra.slug || found.slug,
			dir:      found.dir,
			mainFile: extra.mainFile || found.mainFile,
			mounts:   extra.mounts || found.mounts,
		};
	} );

	const fromFlags = extraPluginZipPaths( flags, root ).map( zipPath => {
		const found = ensureZipPlugin( zipPath );

		return {
			slug:     found.slug,
			dir:      found.dir,
			mainFile: found.mainFile,
			mounts:   found.mounts,
		};
	} );

	return fromJson.concat( fromFlags );
}

module.exports = {
	ensureZipPlugin,
	mergeExtraPlugins,
};
