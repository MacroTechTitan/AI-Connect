/**
 * Design tokens for AI Connect.
 *
 * Source of truth for the visual language. Values defined here as
 * TypeScript constants AND injected as CSS custom properties at the
 * document root via injectTokens(). Components consume them as either
 * --ai-* CSS variables in their stylesheets, or as typed imports for
 * inline-style use cases (rare, prefer CSS).
 *
 * Adding a new token: add to the const here, add the corresponding
 * CSS variable to the injectTokens() output, update DESIGN_SYSTEM.md.
 */

// ============================================================
// Color palette
// ============================================================

export const colors = {
  // Brand
  primary: {
    50: '#eff6ff',
    100: '#dbeafe',
    200: '#bfdbfe',
    300: '#93c5fd',
    400: '#60a5fa',
    500: '#3b82f6',
    600: '#2563eb',
    700: '#1d4ed8',
    800: '#1e40af',
    900: '#1e3a8a',
  },

  // Neutrals
  neutral: {
    0: '#ffffff',
    50: '#fafafa',
    100: '#f4f4f5',
    200: '#e4e4e7',
    300: '#d4d4d8',
    400: '#a1a1aa',
    500: '#71717a',
    600: '#52525b',
    700: '#3f3f46',
    800: '#27272a',
    900: '#18181b',
    950: '#09090b',
  },

  // Semantic
  success: {
    bg: '#10b981',
    fg: '#ffffff',
    subtle_bg: '#d1fae5',
    subtle_fg: '#065f46',
  },
  warning: {
    bg: '#f59e0b',
    fg: '#ffffff',
    subtle_bg: '#fef3c7',
    subtle_fg: '#92400e',
  },
  error: {
    bg: '#ef4444',
    fg: '#ffffff',
    subtle_bg: '#fee2e2',
    subtle_fg: '#991b1b',
  },
  info: {
    bg: '#3b82f6',
    fg: '#ffffff',
    subtle_bg: '#dbeafe',
    subtle_fg: '#1e40af',
  },
} as const;

// ============================================================
// Typography
// ============================================================

export const typography = {
  fontFamily: {
    sans: '"Inter", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    mono: '"JetBrains Mono", ui-monospace, SFMono-Regular, "SF Mono", Consolas, monospace',
  },
  fontSize: {
    xs: '12px',
    sm: '13px',
    base: '14px',
    md: '15px',
    lg: '16px',
    xl: '18px',
    '2xl': '20px',
    '3xl': '24px',
    '4xl': '28px',
    '5xl': '34px',
  },
  lineHeight: {
    tight: '1.2',
    snug: '1.4',
    normal: '1.5',
    relaxed: '1.6',
    loose: '1.75',
  },
  fontWeight: {
    normal: '400',
    medium: '500',
    semibold: '600',
    bold: '700',
  },
} as const;

// ============================================================
// Spacing (4px base scale)
// ============================================================

export const spacing = {
  0: '0',
  px: '1px',
  0.5: '2px',
  1: '4px',
  1.5: '6px',
  2: '8px',
  2.5: '10px',
  3: '12px',
  4: '16px',
  5: '20px',
  6: '24px',
  7: '28px',
  8: '32px',
  10: '40px',
  12: '48px',
  16: '64px',
  20: '80px',
  24: '96px',
} as const;

// ============================================================
// Border radii
// ============================================================

export const radii = {
  none: '0',
  sharp: '2px',
  soft: '4px',
  md: '6px',
  lg: '8px',
  xl: '12px',
  '2xl': '16px',
  round: '24px',
  pill: '9999px',
  full: '50%',
} as const;

// ============================================================
// Shadows
// ============================================================

export const shadows = {
  none: 'none',
  sm: '0 1px 2px 0 rgb(0 0 0 / 0.05)',
  md: '0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)',
  lg: '0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)',
  xl: '0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1)',
  inset: 'inset 0 2px 4px 0 rgb(0 0 0 / 0.06)',
} as const;

// ============================================================
// Animation timings
// ============================================================

export const timings = {
  instant: '0ms',
  fast: '120ms',
  normal: '180ms',
  slow: '300ms',
  slower: '500ms',
} as const;

export const easings = {
  linear: 'linear',
  easeIn: 'cubic-bezier(0.4, 0, 1, 1)',
  easeOut: 'cubic-bezier(0, 0, 0.2, 1)',
  easeInOut: 'cubic-bezier(0.4, 0, 0.2, 1)',
} as const;

// ============================================================
// Z-index scale
// ============================================================

export const zIndex = {
  base: 0,
  raised: 10,
  dropdown: 100,
  sticky: 200,
  overlay: 1000,
  modal: 1100,
  toast: 1200,
  tooltip: 1300,
} as const;

// ============================================================
// CSS variable injection
// ============================================================

/**
 * Generates the CSS custom property declarations that map all tokens
 * to --ai-* variables at the document root. Called once at app boot
 * (in main.tsx). Returns the CSS string; the caller injects it as a
 * <style> tag in the document head.
 */
export function generateTokenCss(): string {
  const lines: string[] = [':root {'];

  // Colors
  for (const [scale, values] of Object.entries(colors)) {
    if (typeof values === 'object') {
      for (const [shade, value] of Object.entries(values)) {
        lines.push(`  --ai-color-${scale}-${shade}: ${value};`);
      }
    }
  }

  // Typography
  for (const [name, value] of Object.entries(typography.fontFamily)) {
    lines.push(`  --ai-font-${name}: ${value};`);
  }
  for (const [name, value] of Object.entries(typography.fontSize)) {
    lines.push(`  --ai-text-${name}: ${value};`);
  }
  for (const [name, value] of Object.entries(typography.lineHeight)) {
    lines.push(`  --ai-leading-${name}: ${value};`);
  }
  for (const [name, value] of Object.entries(typography.fontWeight)) {
    lines.push(`  --ai-weight-${name}: ${value};`);
  }

  // Spacing
  for (const [name, value] of Object.entries(spacing)) {
    const safeName = name.replace('.', '_');
    lines.push(`  --ai-space-${safeName}: ${value};`);
  }

  // Radii
  for (const [name, value] of Object.entries(radii)) {
    lines.push(`  --ai-radius-${name}: ${value};`);
  }

  // Shadows
  for (const [name, value] of Object.entries(shadows)) {
    lines.push(`  --ai-shadow-${name}: ${value};`);
  }

  // Timings + easings
  for (const [name, value] of Object.entries(timings)) {
    lines.push(`  --ai-time-${name}: ${value};`);
  }
  for (const [name, value] of Object.entries(easings)) {
    lines.push(`  --ai-ease-${name}: ${value};`);
  }

  // Z-index
  for (const [name, value] of Object.entries(zIndex)) {
    lines.push(`  --ai-z-${name}: ${value};`);
  }

  lines.push('}');
  return lines.join('\n');
}

/**
 * Injects token CSS variables into the document head. Idempotent —
 * safe to call multiple times. Use at app boot in main.tsx.
 */
export function injectTokens(): void {
  if (typeof document === 'undefined') return;

  const STYLE_ID = 'ai-connect-design-tokens';
  if (document.getElementById(STYLE_ID)) return;

  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = generateTokenCss();
  document.head.appendChild(style);
}

// ============================================================
// Type helpers
// ============================================================

export type ColorScale = keyof typeof colors;
export type SpacingKey = keyof typeof spacing;
export type RadiusKey = keyof typeof radii;
export type ShadowKey = keyof typeof shadows;
