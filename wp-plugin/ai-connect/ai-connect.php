<?php
/**
 * Plugin Name: AI Connect
 * Plugin URI: https://aiconnect.macrotechtitan.com
 * Description: Embeds external apps as WordPress pages with optional MemberPress gating. Managed via AI Connect.
 * Version: 1.0.0
 * Author: Macro Tech Titan
 * License: MIT
 */

defined('ABSPATH') || exit;

define('AI_CONNECT_VERSION', '1.0.0');
define('AI_CONNECT_PLUGIN_DIR', plugin_dir_path(__FILE__));
define('AI_CONNECT_OPTION_TOKEN', 'ai_connect_token');
define('AI_CONNECT_OPTION_MODULES', 'ai_connect_modules');
define('AI_CONNECT_OPTION_LAST_PING', 'ai_connect_last_pinged_at');

require_once AI_CONNECT_PLUGIN_DIR . 'includes/admin.php';
require_once AI_CONNECT_PLUGIN_DIR . 'includes/rest-api.php';
require_once AI_CONNECT_PLUGIN_DIR . 'includes/pages.php';
require_once AI_CONNECT_PLUGIN_DIR . 'includes/memberpress.php';

// Activation: ensure a default empty modules array, then flush rewrite rules so
// any future module pages can register cleanly.
register_activation_hook(__FILE__, function () {
    if (get_option(AI_CONNECT_OPTION_MODULES) === false) {
        update_option(AI_CONNECT_OPTION_MODULES, []);
    }
    ai_connect_register_module_pages();
    flush_rewrite_rules(false);
});

// Deactivation: drop the dynamic rewrite rules we added so WordPress stops
// trying to route module slugs to a plugin that's no longer loaded.
register_deactivation_hook(__FILE__, function () {
    flush_rewrite_rules(false);
});

// Init: register dynamic pages from saved modules.
add_action('init', 'ai_connect_register_module_pages');
