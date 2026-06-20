<?php
/**
 * Admin settings page: Settings → AI Connect.
 *
 * Shows the plugin status, lets the operator generate the connection token that
 * AI Connect uses to authenticate, and surfaces the last time AI Connect
 * successfully reached this site.
 */

defined('ABSPATH') || exit;

add_action('admin_menu', 'ai_connect_register_admin_menu');
add_action('admin_post_ai_connect_generate_token', 'ai_connect_handle_generate_token');

function ai_connect_register_admin_menu()
{
    add_options_page(
        'AI Connect',
        'AI Connect',
        'manage_options',
        'ai-connect',
        'ai_connect_render_settings_page'
    );
}

/**
 * Generates a fresh 32-char hex token, stores it, and redirects back to the
 * settings page. Replacing the token immediately invalidates the old one — the
 * operator must re-paste the new value into AI Connect.
 */
function ai_connect_handle_generate_token()
{
    if (!current_user_can('manage_options')) {
        wp_die('Insufficient permissions.');
    }
    check_admin_referer('ai_connect_generate_token');

    // 16 random bytes → 32 hex chars.
    $token = bin2hex(random_bytes(16));
    update_option(AI_CONNECT_OPTION_TOKEN, $token);

    wp_safe_redirect(
        add_query_arg(
            array('page' => 'ai-connect', 'ai_connect_generated' => '1'),
            admin_url('options-general.php')
        )
    );
    exit;
}

function ai_connect_render_settings_page()
{
    if (!current_user_can('manage_options')) {
        return;
    }

    $token = get_option(AI_CONNECT_OPTION_TOKEN, '');
    $last_ping = get_option(AI_CONNECT_OPTION_LAST_PING, '');
    $just_generated = isset($_GET['ai_connect_generated']);
    ?>
    <div class="wrap">
        <h1>AI Connect</h1>

        <?php if ($just_generated) : ?>
            <div class="notice notice-success is-dismissible">
                <p>New token generated. Copy it below and paste it into AI Connect.</p>
            </div>
        <?php endif; ?>

        <table class="form-table" role="presentation">
            <tr>
                <th scope="row">Plugin version</th>
                <td><?php echo esc_html(AI_CONNECT_VERSION); ?></td>
            </tr>
            <tr>
                <th scope="row">Connection status</th>
                <td>
                    <?php if ($token) : ?>
                        <span style="color:#1a7f37;">Token set</span>
                    <?php else : ?>
                        <span style="color:#b32d2e;">No token yet — generate one to connect</span>
                    <?php endif; ?>
                </td>
            </tr>
            <tr>
                <th scope="row">Last reached by AI Connect</th>
                <td>
                    <?php
                    echo $last_ping
                        ? esc_html($last_ping)
                        : '<em>Never — AI Connect has not contacted this site yet.</em>';
                    ?>
                </td>
            </tr>
        </table>

        <h2>Connection token</h2>
        <p>Copy this token, then paste it into AI Connect when prompted.</p>

        <?php if ($token) : ?>
            <p>
                <code id="ai-connect-token" style="font-family:monospace;font-size:14px;padding:6px 10px;background:#f6f7f7;border:1px solid #ccd0d4;border-radius:4px;display:inline-block;">
                    <?php echo esc_html($token); ?>
                </code>
                <button type="button" class="button" onclick="aiConnectCopyToken()">Copy token</button>
                <span id="ai-connect-copied" style="display:none;color:#1a7f37;margin-left:8px;">Copied!</span>
            </p>
        <?php else : ?>
            <p><em>No token yet.</em></p>
        <?php endif; ?>

        <form method="post" action="<?php echo esc_url(admin_url('admin-post.php')); ?>" style="margin-top:12px;">
            <input type="hidden" name="action" value="ai_connect_generate_token" />
            <?php wp_nonce_field('ai_connect_generate_token'); ?>
            <button type="submit" class="button button-primary">
                <?php echo $token ? 'Generate New Token' : 'Generate Token'; ?>
            </button>
            <?php if ($token) : ?>
                <p class="description">Generating a new token invalidates the old one. You'll need to re-paste it into AI Connect.</p>
            <?php endif; ?>
        </form>

        <h2 style="margin-top:24px;">Test connection</h2>
        <p>This shows the last time AI Connect successfully contacted your site. Trigger a validation from AI Connect, then refresh this page.</p>
        <p>
            <button type="button" class="button" onclick="window.location.reload();">Refresh status</button>
        </p>

        <script>
            function aiConnectCopyToken() {
                var el = document.getElementById('ai-connect-token');
                if (!el) return;
                var text = el.textContent.trim();
                var done = function () {
                    var c = document.getElementById('ai-connect-copied');
                    if (c) { c.style.display = 'inline'; setTimeout(function () { c.style.display = 'none'; }, 2000); }
                };
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(text).then(done);
                } else {
                    var ta = document.createElement('textarea');
                    ta.value = text;
                    document.body.appendChild(ta);
                    ta.select();
                    try { document.execCommand('copy'); } catch (e) {}
                    document.body.removeChild(ta);
                    done();
                }
            }
        </script>
    </div>
    <?php
}
