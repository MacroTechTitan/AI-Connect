# GitHub App connector

The GitHub App connector lets AI Connect create repos, issues, and pull requests on your behalf in your own GitHub org or account.

## Why use it

Without the GitHub connector, Project Genesis creates repos in MacroTechTitan's org. With the connector, repos land in your own org — same permissions, same UI, but you own the code from day one.

## Installation

Settings → Integrations → **Add** → **GitHub**.

The wizard redirects you to GitHub. You'll:
1. Pick which account or organization to install the AI Connect App on
2. Choose repo access — all repos, or specific repos
3. Approve permissions

GitHub redirects you back to AI Connect. The wizard finishes automatically.

## What AI Connect can do with your GitHub

The AI Connect App has these repository permissions:
- **Administration** — create and delete repos (needed for Project Genesis)
- **Contents** — read/write repo files
- **Issues** — create and manage issues
- **Pull requests** — create and manage PRs
- **Checks** — future CI-style integrations
- **Metadata** — read basic repo info (mandatory)

## Try It

From the GitHub Integration Manager, use the **Try It** section to create a test issue in one of your repos.

## Project Genesis integration

Once the GitHub integration is set up, mark it as **Include in projects**. When you provision a new project, AI Connect will create the repo in your GitHub org instead of MacroTechTitan's.

**Note:** In v1, the Project Genesis GitHub App path is gated behind template support. All v1 templates default to the MacroTechTitan flow. Template scaffolding via installation token is deferred to a future sprint.

## Uninstalling

Visit `https://github.com/settings/installations` on GitHub. Click **Configure** on the AI Connect App → **Uninstall**. The corresponding AI Connect integration is cleaned up automatically via webhook.
