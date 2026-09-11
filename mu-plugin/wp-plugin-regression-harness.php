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

	$id = wp_insert_post( $args, true );

	if ( is_wp_error( $id ) )
		wp_plugin_regression_reply( [ 'error' => $id->get_error_message() ], 400 );

	wp_plugin_regression_reply( [
		'ok'  => true,
		'id'  => $id,
		'url' => get_permalink( $id ),
	] );
}

/**
 * Inserts a term.
 *
 * @since 1.0.0
 *
 * @param array $body Request body.
 */
function wp_plugin_regression_term( $body ) {

	if ( empty( $body['name'] ) )
		wp_plugin_regression_reply( [ 'error' => 'name required' ], 400 );

	$taxonomy = $body['taxonomy'] ?? 'category';
	$result   = wp_insert_term(
		$body['name'],
		$taxonomy,
		[
			'slug' => $body['slug'] ?? '',
		],
	);

	if ( is_wp_error( $result ) )
		wp_plugin_regression_reply( [ 'error' => $result->get_error_message() ], 400 );

	wp_plugin_regression_reply( [
		'ok'       => true,
		'id'       => $result['term_id'],
		'taxonomy' => $taxonomy,
	] );
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
	$key   = $body['key'];
	$value = $body['value'] ?? '';

	if ( 'term' === ( $body['type'] ?? 'post' ) )
		$ok = update_term_meta( $id, $key, $value );
	else
		$ok = update_post_meta( $id, $key, $value );

	wp_plugin_regression_reply( [
		'ok' => false !== $ok,
		'id' => $id,
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
