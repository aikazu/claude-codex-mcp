// Locate a Codex CLI executable that can be spawned WITHOUT a shell.
//
// On Windows, npm/pnpm/bun install `codex` as .cmd/.ps1 shims. Node refuses
// to spawn those without `shell: true`, and going through cmd.exe would mean
// quoting user prompts for cmd — a classic injection footgun. Instead we run
// the package's own JS launcher (`@openai/codex/bin/codex.js`) with the
// current Node binary, or a real `codex.exe` when one is on PATH (the Codex
// desktop installer ships one).

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const IS_WIN = process.platform === "win32";

const isFile = (p) => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

function viaJsLauncher(js) {
  return isFile(js) ? { command: process.execPath, prefixArgs: [js], source: js } : null;
}

/** Turn one candidate path into a spawnable launcher, or null. */
export function launcherFor(candidate, { windows = IS_WIN } = {}) {
  if (!candidate || !isFile(candidate)) return null;
  const ext = path.extname(candidate).toLowerCase();
  if (ext === ".js" || ext === ".mjs" || ext === ".cjs") return viaJsLauncher(candidate);
  if (windows && ext !== ".exe") {
    return viaJsLauncher(path.join(path.dirname(candidate), "node_modules", "@openai", "codex", "bin", "codex.js"));
  }
  return { command: candidate, prefixArgs: [], source: candidate };
}

function searchDirs() {
  const dirs = (process.env.PATH || process.env.Path || "").split(path.delimiter).filter(Boolean);
  if (IS_WIN) {
    if (process.env.LOCALAPPDATA) dirs.push(path.join(process.env.LOCALAPPDATA, "Programs", "OpenAI", "Codex", "bin"));
    if (process.env.APPDATA) dirs.push(path.join(process.env.APPDATA, "npm"));
  }
  dirs.push(path.join(os.homedir(), ".bun", "bin"));
  return dirs;
}

/** @param {string|null} explicit value of CODEX_BIN, if any */
export function resolveCodex(explicit) {
  if (explicit) {
    const l = launcherFor(explicit);
    if (l) return l;
    throw new Error(
      `CODEX_BIN=${explicit} is not runnable${IS_WIN ? " (on Windows point it at codex.exe or @openai/codex/bin/codex.js)" : ""}`,
    );
  }
  const names = IS_WIN ? ["codex.exe", "codex.cmd", "codex.ps1", "codex"] : ["codex"];
  for (const dir of searchDirs()) {
    for (const name of names) {
      const l = launcherFor(path.join(dir, name));
      if (l) return l;
    }
  }
  throw new Error(
    "Codex CLI not found. Install it (npm i -g @openai/codex), run `codex login`, or set CODEX_BIN to its path.",
  );
}

/** Run a short, non-interactive codex subcommand and capture its output. */
export function runCodexSync(launcher, args, { timeout = 30_000 } = {}) {
  const r = spawnSync(launcher.command, [...launcher.prefixArgs, ...args], {
    encoding: "utf8",
    windowsHide: true,
    timeout,
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    status: r.status,
    stdout: r.stdout || "",
    stderr: r.stderr || (r.error ? String(r.error.message) : ""),
  };
}
