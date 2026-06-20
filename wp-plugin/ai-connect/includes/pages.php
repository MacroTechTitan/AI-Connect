<?php
/**
 * Dynamic page registration.
 *
 * Each configured module maps a clean URL (/{slug}/) to an embedded iframe of
 * the module's source_url, optionally gated behind a MemberPress membership.
 * Pages are driven entirely by the modules option — no physical templates, no
 * WP "pages" in the database.
 */

defined('ABSPATH') || exit;

add_filter('query_vars', 'ai_connect_add_query_vars');
add_action('template_redirect', 'ai_connect_maybe_render_module');

function ai_connect_add_query_vars($vars)
{
    $vars[] = 'ai_connect_module';
    return $vars;
}

/**
 * Registers a rewrite rule per module: /{slug}/ → ?ai_connect_module={slug}.
 * Runs on init (and again after any modules change, paired with a flush).
 */
function ai_connect_register_module_pages()
{
    $modules = get_option(AI_CONNECT_OPTION_MODULES, array());
    if (!is_array($modules)) {
        return;
    }
    foreach ($modules as $module) {
        if (empty($module['slug'])) {
            continue;
        }
        $slug = $module['slug'];
        add_rewrite_rule(
            '^' . preg_quote($slug, '#') . '/?$',
            'index.php?ai_connect_module=' . $slug,
            'top'
        );
    }
}

/**
 * If the current request resolved to a module slug, take over rendering.
 */
function ai_connect_maybe_render_module()
{
    $slug = get_query_var('ai_connect_module');
    if (!$slug) {
        return;
    }

    $module = null;
    foreach (get_option(AI_CONNECT_OPTION_MODULES, array()) as $candidate) {
        if (isset($candidate['slug']) && $candidate['slug'] === $slug) {
            $module = $candidate;
            break;
        }
    }

    if (!$module) {
        status_header(404);
        ai_connect_render_html('Not found', '<h1>Page not found</h1>');
        exit;
    }

    $tier = isset($module['required_memberpress_tier']) ? $module['required_memberpress_tier'] : null;

    if ($tier !== null && $tier !== '') {
        $user_id = get_current_user_id();
        $allowed = $user_id && ai_connect_user_has_membership($user_id, $tier);
        if (!$allowed) {
            status_header(403);
            ai_connect_render_gate($module, $tier);
            exit;
        }
    }

    ai_connect_render_embed($module);
    exit;
}

/**
 * Gating UI shown when the visitor lacks the required membership (or is logged
 * out). Offers a login link (returning here afterward) and an upgrade link.
 */
function ai_connect_render_gate($module, $tier)
{
    $tier_name = ai_connect_membership_title($tier);
    $current_url = home_url(add_query_arg(array(), $GLOBALS['wp']->request));
    $login_url = wp_login_url($current_url);
    $upgrade_url = ai_connect_upgrade_url();

    $body = '<div style="max-width:480px;margin:12vh auto;text-align:center;font-family:system-ui,sans-serif;">'
        . '<h1 style="font-size:1.5rem;">Members only</h1>'
        . '<p style="opacity:.8;">This content requires '
        . esc_html($tier_name)
        . ' membership.</p>'
        . '<p style="margin-top:1.5rem;display:flex;gap:.75rem;justify-content:center;flex-wrap:wrap;">'
        . '<a href="' . esc_url($login_url) . '" style="padding:.6rem 1.1rem;background:#111;color:#fff;border-radius:6px;text-decoration:none;">Log in</a>'
        . '<a href="' . esc_url($upgrade_url) . '" style="padding:.6rem 1.1rem;border:1px solid #111;color:#111;border-radius:6px;text-decoration:none;">Become a member</a>'
        . '</p></div>';

    ai_connect_render_html(esc_html($module['title']), $body);
}

/**
 * The actual embed: a full-viewport iframe of the module's source_url.
 */
function ai_connect_render_embed($module)
{
    $src = esc_url($module['source_url']);
    $body = '<iframe src="' . $src . '" style="position:fixed;inset:0;border:0;width:100vw;height:100vh;" '
        . 'frameborder="0" allow="clipboard-read; clipboard-write; fullscreen"></iframe>';
    ai_connect_render_html(esc_html($module['title']), $body, true);
}

/**
 * Minimal HTML wrapper. Themed integration (header/footer) is Sprint 6.5; for
 * MVP we render a clean standalone document so the embed can't be broken by a
 * theme's layout. $bare drops body margins for the full-screen iframe case.
 */
function ai_connect_render_html($title, $body, $bare = false)
{
    nocache_headers();
    header('Content-Type: text/html; charset=utf-8');
    $margin = $bare ? 'margin:0;padding:0;overflow:hidden;' : 'margin:0;';
    echo '<!doctype html><html ' . get_language_attributes() . '><head>'
        . '<meta charset="utf-8" />'
        . '<meta name="viewport" content="width=device-width, initial-scale=1" />'
        . '<title>' . $title . '</title>'
        . '</head><body style="' . $margin . '">'
        . $body
        . '</body></html>';
}

/**
 * Resolves the human-readable membership title for display, falling back to the
 * raw tier id when MemberPress can't resolve it.
 */
function ai_connect_membership_title($tier)
{
    $memberships = ai_connect_get_memberpress_memberships();
    if (is_array($memberships)) {
        foreach ($memberships as $m) {
            if ((string) $m['id'] === (string) $tier) {
                return $m['title'];
            }
        }
    }
    return 'the required';
}
