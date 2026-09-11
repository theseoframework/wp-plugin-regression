const fs   = require( 'fs' );
const http = require( 'http' );
const path = require( 'path' );

const { playgroundDir, readRun } = require( './state' );

/**
 * @param {string} p URL path.
 * @return {string}
 */
function pathToName( p ) {

	if ( '/' === p )
		return 'home';

	return p.replace( /^\//, '' ).replace( /[/?&=]/g, '_' ).replace( /_+$/, '' ) || 'home';
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

	const run = readRun( root );

	if ( ! run || ! run.url )
		throw new Error( 'Playground is not running. Launch first.' );

	const dest = path.join( playgroundDir( root ), 'captures', label );

	fs.mkdirSync( dest, { recursive: true } );

	const paths   = [ ...plugin.paths ];
	const seen    = new Set( paths );
	const cookies = {};

	for ( const p of paths ) {
		let got;

		try {
			got = await httpGet( new URL( p, run.url ).href, 0, cookies );
		} catch ( err ) {
			throw new Error( `${p}: ${err.message}` );
		}
		const name = pathToName( p );
		const type = ( got.headers['content-type'] || '' ).toLowerCase();
		let extracted = got.body;

		if ( type.includes( 'html' ) && got.body ) {
			extracted = extractHead( got.body, plugin.headMarkers );

			if ( null === extracted && plugin.headMarkers )
				throw new Error( `Missing head markers on ${p}.` );
		}

		if ( got.status >= 500 )
			throw new Error( `${p} returned ${got.status}.` );

		const record = {
			path:   p,
			status: got.status,
			headers: got.headers,
			extracted,
		};

		fs.writeFileSync(
			path.join( dest, `${name}.json` ),
			JSON.stringify( record, null, '\t' ) + '\n',
		);

		if ( type.includes( 'xml' ) && got.body.includes( '<loc>' ) ) {
			const locs = [ ...got.body.matchAll( /<loc>\s*([^<]+)\s*<\/loc>/g ) ];

			for ( const loc of locs ) {
				let child = loc[1].trim();

				if ( child.startsWith( run.url ) )
					child = child.slice( run.url.length ) || '/';

				if ( seen.has( child ) )
					continue;

				seen.add( child );
				paths.push( child );
			}
		}

		console.log( `${got.status} ${p}` );
	}

	console.log( `Wrote ${dest}` );
}

module.exports = {
	capture,
	extractHead,
	pathToName,
};
