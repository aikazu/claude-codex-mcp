// Runtime configuration, read once from the environment.
// CODEX_MCP_* is the current prefix; CODEX_BRIDGE_* is accepted for installs
// made before the project was renamed.

import os from "node:os";
import path from "node:path";

const env = (name) => process.env[`CODEX_MCP_${name}`] ?? process.env[`CODEX_BRIDGE_${name}`];

const clampInt = (raw, fallback, min, max) => {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

export const SANDBOXES = Object.freeze(["read-only", "workspace-write"]);
export const MAX_WAIT_SECONDS = 240;

export function loadConfig() {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const sandbox = env("SANDBOX");
  return Object.freeze({
    codexBin: process.env.CODEX_BIN || null,
    codexHome,
    generatedImagesDir: path.join(codexHome, "generated_images"),
    defaultSandbox: SANDBOXES.includes(sandbox) ? sandbox : "workspace-write",
    assetDir: env("ASSET_DIR") || path.join(os.homedir(), "Pictures", "codex-assets"),
    defaultWaitSeconds: clampInt(env("WAIT") ?? env("WAIT_SECONDS"), 50, 0, MAX_WAIT_SECONDS),
    maxConcurrentTasks: clampInt(env("MAX_TASKS"), 3, 1, 16),
    // Images are attributed by scanning $CODEX_HOME/generated_images, so they
    // run one at a time unless the user explicitly opts into more.
    maxConcurrentImages: clampInt(env("MAX_IMAGES"), 1, 1, 8),
    previewMaxBytes: clampInt(env("PREVIEW_MAX_BYTES"), 1_500_000, 0, 20_000_000),
    previewMaxCount: clampInt(env("PREVIEW_MAX_COUNT"), 4, 0, 8),
    jobHistory: 50,
  });
}
