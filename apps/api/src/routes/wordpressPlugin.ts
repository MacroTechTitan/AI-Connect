import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ZipArchive } from "archiver";
import type { Express, Request, Response } from "express";

import { logger } from "../lib/logger.js";
import { requireAuth, requireHydratedUser } from "../middleware/requireAuth.js";

// The PHP plugin lives at the repo root (wp-plugin/ai-connect), four levels up
// from this module whether it runs from src/ (tsx dev) or dist/ (built). We zip
// it on the fly so the download always tracks whatever is committed — no build
// step bakes a stale copy.
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = resolve(MODULE_DIR, "../../../../wp-plugin/ai-connect");

async function handlePluginZip(_req: Request, res: Response): Promise<void> {
  if (!existsSync(PLUGIN_DIR)) {
    logger.error({ pluginDir: PLUGIN_DIR }, "wordpress plugin dir not found");
    res.status(500).json({ error: "plugin_source_unavailable" });
    return;
  }

  res.setHeader("Content-Type", "application/zip");
  res.setHeader(
    "Content-Disposition",
    'attachment; filename="ai-connect.zip"',
  );

  const archive = new ZipArchive({ zlib: { level: 9 } });

  archive.on("warning", (err) => {
    logger.warn({ err }, "archiver warning building plugin zip");
  });
  archive.on("error", (err) => {
    logger.error({ err }, "archiver error building plugin zip");
    // Headers are likely already sent once streaming starts; just tear down.
    if (!res.headersSent) {
      res.status(500).json({ error: "zip_failed" });
    } else {
      res.destroy(err);
    }
  });

  archive.pipe(res);
  // Nest under ai-connect/ so the unzipped folder matches WordPress's expected
  // plugin directory layout (wp-content/plugins/ai-connect/ai-connect.php).
  archive.directory(PLUGIN_DIR, "ai-connect");
  await archive.finalize();
}

export function registerWordPressPluginRoutes(app: Express): void {
  app.get(
    "/api/integrations/wordpress/plugin.zip",
    requireAuth,
    requireHydratedUser,
    (req, res) => void handlePluginZip(req, res),
  );
}
