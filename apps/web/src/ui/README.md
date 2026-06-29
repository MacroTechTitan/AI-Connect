# AI Connect Design Tokens

This directory contains the design tokens that drive AI Connect's visual language. Tokens are TypeScript constants in `tokens.ts` that are injected as CSS custom properties at the document root at app boot.

## Why CSS variables, not Tailwind

AI Connect uses hand-written CSS with CSS variables instead of a utility-class framework. Trade-offs:
- ✅ No build dependency, no migration overhead
- ✅ Tokens are source of truth; CSS reads from variables; type system protects token names
- ✅ Components can be styled in component-adjacent .css files or in index.css
- ❌ More verbose than Tailwind for simple layouts
- ❌ Need to remember the variable names (use the type helpers exported from tokens.ts)

## Using tokens in CSS

Reference any token via `var(--ai-{category}-{name})`:

```css
.button {
  background: var(--ai-color-primary-500);
  color: var(--ai-color-neutral-0);
  padding: var(--ai-space-2) var(--ai-space-4);
  border-radius: var(--ai-radius-soft);
  font-family: var(--ai-font-sans);
  font-size: var(--ai-text-base);
  transition: background var(--ai-time-fast) var(--ai-ease-easeOut);
}

.button:hover {
  background: var(--ai-color-primary-600);
}
```

## Using tokens in TypeScript (when CSS isn't enough)

```typescript
import { spacing, colors } from './tokens';

const inlineStyle = {
  padding: spacing[4],
  background: colors.primary[500],
};
```

Avoid this pattern when CSS works — keeps style logic out of components.

## Adding a new token

1. Add the value to the appropriate const in `tokens.ts`
2. The injection function will pick it up automatically (no need to update generateTokenCss explicitly if the new value is added to an existing category object)
3. Update DESIGN_SYSTEM.md (Sprint 8 Commit 11) with usage guidance

## Token categories

- `colors.{primary|neutral|success|warning|error|info}.{shade}` → `--ai-color-{cat}-{shade}`
- `typography.{fontFamily|fontSize|lineHeight|fontWeight}.{name}` → `--ai-font-{name}`, `--ai-text-{name}`, `--ai-leading-{name}`, `--ai-weight-{name}`
- `spacing.{0..24}` → `--ai-space-{n}`
- `radii.{name}` → `--ai-radius-{name}`
- `shadows.{name}` → `--ai-shadow-{name}`
- `timings.{instant|fast|normal|slow|slower}` → `--ai-time-{name}`
- `easings.{linear|easeIn|easeOut|easeInOut}` → `--ai-ease-{name}`
- `zIndex.{base|raised|dropdown|sticky|overlay|modal|toast|tooltip}` → `--ai-z-{name}`
