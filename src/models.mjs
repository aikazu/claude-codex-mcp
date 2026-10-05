// Model catalog and the user's configured defaults.

import fs from "node:fs";
import path from "node:path";
import { runCodexSync } from "./codex-bin.mjs";

/** Read top-level `model` / `model_reasoning_effort` from config.toml (before any [table]). */
export function configuredDefaults(codexHome) {
  const out = {};
  try {
    const toml = fs.readFileSync(path.join(codexHome, "config.toml"), "utf8");
    const top = toml.split(/^\s*\[/m)[0];
    const model = top.match(/^\s*model\s*=\s*"([^"]+)"/m);
    const effort = top.match(/^\s*model_reasoning_effort\s*=\s*"([^"]+)"/m);
    if (model) out.model = model[1];
    if (effort) out.reasoning_effort = effort[1];
  } catch {
    /* no config.toml */
  }
  return out;
}

export function normalizeCatalog(data, { includeHidden = false } = {}) {
  const models = Array.isArray(data) ? data : data?.models || [];
  return models
    .filter((m) => m && (includeHidden || m.visibility !== "hide"))
    .map((m) => ({
      model: m.slug ?? m.id,
      name: m.display_name,
      description: m.description,
      reasoning_efforts: (m.supported_reasoning_levels || []).map((l) => (typeof l === "string" ? l : l.effort)),
      default_effort: m.default_reasoning_level,
    }));
}

/** `codex debug models` (live, refreshed for the account) with a bundled fallback. */
export function listModels(launcher, codexHome, { includeHidden = false } = {}) {
  let r = runCodexSync(launcher, ["debug", "models"]);
  let catalog = "live";
  if (r.status !== 0) {
    r = runCodexSync(launcher, ["debug", "models", "--bundled"]);
    catalog = "bundled (live refresh failed)";
  }
  if (r.status !== 0) throw new Error(`codex debug models failed: ${r.stderr.slice(-500)}`);
  return {
    catalog,
    configured_default: configuredDefaults(codexHome),
    models: normalizeCatalog(JSON.parse(r.stdout), { includeHidden }),
  };
}
