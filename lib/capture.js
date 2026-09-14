const fs   = require( 'fs' );
const http = require( 'http' );
const path = require( 'path' );

const { playgroundDir, readRun } = require( './state' );
const { pathToId, printSelection, selectedEntries } = require( './surfaces' );
const { postHarness } = require( './harness' );

/**
 * @param {string} p URL path.
 * @return {string}
 */
function pathToName( p ) {
	return pathToId( p );
}

/**
 * @param {string} html
 * @param {Object} [markers]
 * @return {string|null}
 */
function extractHead( html, markers ) {

	if ( ! markers || ! markers.start ) {
		const match = html.match( /<head\b[^>]*>([\s\S]*?)<\/head>/i );

		return match ? match[1] : html;
	}

	const start = html.indexOf( markers.start );
	const end   = html.indexOf( markers.end, start );

	if ( -1 === start || -1 === end )
		return null;

	const close = html.indexOf( '-->', end );

	if ( -1 === close )
		return null;

	let block = html.slice( start, close + 3 );

	if ( markers.timingStrip )
		block = block.replace( new RegExp( markers.timingStrip, 'g' ), '' );

	return block;
}

/**
 * Tags from `<head>` matching consumer regexes. Who printed them is unknown.
 *
 * @param {string}   html
 * @param {string[]} [patterns]
 * @return {string[]}
 */
function extractHeadTags( html, patterns ) {

	if ( ! Array.isArray( patterns ) || ! patterns.length )
		return [];

	const head = html.match( /<head\b[^>]*>([\s\S]*?)<\/head>/i );
	const hay  = head ? head[1] : html;
	const out  = [];
	const seen = new Set();

	for ( const source of patterns ) {
		const re = new RegExp( source, 'gi' );

		while ( true ) {
			const m = re.exec( hay );

			if ( ! m ) break;

			if ( seen.has( m[0] ) ) continue;

			seen.add( m[0] );
			out.push( m[0] );
		}
	}

	return out;
}

/**
 * Prepends head tags that are not already in the marker block.
 *
 * @param {string|null} block
 * @param {string[]}    extras
 * @return {string|null}
 */
function mergeExtracted( block, extras ) {

	if ( ! extras.length )
		return block;

	const add = extras.filter( tag => ! block || ! block.includes( tag ) );

	if ( ! add.length )
		return block;

	if ( ! block )
		return add.join( '\n' );

	return `${add.join( '\n' )}\n${block}`;
}

/**
 * @param {Object<string, string>} store
 * @param {Object} headers
 */
function applySetCookie( store, headers ) {

	const raw = headers['set-cookie'];

	if ( ! raw )
		return;

	for ( const line of [].concat( raw ) ) {
		const pair = line.split( ';' )[0];
		const eq   = pair.indexOf( '=' );

		if ( -1 === eq )
			continue;

		store[ pair.slice( 0, eq ).trim() ] = pair.slice( eq + 1 );
	}
}

/**
 * @param {Object<string, string>} store
 * @return {string}
 */
function cookieHeader( store ) {
	return Object.entries( store )
		.map( ( [ name, value ] ) => `${name}=${value}` )
		.join( '; ' );
}

/**
 * GET a URL, following a few redirects. Keeps 127.0.0.1 when WP sends localhost.
 *
 * @param {string} urlStr
 * @param {number} hops
 * @param {Object<string, string>} cookies
 * @return {Promise<{status: number, headers: Object, body: string}>}
 */
function httpGet( urlStr, hops, cookies ) {

	if ( hops > 5 )
		return Promise.reject( new Error( `Too many redirects for ${urlStr}.` ) );

	return new Promise( ( resolve, reject ) => {

		const url     = new URL( urlStr );
		const headers = {
			'User-Agent': 'wp-plugin-regression',
		};

		if ( Object.keys( cookies ).length )
			headers.Cookie = cookieHeader( cookies );

		const req = http.get(
			{
				hostname: url.hostname,
				port:     url.port,
				path:     url.pathname + url.search,
				headers,
			},
			res => {

				applySetCookie( cookies, res.headers );

				const loc = res.headers.location;

				if ( res.statusCode >= 300 && res.statusCode < 400 && loc ) {
					const next = new URL( loc, url );

					if ( 'localhost' === next.hostname && '127.0.0.1' === url.hostname )
						next.hostname = '127.0.0.1';

					const same = next.pathname === url.pathname && next.search === url.search;

					req.destroy();

					if ( same ) {
						httpGet( next.href, hops + 1, cookies ).then( resolve, reject );

						return;
					}

					resolve( {
						status:  res.statusCode,
						headers: {
							'content-type':  res.headers['content-type'] || '',
							'x-robots-tag': res.headers['x-robots-tag'] || '',
							location:       loc,
						},
						body: '',
					} );

					return;
				}

				let body = '';

				res.on( 'data', chunk => { body += chunk; } );
				res.on( 'end', () => resolve( {
					status: res.statusCode,
					headers: {
						'content-type':  res.headers['content-type'] || '',
						'x-robots-tag': res.headers['x-robots-tag'] || '',
						location:       res.headers.location || '',
					},
					body,
				} ) );
			},
		);

		req.on( 'error', reject );
	} );
}

/**
 * Extra capture paths from `--path` / `--paths` (comma-separated).
 *
 * @param {Object} flags
 * @return {string[]}
 */
function extraPaths( flags ) {

	const raw = [];

	for ( const key of [ 'path', 'paths' ] ) {
		if ( undefined === flags[ key ] ) continue;

		raw.push(
			...( Array.isArray( flags[ key ] ) ? flags[ key ] : [ flags[ key ] ] ),
		);
	}

	const out = [];

	for ( const item of raw ) {
		for ( const part of String( item ).split( ',' ) ) {
			const p = part.trim();

			if ( p )
				out.push( p );
		}
	}

	return out;
}

/**
 * @param {string} p
 * @param {string} origin
 * @return {string}
 */
function resolvePath( p, origin ) {
	return String( p ).split( '{{origin}}' ).join( origin.replace( /\/$/, '' ) );
}

/**
 * @param {string} root
 * @param {string} label
 * @return {string}
 */
function bundlePath( root, label ) {
	return path.join( playgroundDir( root ), 'captures', `${label}.json` );
}

/**
 * @param {string} root
 * @param {string} label
 * @return {Object|null}
 */
function loadBundle( root, label ) {

	const file = bundlePath( root, label );

	if ( fs.existsSync( file ) )
		return JSON.parse( fs.readFileSync( file, 'utf8' ) );

	const dir = path.join( playgroundDir( root ), 'captures', label );

	if ( ! fs.existsSync( dir ) || ! fs.statSync( dir ).isDirectory() )
		return null;

	const entries = {};

	for ( const name of fs.readdirSync( dir ).filter( f => f.endsWith( '.json' ) ) ) {
		const rec = JSON.parse( fs.readFileSync( path.join( dir, name ), 'utf8' ) );
		const id  = name.replace( /\.json$/, '' );

		entries[ id ] = {
			id,
			type: rec.type || 'path',
			path: rec.path,
			...rec,
		};
	}

	return {
		label,
		entries,
	};
}

/**
 * @param {string} root
 * @param {string} name
 */
async function applyFrame( root, name, port ) {

	const frame = name || 'blog';
	const out   = await postHarness(
		root,
		{
			action: 'frame',
			name:   frame,
		},
		true,
		port,
	);

	if ( ! out.ok || ! out.data.ok )
		throw new Error( `Frame ${frame} failed.` );
}

/**
 * @param {Object} plugin
 * @param {Object} flags
 */
async function capture( plugin, flags ) {

	const root  = flags.root;
	const label = flags.label;

	if ( ! root )
		throw new Error( '--root is required.' );

	if ( ! label )
		throw new Error( '--label is required.' );

	const run = readRun( root, {
		port: flags.port,
		site: label,
	} );

	if ( ! run || ! run.url )
		throw new Error( 'Playground is not running. Launch first.' );

	const origin  = run.url.replace( /\/$/, '' );
	const entries = selectedEntries( plugin, flags );

	for ( const p of extraPaths( flags ) ) {
		entries.push( {
			id:   pathToId( p ),
			type: 'path',
			path: p,
		} );
	}

	if ( ! entries.length )
		throw new Error( 'No capture entries. Check --feature / --types / plugin.json.' );

	printSelection( plugin, flags );

	const byFrame = new Map();

	for ( const entry of entries ) {
		const frame = entry.frame || '';

		if ( ! byFrame.has( frame ) )
			byFrame.set( frame, [] );

		byFrame.get( frame ).push( entry );
	}

	const cookies = {};
	const bundle  = {
		label,
		captured: new Date().toISOString(),
		entries:  {},
	};

	for ( const [ frame, list ] of byFrame ) {
		if ( plugin.surfaces || plugin.entries )
			await applyFrame( root, frame, flags.port );

		for ( const entry of list ) {
			const p = resolvePath( entry.path, origin );
			let got;

			try {
				got = await httpGet( new URL( p, run.url ).href, 0, cookies );
			} catch ( err ) {
				throw new Error( `${entry.id} ${p}: ${err.message}` );
			}

			const type = ( got.headers['content-type'] || '' ).toLowerCase();
			let extracted = got.body;

			if ( type.includes( 'html' ) && got.body ) {
				extracted = extractHead( got.body, plugin.headMarkers );

				if ( null === extracted && plugin.headMarkers && got.status < 300 )
					throw new Error( `Missing head markers on ${entry.id} ${p}.` );

				extracted = mergeExtracted(
					extracted,
					extractHeadTags( got.body, plugin.headTags ),
				);
			}

			if ( got.status >= 500 )
				throw new Error( `${entry.id} ${p} returned ${got.status}.` );

			bundle.entries[ entry.id ] = {
				id:     entry.id,
				type:   entry.type,
				path:   p,
				frame:  entry.frame || '',
				status: got.status,
				headers: got.headers,
				extracted,
			};

			console.log( `${got.status} ${entry.id} ${p}` );
		}
	}

	if ( plugin.surfaces || plugin.entries )
		await applyFrame( root, 'blog', flags.port );

	const dest = path.join( playgroundDir( root ), 'captures' );

	fs.mkdirSync( dest, { recursive: true } );
	fs.writeFileSync(
		bundlePath( root, label ),
		JSON.stringify( bundle, null, '\t' ) + '\n',
	);

	console.log( `Wrote ${bundlePath( root, label )}` );
}

module.exports = {
	bundlePath,
	capture,
	extractHead,
	extractHeadTags,
	loadBundle,
	pathToName,
};
