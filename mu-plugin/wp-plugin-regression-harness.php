<?php
/**
 * @package WP_Plugin_Regression
 */

defined( 'ABSPATH' ) or die;

/**
 * WordPress plugin regression harness
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

/**
 * Playground blueprint eval.php does not chdir into the plugin folder.
 * cwd-relative require_once then misses files that live under plugins/*.
 * Every plugin directory is prepended; the first match wins.
 *
 * @since 1.0.0
 */
function wp_plugin_regression_plugin_include_path() {

	$root = WP_CONTENT_DIR . '/plugins';

	if ( ! is_dir( $root ) ) return;

	$dirs = glob( $root . '/*', GLOB_ONLYDIR );

	if ( ! $dirs ) return;

	set_include_path( implode( PATH_SEPARATOR, $dirs ) . PATH_SEPARATOR . get_include_path() );
}

wp_plugin_regression_plugin_include_path();

add_action( 'init', 'wp_plugin_regression_harness', 0 );

/**
 * Dispatches a local harness request.
 *
 * @since 1.0.0
 */
function wp_plugin_regression_harness() {

	if ( empty( $_GET['wp-plugin-regression'] ) ) return;

	$key_file = __DIR__ . '/wp-plugin-regression.key';

	if ( ! is_file( $key_file ) )
		wp_plugin_regression_reply( [ 'error' => 'missing key' ], 403 );

	$want = trim( (string) file_get_contents( $key_file ) );
	$sent = (string) ( $_SERVER['HTTP_X_WPR_KEY'] ?? '' );

	if ( ! $want || ! hash_equals( $want, $sent ) )
		wp_plugin_regression_reply( [ 'error' => 'bad key' ], 403 );

	$raw  = file_get_contents( 'php://input' );
	$body = json_decode( (string) $raw, true );

	if ( ! is_array( $body ) || empty( $body['action'] ) )
		wp_plugin_regression_reply( [ 'error' => 'invalid json' ], 400 );

	switch ( $body['action'] ) {
		case 'ping':
			wp_plugin_regression_reply( [ 'ok' => true ] );
			break;
		case 'option':
			wp_plugin_regression_option( $body );
			break;
		case 'post':
			wp_plugin_regression_post( $body );
			break;
		case 'term':
			wp_plugin_regression_term( $body );
			break;
		case 'meta':
			wp_plugin_regression_meta( $body );
			break;
		case 'plugin':
			wp_plugin_regression_plugin( $body );
			break;
		case 'frame':
			wp_plugin_regression_frame( $body );
			break;
		default:
			wp_plugin_regression_reply( [ 'error' => 'unknown action' ], 400 );
	}
}

/**
 * Prints JSON and exits.
 *
 * @since 1.0.0
 *
 * @param array $data   Payload.
 * @param int   $status HTTP status.
 */
function wp_plugin_regression_reply( $data, $status = 200 ) {

	http_response_code( $status );
	header( 'Content-Type: application/json; charset=utf-8' );
	echo json_encode( $data );

	exit;
}

/**
 * Updates an option. Consumer shims may handle plugin-specific arrays.
 *
 * @since 1.0.0
 *
 * @param array $body Request body.
 */
function wp_plugin_regression_option( $body ) {

	if ( empty( $body['name'] ) )
		wp_plugin_regression_reply( [ 'error' => 'name required' ], 400 );

	$name  = $body['name'];
	$value = $body['value'] ?? null;

	/**
	 * @param bool   $handled Whether a consumer handled the write.
	 * @param string $name    Option name.
	 * @param mixed  $value   Option value.
	 */
	$handled = apply_filters(
		'wp_plugin_regression_update_option',
		false,
		$name,
		$value,
	);

	if ( ! $handled )
		update_option( $name, $value );

	wp_plugin_regression_reply( [
		'ok'   => true,
		'name' => $name,
	] );
}

/**
 * Inserts or updates a post.
 *
 * @since 1.0.0
 *
 * @param array $body Request body.
 */
function wp_plugin_regression_post( $body ) {

	$args = [
		'post_title'   => $body['title'] ?? 'Harness post',
		'post_status'  => $body['status'] ?? 'publish',
		'post_content' => $body['content'] ?? '',
		'post_type'    => $body['type'] ?? 'post',
		'post_excerpt' => $body['excerpt'] ?? '',
	];

	if ( ! empty( $body['id'] ) )
		$args['ID'] = (int) $body['id'];

	if ( ! empty( $body['slug'] ) )
		$args['post_name'] = $body['slug'];

	$id = wp_insert_post( $args, true );

	if ( is_wp_error( $id ) )
		wp_plugin_regression_reply( [ 'error' => $id->get_error_message() ], 400 );

	wp_plugin_regression_apply_meta( $id, $body['meta'] ?? null, 'post' );

	wp_plugin_regression_reply( wp_plugin_regression_entity_reply( $id, 'post' ) );
}

/**
 * Inserts a term.
 *
 * @since 1.0.0
 *
 * @param array $body Request body.
 */
function wp_plugin_regression_term( $body ) {

	$taxonomy = $body['taxonomy'] ?? 'category';

	if ( ! empty( $body['id'] ) ) {
		$args = [];

		if ( isset( $body['name'] ) )
			$args['name'] = $body['name'];

		if ( isset( $body['slug'] ) )
			$args['slug'] = $body['slug'];

		$result = wp_update_term( (int) $body['id'], $taxonomy, $args );
	} else {
		if ( empty( $body['name'] ) )
			wp_plugin_regression_reply( [ 'error' => 'name required' ], 400 );

		$result = wp_insert_term(
			$body['name'],
			$taxonomy,
			[
				'slug' => $body['slug'] ?? '',
			],
		);
	}

	if ( is_wp_error( $result ) )
		wp_plugin_regression_reply( [ 'error' => $result->get_error_message() ], 400 );

	$id = (int) $result['term_id'];

	wp_plugin_regression_apply_meta( $id, $body['meta'] ?? null, 'term' );

	$reply             = wp_plugin_regression_entity_reply( $id, 'term', $taxonomy );
	$reply['taxonomy'] = $taxonomy;

	wp_plugin_regression_reply( $reply );
}

/**
 * Updates post or term meta.
 *
 * @since 1.0.0
 *
 * @param array $body Request body.
 */
function wp_plugin_regression_meta( $body ) {

	if ( empty( $body['id'] ) || empty( $body['key'] ) )
		wp_plugin_regression_reply( [ 'error' => 'id and key required' ], 400 );

	$id    = (int) $body['id'];
	$type  = $body['type'] ?? 'post';
	$key   = $body['key'];
	$value = $body['value'] ?? '';

	wp_plugin_regression_write_meta( $id, $key, $value, $type );

	$tax = $body['taxonomy'] ?? ( 'term' === $type ? 'category' : '' );

	wp_plugin_regression_reply(
		wp_plugin_regression_entity_reply( $id, $type, $tax ),
	);
}

/**
 * Writes one post or term meta key. Consumer shims may handle plugin-specific bags.
 *
 * @since 1.0.0
 *
 * @param int    $id    Object ID.
 * @param string $key   Meta key.
 * @param mixed  $value Meta value.
 * @param string $type  `post` or `term`.
 */
function wp_plugin_regression_write_meta( $id, $key, $value, $type ) {

	/**
	 * @param bool   $handled Whether a consumer handled the write.
	 * @param int    $id      Object ID.
	 * @param string $key     Meta key.
	 * @param mixed  $value   Meta value.
	 * @param string $type    `post` or `term`.
	 */
	$handled = apply_filters(
		'wp_plugin_regression_update_meta',
		false,
		$id,
		$key,
		$value,
		$type,
	);

	if ( $handled ) return;

	if ( 'term' === $type )
		update_term_meta( $id, $key, $value );
	else
		update_post_meta( $id, $key, $value );
}

/**
 * Writes many meta keys from a harness `meta` object.
 *
 * @since 1.0.0
 *
 * @param int         $id   Object ID.
 * @param array|mixed $meta Key/value pairs.
 * @param string      $type `post` or `term`.
 */
function wp_plugin_regression_apply_meta( $id, $meta, $type ) {

	if ( ! is_array( $meta ) ) return;

	foreach ( $meta as $key => $value )
		wp_plugin_regression_write_meta( $id, $key, $value, $type );
}

/**
 * Builds a post or term harness reply.
 *
 * @since 1.0.0
 *
 * @param int    $id       Object ID.
 * @param string $type     `post` or `term`.
 * @param string $taxonomy Taxonomy when `$type` is `term`.
 * @return array
 */
function wp_plugin_regression_entity_reply( $id, $type, $taxonomy = 'category' ) {

	if ( 'term' === $type ) {
		$link = get_term_link( $id, $taxonomy );

		if ( is_wp_error( $link ) )
			$link = '';
	} else {
		$link = get_permalink( $id ) ?: '';
	}

	$path = $link ? (string) wp_parse_url( $link, PHP_URL_PATH ) : '';

	return [
		'ok'   => true,
		'id'   => $id,
		'url'  => $link,
		'path' => $path,
	];
}

/**
 * Applies a named reading frame. Consumer shims set options.
 *
 * @since 1.0.0
 *
 * @param array $body Request body.
 */
function wp_plugin_regression_frame( $body ) {

	if ( empty( $body['name'] ) )
		wp_plugin_regression_reply( [ 'error' => 'name required' ], 400 );

	$name = $body['name'];

	/**
	 * @param bool   $handled Whether a consumer applied the frame.
	 * @param string $name    Frame name.
	 */
	$handled = apply_filters(
		'wp_plugin_regression_frame',
		false,
		$name,
	);

	wp_plugin_regression_reply( [
		'ok'   => (bool) $handled,
		'name' => $name,
	] );
}

/**
 * Activates or deactivates a plugin.
 *
 * @since 1.0.0
 *
 * @param array $body Request body.
 */
function wp_plugin_regression_plugin( $body ) {

	if ( empty( $body['plugin'] ) )
		wp_plugin_regression_reply( [ 'error' => 'plugin required' ], 400 );

	require_once ABSPATH . 'wp-admin/includes/plugin.php';

	if ( ! empty( $body['enable'] ) ) {
		$result = activate_plugin( $body['plugin'] );

		if ( is_wp_error( $result ) )
			wp_plugin_regression_reply( [ 'error' => $result->get_error_message() ], 400 );
	} else {
		deactivate_plugins( $body['plugin'] );
	}

	wp_plugin_regression_reply( [
		'ok'     => true,
		'plugin' => $body['plugin'],
	] );
}
