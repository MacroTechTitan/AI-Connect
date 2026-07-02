# AI Connect Design System

Sprint 8 introduced a formal design system for AI Connect. This document describes what exists, when to use it, and how to extend it.

## What exists

### Design tokens (Commit 2)

`apps/web/src/ui/tokens.ts` — the source of truth for AI Connect's visual language. TypeScript constants for:

- **Colors:** primary (blue scale 50-900), neutral (zinc scale 0-950), success/warning/error/info (with subtle_bg + subtle_fg pairs)
- **Typography:** fontFamily (sans/mono), fontSize (xs-5xl), lineHeight, fontWeight
- **Spacing:** 4px base scale (0.5, 1, 1.5, 2, 3, 4, 5, 6, 7, 8, 10, 12, 16, 20, 24)
- **Radii:** none, sharp, soft, md, lg, xl, 2xl, round, pill, full
- **Shadows:** none, sm, md, lg, xl, inset
- **Timings:** instant, fast (120ms), normal (180ms), slow (300ms), slower (500ms)
- **Easings:** linear, easeIn, easeOut, easeInOut
- **Z-index:** base, raised, dropdown, sticky, overlay, modal, toast, tooltip

Tokens are injected as CSS custom properties at document root via `injectTokens()` at app boot. Reference them in CSS as `var(--ai-{category}-{name})`:

```css
.my-component {
  background: var(--ai-color-primary-500);
  color: var(--ai-color-neutral-0);
  padding: var(--ai-space-2) var(--ai-space-4);
  border-radius: var(--ai-radius-soft);
  transition: background var(--ai-time-fast) var(--ai-ease-easeOut);
}
```

### Primitive components (Commit 3)

`apps/web/src/ui/` — eight primitive components:

| Component | Purpose | Key variants |
|-----------|---------|--------------|
| `Button` | Actions | primary, secondary, ghost, danger × sm/md/lg |
| `Input` | Text input | with label, helper text, error state, prefix/suffix |
| `Modal` | Overlay dialog | sm/md/lg/xl sizes, focus trap, escape/backdrop close |
| `Card` | Content container | default, elevated, outlined × padding scale, interactive mode |
| `Badge` | Status indicator | success, warning, error, info, neutral |
| `Pill` | Rounded label | same variants as Badge, sm/md |
| `Wizard` | Multi-step flow | step indicator, footer nav, hideFooter for custom actions |
| `Toast` | Transient notification | Provider + useToast hook, 4 variants, auto-dismiss |

Each has a corresponding `.demo.tsx` file in `apps/web/src/ui/__demos__/`. The `/ui` route (or `?ui=demo` query param) renders all demos as a live components page — visit it to see the design system in action.

## When to use what

### Colors

- **Primary** — main brand color, use for primary actions (Button primary variant), links, focus states
- **Neutral** — backgrounds, text, borders. Use the shade appropriate for the context (dark: 700-950, medium: 400-600, light: 50-200)
- **Success/Warning/Error/Info** — semantic. Use for status indicators, validation, feedback. The `subtle_bg`/`subtle_fg` pairs are for Badge/Pill; the top-level values are for solid backgrounds like Button.danger

### Typography

- Use `xs` for micro text (badge labels, timestamps)
- Use `sm`-`base`-`md` for body text
- Use `lg`-`2xl` for headings
- Use `3xl`+ sparingly, for hero/marketing contexts

The token font-size scale (`--ai-text-*`) is defined in **px**, so component text sized via these tokens is px-based. Commit 2 deliberately left the pre-existing `index.css` font sizes as `rem` (rather than converting them to px) so legacy text still scales with the user's browser font-size preference; new components use the px token scale. Revisiting px-vs-rem for the token scale (so token-sized text also honors browser font-size preferences) is a future accessibility item.

### Spacing

4px scale — always use tokens, not arbitrary pixel values.

Common patterns:
- Card padding: `--ai-space-4` (medium) or `--ai-space-6` (large)
- Button padding: `--ai-space-2 --ai-space-3` (small) to `--ai-space-3 --ai-space-6` (large)
- Section gaps: `--ai-space-6` to `--ai-space-8`
- Icon gaps: `--ai-space-2`

### Radii

- `sharp` (2px) — subtle rounding for badges
- `soft` (4px) — default for inputs, buttons
- `md` (6px) — cards, panels
- `lg` (8px) — larger surfaces, modals
- `pill` (9999px) — pills, avatars

### Wizard hideFooter pattern

The `Wizard` primitive has a default footer with Back/Continue/Cancel buttons. Set `hideFooter={true}` when a step has its own primary action embedded in content (like "Test Connection" or "Send Message"). This was established by the WordPress + OpenClaw wizard refactors in Commits 4 + 5 and used by Auth0 wizard in Commit 9.

Rule of thumb:
- **Default footer:** Steps that are pure input collection or informational (Welcome, form input, confirmation)
- **hideFooter:** Steps that call an API on entry, steps with a single dominant primary action (Test, Send, Retry), success screens with custom next-step buttons

## Adding a new token

1. Add the value to the appropriate const in `tokens.ts`
2. The `generateTokenCss()` function will pick it up automatically since it iterates all keys of each category
3. Update this doc's "When to use what" section if it's non-obvious

## Adding a new primitive component

Before adding: check if you're really adding a primitive or a use-case-specific component.

- **Primitive candidate:** Reusable across 3+ features (e.g., Select, Radio group, Progress bar)
- **Use-case component:** Specific to one feature (e.g., IntegrationRow, ProjectCard) — build it in the feature folder, not in `ui/`

To add a primitive:
1. Create `apps/web/src/ui/YourComponent.tsx` + `YourComponent.css`
2. Export the props type
3. Consume tokens via CSS variables, no hardcoded values
4. Create `apps/web/src/ui/__demos__/YourComponent.demo.tsx` showing all variants
5. Register the demo in `UiDemoPage.tsx`
6. Update this doc's "Primitive components" table

## Accessibility floor

The Sprint 8 minimums:
- All interactive elements keyboard-accessible (Tab, Enter, Escape)
- Modal focus trap works on Tab + Shift+Tab
- Escape closes modals
- Buttons have proper `disabled` attribute, not just visual styling
- Inputs have `<label htmlFor>` association
- Color contrast: WCAG AA (4.5:1 for normal text) on the primary palette

Deferred to Sprint 9+:
- Screen reader announcements for toasts
- ARIA labels on icon-only buttons
- High contrast mode
- Reduced motion preference (`prefers-reduced-motion` media query)

## Dark mode

Currently: components handle dark mode via `@media (prefers-color-scheme: dark)` overrides at the component-CSS level. There's no explicit theme switcher.

Known tension: the app hard-codes `:root { background: #0b0c0f }` regardless of OS scheme. Full reconciliation (proper theme switcher, tokens with dark variants, respecting user preference) is deferred to a future dedicated sprint.

## Why not Tailwind

AI Connect uses hand-written CSS with CSS variables instead of Tailwind. Trade-offs:

**Pros:**
- No build dependency
- Tokens are source of truth; CSS reads from variables; type system protects token names
- No class-migration burden for existing components

**Cons:**
- More verbose than Tailwind for simple layouts
- Need to remember variable names (use the type helpers exported from `tokens.ts`)

The choice was made deliberately in Sprint 8 Commit 2. Sprint 9+ could revisit if a compelling reason emerges (utility-first team growth, third-party components that assume Tailwind, etc.).

## Source code reference

- Tokens: `apps/web/src/ui/tokens.ts`
- Injection: `apps/web/src/main.tsx` (calls `injectTokens()` before `createRoot`)
- Primitives: `apps/web/src/ui/{Button,Input,Modal,Card,Badge,Pill,Wizard,Toast}.tsx`
- Demos: `apps/web/src/ui/__demos__/`
- Live components page: navigate to `/ui` in dev, or use `?ui=demo` query param
- Wizard refactors (reference implementations): `apps/web/src/components/{WordPressWizard,OpenClawWizard,Auth0Wizard}.tsx`
