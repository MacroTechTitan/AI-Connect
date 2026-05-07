# SKILL: Cache Busting for Vercel + Vite SPA

## The Problem
After deploying to Vercel users see old content
even after a hard refresh. Browser and CDN cache
serve stale JS bundles.

## Root Cause
Two separate caching layers:
1. Browser caches index.html and JS bundles
2. Vercel CDN caches all static files

## The Complete Fix

### 1. vercel.json — Cache Headers

```json
{
  "headers": [
    {
      "source": "/assets/(.*)",
      "headers": [
        {
          "key": "Cache-Control",
          "value": "public, max-age=31536000, immutable"
        }
      ]
    },
    {
      "source": "/index.html",
      "headers": [
        {
          "key": "Cache-Control",
          "value": "no-cache, no-store, must-revalidate"
        },
        { "key": "Pragma", "value": "no-cache" },
        { "key": "Expires", "value": "0" }
      ]
    },
    {
      "source": "/(.*)",
      "headers": [
        {
          "key": "Cache-Control",
          "value": "no-cache, no-store, must-revalidate"
        }
      ]
    }
  ]
}
```

**Why this works:**
- `/assets/*` → immutable forever (content-hashed filenames)
- `/index.html` → never cached (always fresh)
- `/*` → no cache for HTML pages

### 2. vite.config.ts — Content-Hashed Filenames

```typescript
build: {
  rollupOptions: {
    output: {
      entryFileNames: `assets/[name]-[hash]-${Date.now()}.js`,
      chunkFileNames: `assets/[name]-[hash]-${Date.now()}.js`,
    }
  }
}
```

The timestamp + hash guarantees a unique filename
on every build. Browser never serves stale JS.

### 3. How to verify it's working

After deploying check the bundle filename:
```
dist/public/assets/index-BIt18DpU-1777050972274.js
                              ^^^^ hash  ^^^^^^^^^^ timestamp
```

Different timestamp = fresh build = no cache issues.

### 4. Force fresh in browser (during development)

Chrome DevTools → Network tab → check 
"Disable cache" while DevTools is open.

Or in incognito: Cmd+Shift+R (Mac) / Ctrl+Shift+R (Win)

### 5. Purge Vercel CDN cache

Vercel dashboard → Deployments → click latest → 
"Redeploy" with "Clear Cache" checkbox checked.

## Why NOT to use these approaches

❌ Don't use query strings (?v=123) — breaks immutable caching
❌ Don't use ETags alone — still requires round trip
❌ Don't rely on browser refresh — CDN ignores it
❌ Don't set short max-age on assets — defeats caching purpose

## The Golden Rule

```
index.html → NEVER cache (no-store)
/assets/*  → ALWAYS cache forever (immutable)
/api/*     → NEVER cache (no-store)
```

Assets are safe to cache forever because Vite
content-hashes every filename. If content changes,
filename changes, browser fetches fresh copy.

## Quick Fix Checklist

When users report seeing old content:
1. Check vercel.json has the headers above ✓
2. Check vite.config.ts has timestamp in filename ✓  
3. Redeploy with cache cleared in Vercel ✓
4. Tell users to open incognito window ✓
5. If still stale → check Vercel deployment is Current ✓
