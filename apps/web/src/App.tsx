import { useEffect, useState } from "react";

type HealthStatus = "pending" | "ok" | "down";

const HEALTH_URL = "https://api.aiconnect.macrotechtitan.com/health";
const CHANGELOG_URL =
  "https://github.com/MacroTechTitan/AI-Connect/blob/master/CHANGELOG.md";

export function App() {
  const [health, setHealth] = useState<HealthStatus>("pending");

  useEffect(() => {
    let cancelled = false;
    fetch(HEALTH_URL)
      .then(async (res) => {
        if (!res.ok) throw new Error("not ok");
        const body = (await res.json()) as { status?: unknown };
        if (cancelled) return;
        setHealth(body.status === "ok" ? "ok" : "down");
      })
      .catch(() => {
        if (!cancelled) setHealth("down");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="page">
      <div className="content">
        <header className="hero">
          <h1>AI Connect</h1>
          <p className="tagline">
            The methodology layer for AI-assisted development.
          </p>
        </header>

        <section className="description">
          <p>
            AI Connect routes prompts to the right AI tool for the job — Claude,
            Claude Code, Cursor, Perplexity, Ollama, and whatever&apos;s next —
            while enforcing the MTTBuild methodology as platform behavior. It also
            handles the operational layer around AI-assisted dev: deploy
            infrastructure (Render, Vercel, Supabase), auth and billing (Auth0,
            Stripe), DNS and edge (Cloudflare), IDE integration (Cursor, VS Code),
            shell automation, container workflows (Docker), repo plumbing
            (GitHub), secret handling, and audit trails — so methodology
            discipline holds across the whole loop, not just the chat.
          </p>
        </section>

        <section className="audience">
          <p>
            Designed for teams that use AI assistants heavily and need conflict
            prevention, reproducible workflows, and honest accountability —
            whether you&apos;re one developer or fifty — without bolting on more
            SaaS. Open-core (MIT framework), self-hostable, and dogfooded on this
            very project.
          </p>
        </section>

        <section className="status-block">
          <p className="status-line">
            <span
              className={`dot dot-${health}`}
              aria-label={`API status: ${health}`}
              role="status"
            />
            <span>Pre-launch &middot; Sprint 0 shipped May 24, 2026</span>
          </p>
          <p>
            Phase 0 infrastructure live in production: API, web, schema, logging,
            admin tooling, secret handling.
          </p>
          <p>
            Next: Sprint 1 — Auth0 wiring + first authenticated routes (June
            2026).
          </p>
          <p>
            <a href={CHANGELOG_URL}>Read the full changelog →</a>
          </p>
        </section>

        <section className="devs">
          <h2>For developers — what AI Connect actually does</h2>
          <p>
            Most AI-assisted dev today is a chat window. You ask Claude or Cursor
            for help, paste output around, commit, hope the methodology you meant
            to follow actually got followed. AI Connect makes the methodology the
            platform.
          </p>
          <p>
            <strong>Routing.</strong> A single chat surface routes each prompt to
            the best AI for the task — planning to Claude, implementation to
            Claude Code, refactoring to Cursor, research to Perplexity, local-only
            work to Ollama. State and context persist across handoffs.
          </p>
          <p>
            <strong>Methodology enforcement.</strong> Every sprint follows
            MTTBuild — Phase 0 infrastructure checklists, conflict prevention
            rules, branch-from-master, revert-first on production breaks, schema
            migrations never auto-apply. The platform won&apos;t let you skip
            steps that should not be skipped.
          </p>
          <p>
            <strong>Operational layer.</strong> AI Connect speaks to the
            infrastructure around your code: triggers Render and Vercel deploys,
            manages Supabase migrations safely, configures Auth0 tenants, handles
            Stripe customers, edits Cloudflare DNS, runs commands in your IDE and
            shell, sets and rotates secrets without exposing them in chat
            history. The boundary between code and
            infrastructure-that-hosts-the-code disappears.
          </p>
          <p>
            <strong>Audit trails.</strong> Every prompt, every AI response, every
            executed action is logged structurally — to logging tables in your
            DB, to git history, to system audit logs. When something breaks at
            2am you can trace exactly what was decided, by which AI, with what
            context. The same audit data is designed to support SOC 2 / ISO 27001
            evidence collection later — change management and developer-activity
            logs without bolt-on tooling.
          </p>
          <p>
            <strong>Open core.</strong> The MIT framework runs on your hardware
            or any cloud. The hosted version at aiconnect.macrotechtitan.com is a
            managed convenience layer — you can switch any time. No lock-in by
            design.
          </p>
        </section>

        <section className="vision">
          <h2>Where this is going</h2>
          <p>
            AI Connect&apos;s connector layer will eventually bridge AI agents to
            any external system — WordPress, IoT devices, telecom APIs, email
            infrastructure, mainframe gateways, Oracle ERPs, custom enterprise
            systems. We&apos;ll integrate with existing connector frameworks
            where they fit and build custom MCP servers where they don&apos;t.
            The methodology and core platform ship first; connectors follow real
            user demand.
          </p>
        </section>

        <section className="links">
          <a href="https://github.com/MacroTechTitan/AI-Connect">GitHub</a>
          <a href="https://github.com/MacroTechTitan/AI-Connect#readme">
            README / Docs
          </a>
          <a href="https://macrotechtitan.com">Macro Tech Titan</a>
          <a href={CHANGELOG_URL}>Changelog</a>
        </section>

        <footer className="footer">
          <p>
            Built by{" "}
            <a href="https://macrotechtitan.com">Macro Tech Titan</a>.
            Open-source under MIT.
          </p>
          <p>Hosted on Render + Vercel + Supabase.</p>
          <p>
            For full legal disclaimers and disclosures, see{" "}
            <a href="https://legal.macrotechtitan.com">
              legal.macrotechtitan.com
            </a>
            .
          </p>
          <p>
            All third-party product names mentioned are trademarks of their
            respective owners.
          </p>
        </footer>
      </div>
    </main>
  );
}
