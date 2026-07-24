<?php
/**
 * Mobile auth broker support.
 *
 * Two token-gated endpoints that let AI Connect verify a WordPress login and
 * read MemberPress entitlements on behalf of a mobile app, WITHOUT the app ever
 * seeing WordPress credentials, MemberPress keys, or any JWT plugin:
 *
 *   POST /wp-json/ai-connect/v1/validate-login   { username, password }
 *   GET  /wp-json/ai-connect/v1/membership-status?user_id=123
 *
 * Both are authenticated by the same X-AI-Connect-Token header as the rest of
 * the ai-connect/v1 namespace (see rest-api.php ai_connect_rest_auth). Only
 * AI Connect's server, holding that token, can call them.
 *
 * Password verification uses wp_authenticate() — the real WordPress auth path —
 * so it honors password hashing, disabled accounts, 2FA/SSO/lockout plugins that
 * hook the `authenticate` filter, and everything else the login form respects.
 * We deliberately do NOT use wp_check_password() (which bypasses that policy) and
 * do NOT use the MemberPress mp/v1 API for auth (it verifies API keys, not user
 * passwords).
 */

defined('ABSPATH') || exit;

/**
 * All active MemberPress membership ids for a user, as an array of strings.
 * Empty array when MemberPress is absent or the user has no active access —
 * fail closed, never assume access.
 */
function ai_connect_active_membership_ids($user_id)
{
    if (!$user_id || !ai_connect_is_memberpress_active() || !class_exists('MeprUser')) {
        return array();
    }

    $mepr_user = new MeprUser($user_id);
    if (!method_exists($mepr_user, 'active_product_subscriptions')) {
        return array();
    }

    $active_ids = $mepr_user->active_product_subscriptions('ids');
    if (!is_array($active_ids)) {
        return array();
    }

    // Normalize to strings so tier ids compare cleanly on the AI Connect side.
    return array_values(array_map('strval', $active_ids));
}

/**
 * Shape a WP_User + its active memberships into the membership payload both
 * endpoints return. `active` is true iff there is at least one active tier.
 */
function ai_connect_membership_payload(WP_User $user)
{
    $tiers = ai_connect_active_membership_ids($user->ID);
    return array(
        'user' => array(
            'id' => (string) $user->ID,
            'email' => $user->user_email,
            'display_name' => $user->display_name,
        ),
        'active' => count($tiers) > 0,
        'tiers' => $tiers,
    );
}

/**
 * POST /ai-connect/v1/validate-login
 *
 * Verifies username + password against WordPress and returns the user's
 * MemberPress status. On any auth failure returns a single generic 401 with no
 * detail — invalid username and wrong password are indistinguishable to the
 * caller, so the endpoint can't be used to enumerate accounts.
 */
function ai_connect_rest_validate_login(WP_REST_Request $request)
{
    $body = $request->get_json_params();
    $username = is_array($body) && isset($body['username']) ? $body['username'] : '';
    $password = is_array($body) && isset($body['password']) ? $body['password'] : '';

    if (!is_string($username) || !is_string($password) || $username === '' || $password === '') {
        return new WP_REST_Response(array('error' => 'invalid_credentials'), 401);
    }

    // wp_authenticate() runs the full `authenticate` filter chain. In a REST
    // request the application-password authenticator is on that chain, which
    // would let a generated app password satisfy this route. Remove it so ONLY
    // the user's real login password is accepted (priority 20 is the core
    // default at which it's registered).
    remove_filter('authenticate', 'wp_authenticate_application_password', 20);

    $user = wp_authenticate($username, $password);

    if (is_wp_error($user) || !($user instanceof WP_User)) {
        // Collapse every failure mode (bad username, wrong password, locked out,
        // disabled) into one opaque response. No user enumeration.
        return new WP_REST_Response(array('error' => 'invalid_credentials'), 401);
    }

    return new WP_REST_Response(ai_connect_membership_payload($user), 200);
}

/**
 * GET /ai-connect/v1/membership-status?user_id=123
 *
 * Re-reads a user's current MemberPress status WITHOUT a password. AI Connect
 * calls this on the token-refresh path so a revoked or expired membership stops
 * lingering in an issued token. A user id that no longer resolves returns a
 * clean "no access" payload (active:false) rather than an error, so a refresh
 * downgrades gracefully instead of failing.
 */
function ai_connect_rest_membership_status(WP_REST_Request $request)
{
    $user_id = $request->get_param('user_id');
    if (!is_string($user_id) && !is_int($user_id)) {
        return new WP_Error('ai_connect_bad_user', 'user_id is required.', array('status' => 400));
    }
    $user_id = (int) $user_id;
    if ($user_id <= 0) {
        return new WP_Error('ai_connect_bad_user', 'user_id must be a positive integer.', array('status' => 400));
    }

    $user = get_user_by('id', $user_id);
    if (!($user instanceof WP_User)) {
        return new WP_REST_Response(array(
            'user' => array('id' => (string) $user_id, 'email' => null, 'display_name' => null),
            'active' => false,
            'tiers' => array(),
        ), 200);
    }

    return new WP_REST_Response(ai_connect_membership_payload($user), 200);
}
