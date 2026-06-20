<?php
/**
 * REST API under the ai-connect/v1 namespace.
 *
 * Every endpoint is authenticated by the X-AI-Connect-Token header matched
 * against the token stored in wp_options. AI Connect manages modules entirely
 * through these endpoints — the operator never edits module config by hand.
 */

defined('ABSPATH') || exit;

add_action('rest_api_init', 'ai_connect_register_rest_routes');

function ai_connect_register_rest_routes()
{
    $auth = 'ai_connect_rest_auth';

    register_rest_route('ai-connect/v1', '/ping', array(
        'methods' => 'GET',
        'callback' => 'ai_connect_rest_ping',
        'permission_callback' => $auth,
    ));

    register_rest_route('ai-connect/v1', '/status', array(
        'methods' => 'GET',
        'callback' => 'ai_connect_rest_status',
        'permission_callback' => $auth,
    ));

    register_rest_route('ai-connect/v1', '/modules', array(
        array(
            'methods' => 'GET',
            'callback' => 'ai_connect_rest_list_modules',
            'permission_callback' => $auth,
        ),
        array(
            'methods' => 'POST',
            'callback' => 'ai_connect_rest_add_module',
            'permission_callback' => $auth,
        ),
    ));

    register_rest_route('ai-connect/v1', '/modules/(?P<slug>[a-z0-9-]+)', array(
        array(
            'methods' => 'PUT',
            'callback' => 'ai_connect_rest_update_module',
            'permission_callback' => $auth,
        ),
        array(
            'methods' => 'DELETE',
            'callback' => 'ai_connect_rest_delete_module',
            'permission_callback' => $auth,
        ),
    ));
}

/**
 * Permission callback: constant-time compare the request token against the
 * stored one. Returns a WP_Error (→ 401) on missing/mismatch so the body is
 * machine-readable on the AI Connect side.
 */
function ai_connect_rest_auth(WP_REST_Request $request)
{
    $provided = $request->get_header('x-ai-connect-token');
    $stored = get_option(AI_CONNECT_OPTION_TOKEN, '');

    if (!$stored || !is_string($provided) || $provided === '' || !hash_equals($stored, $provided)) {
        return new WP_Error(
            'ai_connect_unauthorized',
            'Invalid or missing AI Connect token.',
            array('status' => 401)
        );
    }
    return true;
}

function ai_connect_rest_ping()
{
    update_option(AI_CONNECT_OPTION_LAST_PING, current_time('mysql'));
    return new WP_REST_Response(array(
        'status' => 'ok',
        'version' => AI_CONNECT_VERSION,
        'site_url' => site_url(),
    ), 200);
}

function ai_connect_rest_status()
{
    $mp_active = ai_connect_is_memberpress_active();
    return new WP_REST_Response(array(
        'wp_version' => get_bloginfo('version'),
        'plugin_version' => AI_CONNECT_VERSION,
        'active_theme' => function_exists('wp_get_theme') ? wp_get_theme()->get('Name') : null,
        'memberpress_installed' => $mp_active,
        'memberpress_version' => ($mp_active && defined('MEPR_VERSION')) ? MEPR_VERSION : null,
        'memberpress_memberships' => $mp_active ? ai_connect_get_memberpress_memberships() : null,
    ), 200);
}

function ai_connect_rest_list_modules()
{
    return new WP_REST_Response(ai_connect_get_modules(), 200);
}

function ai_connect_rest_add_module(WP_REST_Request $request)
{
    $module = ai_connect_sanitize_module($request->get_json_params());
    if (is_wp_error($module)) {
        return $module;
    }

    $modules = ai_connect_get_modules();
    foreach ($modules as $existing) {
        if ($existing['slug'] === $module['slug']) {
            return new WP_Error(
                'ai_connect_slug_exists',
                'A module with that slug already exists.',
                array('status' => 409)
            );
        }
    }

    $modules[] = $module;
    update_option(AI_CONNECT_OPTION_MODULES, array_values($modules));
    ai_connect_register_module_pages();
    flush_rewrite_rules(false);

    return new WP_REST_Response($module, 201);
}

function ai_connect_rest_update_module(WP_REST_Request $request)
{
    $slug = $request->get_param('slug');
    $module = ai_connect_sanitize_module($request->get_json_params(), $slug);
    if (is_wp_error($module)) {
        return $module;
    }

    $modules = ai_connect_get_modules();
    $found = false;
    foreach ($modules as $i => $existing) {
        if ($existing['slug'] === $slug) {
            $modules[$i] = $module;
            $found = true;
            break;
        }
    }
    if (!$found) {
        return new WP_Error('ai_connect_not_found', 'Module not found.', array('status' => 404));
    }

    update_option(AI_CONNECT_OPTION_MODULES, array_values($modules));
    ai_connect_register_module_pages();
    flush_rewrite_rules(false);

    return new WP_REST_Response($module, 200);
}

function ai_connect_rest_delete_module(WP_REST_Request $request)
{
    $slug = $request->get_param('slug');
    $modules = ai_connect_get_modules();
    $next = array();
    $found = false;
    foreach ($modules as $existing) {
        if ($existing['slug'] === $slug) {
            $found = true;
            continue;
        }
        $next[] = $existing;
    }
    if (!$found) {
        return new WP_Error('ai_connect_not_found', 'Module not found.', array('status' => 404));
    }

    update_option(AI_CONNECT_OPTION_MODULES, array_values($next));
    ai_connect_register_module_pages();
    flush_rewrite_rules(false);

    return new WP_REST_Response(array('slug' => $slug, 'deleted' => true), 200);
}

/**
 * Reads the modules option, defensively normalizing to a list of arrays.
 */
function ai_connect_get_modules()
{
    $modules = get_option(AI_CONNECT_OPTION_MODULES, array());
    return is_array($modules) ? $modules : array();
}

/**
 * Validates and normalizes an incoming module payload.
 *
 * When $force_slug is provided (PUT), the slug is taken from the URL rather
 * than the body so the route is the source of truth.
 */
function ai_connect_sanitize_module($body, $force_slug = null)
{
    if (!is_array($body)) {
        return new WP_Error('ai_connect_bad_body', 'Expected a JSON object.', array('status' => 400));
    }

    $slug = $force_slug !== null ? $force_slug : (isset($body['slug']) ? $body['slug'] : '');
    if (!is_string($slug) || !preg_match('/^[a-z0-9-]+$/', $slug)) {
        return new WP_Error(
            'ai_connect_bad_slug',
            'Slug must be lowercase letters, numbers, and hyphens only.',
            array('status' => 400)
        );
    }

    $title = isset($body['title']) ? $body['title'] : '';
    if (!is_string($title) || trim($title) === '') {
        return new WP_Error('ai_connect_bad_title', 'Title is required.', array('status' => 400));
    }

    $source_url = isset($body['source_url']) ? $body['source_url'] : '';
    if (!is_string($source_url) || !preg_match('#^https?://#i', $source_url)) {
        return new WP_Error(
            'ai_connect_bad_source_url',
            'source_url must start with http:// or https://.',
            array('status' => 400)
        );
    }

    $tier = isset($body['required_memberpress_tier']) ? $body['required_memberpress_tier'] : null;
    if ($tier !== null && !is_string($tier) && !is_int($tier)) {
        return new WP_Error('ai_connect_bad_tier', 'required_memberpress_tier must be a tier id or null.', array('status' => 400));
    }

    return array(
        'slug' => $slug,
        'title' => sanitize_text_field($title),
        'source_url' => esc_url_raw($source_url),
        'required_memberpress_tier' => ($tier === null || $tier === '') ? null : (string) $tier,
    );
}
