<?php
/**
 * MemberPress integration, fully optional.
 *
 * Every function guards on MemberPress being installed and active. When it
 * isn't, membership checks fail closed (return false / null) so a gated module
 * never accidentally becomes public because the membership plugin is missing.
 */

defined('ABSPATH') || exit;

/**
 * MemberPress active when its main class is loaded. MEPR_VERSION is defined by
 * the plugin's bootstrap, so it's a reliable secondary signal.
 */
function ai_connect_is_memberpress_active()
{
    return class_exists('MeprProduct') || defined('MEPR_VERSION');
}

/**
 * All MemberPress memberships as [{ id, title }], or null if MemberPress isn't
 * installed. Memberships are the `memberpressproduct` custom post type.
 */
function ai_connect_get_memberpress_memberships()
{
    if (!ai_connect_is_memberpress_active()) {
        return null;
    }

    $posts = get_posts(array(
        'post_type' => 'memberpressproduct',
        'post_status' => 'publish',
        'numberposts' => -1,
        'orderby' => 'title',
        'order' => 'ASC',
    ));

    $memberships = array();
    foreach ($posts as $post) {
        $memberships[] = array(
            'id' => (string) $post->ID,
            'title' => $post->post_title,
        );
    }
    return $memberships;
}

/**
 * Whether $user_id holds an active subscription to membership $membership_id.
 * Uses MemberPress's MeprUser API when available; fails closed otherwise.
 */
function ai_connect_user_has_membership($user_id, $membership_id)
{
    if (!$user_id || !ai_connect_is_memberpress_active() || !class_exists('MeprUser')) {
        return false;
    }

    $mepr_user = new MeprUser($user_id);
    if (!method_exists($mepr_user, 'active_product_subscriptions')) {
        return false;
    }

    $active_ids = $mepr_user->active_product_subscriptions('ids');
    if (!is_array($active_ids)) {
        return false;
    }

    foreach ($active_ids as $id) {
        if ((string) $id === (string) $membership_id) {
            return true;
        }
    }
    return false;
}

/**
 * Best-effort "become a member" URL. Prefers MemberPress's configured account
 * page, falling back to common defaults.
 */
function ai_connect_upgrade_url()
{
    if (class_exists('MeprOptions')) {
        $options = MeprOptions::fetch();
        if (!empty($options->account_page_id)) {
            $url = get_permalink($options->account_page_id);
            if ($url) {
                return $url;
            }
        }
    }
    return home_url('/register/');
}
