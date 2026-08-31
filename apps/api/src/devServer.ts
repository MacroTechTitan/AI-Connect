// Local development entry point.
//
// Identical to src/index.ts except that it loads a gitignored .env file first,
// so `pnpm --filter @ai-connect/api dev` can point at the local staging
// database (docs/STAGING_DATABASE.md) without every developer exporting
// DATABASE_URL by hand.
//
// Production still runs `node dist/index.js` — this file is never on that path,
// and loadLocalEnv() is a no-op under NODE_ENV=production regardless.
//
// The dynamic import is load-bearing: ESM hoists static imports, so index.js
// (and through it lib/env.ts, which parses process.env at import time) must not
// be imported statically here.

import { loadLocalEnv } from "./lib/loadLocalEnv.js";

const loaded = loadLocalEnv();
process.stderr.write(
  loaded.file
    ? `[dev] env file loaded: ${loaded.file}\n`
    : `[dev] no env file loaded (${loaded.reason})\n`,
);

await import("./index.js");
