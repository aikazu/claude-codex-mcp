#!/usr/bin/env node
// Register (or remove) claude-codex-mcp in Claude Desktop and Claude Code.
//
//   node scripts/register.mjs [--uninstall] [--dry-run] [--name codex]
//                             [--asset-dir <dir>] [--sandbox workspace-write|read-only]
//                             [--task-model <slug>] [--task-effort <effort>]
//                             [--image-model <slug>] [--image-effort <effort>]
//
// Claude Desktop: adds an entry to every claude_desktop_config.json it finds
// (standard and Microsoft Store locations), after writing a timestamped backup.
// Claude Code: `claude mcp add <name> -s user …` when the CLI is installed.
// Absolute paths are pinned for node and codex because GUI apps often launch
// MCP servers with a minimal PATH.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCodex, runCodexSync } from "../src/codex-bin.mjs";

const IS_WIN = process.platform === "win32";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = path.join(ROOT, "src", "cli.mjs");

const DEFAULT_FLAGS = {
  "--task-model": "CODEX_MCP_TASK_MODEL",
  "--task-effort": "CODEX_MCP_TASK_EFFORT",
  "--image-model": "CODEX_MCP_IMAGE_MODEL",
  "--image-effort": "CODEX_MCP_IMAGE_EFFORT",
};

function parseArgs(argv) {
  const opts = { uninstall: false, dryRun: false, name: "codex", assetDir: null, sandbox: null, defaults: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--uninstall") opts.uninstall = true;
    else if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--name") opts.name = argv[++i];
    else if (a === "--asset-dir") opts.assetDir = path.resolve(argv[++i]);
    else if (a === "--sandbox") opts.sandbox = argv[++i];
    else if (Object.hasOwn(DEFAULT_FLAGS, a)) opts.defaults[DEFAULT_FLAGS[a]] = argv[++i];
    else if (a === "--help" || a === "-h") {
      console.log(
        fs
          .readFileSync(fileURLToPath(import.meta.url), "utf8")
          .split("\n")
          .slice(1, 14)
          .join("\n"),
      );
      process.exit(0);
    } else throw new Error(`Unknown option: ${a}`);
  }
  if (!/^[\w-]+$/.test(opts.name)) throw new Error(`Invalid --name: ${opts.name}`);
  if (opts.sandbox && !["workspace-write", "read-only"].includes(opts.sandbox))
    throw new Error("--sandbox must be workspace-write or read-only");
  for (const [key, value] of Object.entries(opts.defaults)) {
    const valid = key.endsWith("_MODEL") ? /^[\w.:/-]+$/ : /^[a-z]+$/;
    if (!valid.test(value ?? "")) throw new Error(`Invalid value for ${key}: ${value}`);
  }
  return opts;
}

const say = (s = "") => console.log(s);
const color = (code, s) => (process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const ok = (s) => say(color("32", `✓ ${s}`));
const warn = (s) => say(color("33", `! ${s}`));

function desktopConfigPaths() {
  const home = os.homedir();
  const dirs = [];
  if (IS_WIN) {
    if (process.env.APPDATA) dirs.push(path.join(process.env.APPDATA, "Claude"));
    const pkgs = process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Packages");
    if (pkgs && fs.existsSync(pkgs)) {
      for (const d of fs.readdirSync(pkgs)) {
        if (d.startsWith("Claude_")) dirs.push(path.join(pkgs, d, "LocalCache", "Roaming", "Claude"));
      }
    }
  } else if (process.platform === "darwin") {
    dirs.push(path.join(home, "Library", "Application Support", "Claude"));
  } else {
    dirs.push(path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "Claude"));
  }
  return dirs.filter((d) => fs.existsSync(d)).map((d) => path.join(d, "claude_desktop_config.json"));
}

function findOnPath(names) {
  const dirs = (process.env.PATH || process.env.Path || "").split(path.delimiter).filter(Boolean);
  dirs.push(path.join(os.homedir(), ".local", "bin"));
  for (const d of dirs) for (const n of names) if (fs.existsSync(path.join(d, n))) return path.join(d, n);
  return null;
}

function updateDesktop(file, entry, opts) {
  const raw = fs.existsSync(file) ? fs.readFileSync(file, "utf8").replace(/^﻿/, "") : "";
  let cfg = {};
  if (raw.trim()) {
    try {
      cfg = JSON.parse(raw);
    } catch (e) {
      warn(`${file} is not valid JSON (${e.message}) — left untouched`);
      return;
    }
  }
  cfg.mcpServers ??= {};
  const had = Object.hasOwn(cfg.mcpServers, opts.name);
  if (opts.uninstall) {
    if (!had) return say(`  ${file}: no "${opts.name}" entry`);
    delete cfg.mcpServers[opts.name];
  } else {
    cfg.mcpServers[opts.name] = entry;
  }
  const next = `${JSON.stringify(cfg, null, 2)}\n`;
  if (opts.dryRun) {
    say(`  [dry-run] would write ${file}:`);
    say(next.replace(/^/gm, "    "));
    return;
  }
  if (raw.trim()) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    fs.copyFileSync(file, `${file}.bak-${stamp}`);
  }
  fs.writeFileSync(file, next, "utf8");
  ok(`${opts.uninstall ? "Removed from" : had ? "Updated in" : "Added to"} ${file}`);
}

function updateClaudeCode(env, opts) {
  const claude = findOnPath(IS_WIN ? ["claude.exe"] : ["claude"]);
  if (!claude) {
    const shim = IS_WIN && findOnPath(["claude.cmd"]);
    warn(
      shim ? "Claude Code found only as a .cmd shim — register it manually:" : "Claude Code CLI not found — skipped.",
    );
    if (shim && !opts.uninstall) {
      const envArgs = Object.entries(env).map(([k, v]) => `-e ${k}="${v}"`);
      say(`  claude mcp add ${opts.name} -s user ${envArgs.join(" ")} -- "${process.execPath}" "${SERVER}"`);
    }
    return;
  }
  const run = (args) => spawnSync(claude, args, { encoding: "utf8", windowsHide: true });
  if (opts.dryRun) {
    say(`  [dry-run] would run: ${claude} mcp remove ${opts.name} -s user`);
    if (!opts.uninstall)
      say(`  [dry-run] would run: ${claude} mcp add ${opts.name} -s user … -- ${process.execPath} ${SERVER}`);
    return;
  }
  run(["mcp", "remove", opts.name, "-s", "user"]);
  if (opts.uninstall) return ok("Removed from Claude Code");
  const envArgs = Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  const r = run(["mcp", "add", opts.name, "-s", "user", ...envArgs, "--", process.execPath, SERVER]);
  if (r.status === 0) ok(`Registered in Claude Code (user scope) as "${opts.name}"`);
  else warn(`claude mcp add failed: ${(r.stderr || r.stdout).trim()}`);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  say(color("1", `claude-codex-mcp — ${opts.uninstall ? "uninstall" : "install"}${opts.dryRun ? " (dry run)" : ""}`));
  say(`  server: ${SERVER}`);
  say(`  node:   ${process.execPath}`);

  const env = {};
  if (!opts.uninstall) {
    const launcher = resolveCodex(process.env.CODEX_BIN || null);
    env.CODEX_BIN = launcher.source;
    say(`  codex:  ${launcher.source}`);
    const login = runCodexSync(launcher, ["login", "status"]);
    const text = (login.stdout + login.stderr).trim();
    if (login.status === 0) ok(`Codex login: ${text}`);
    else
      warn(`Codex is not logged in (${text || `exit ${login.status}`}). Run \`codex login\` before using the tools.`);
    if (opts.assetDir) env.CODEX_MCP_ASSET_DIR = opts.assetDir;
    if (opts.sandbox) env.CODEX_MCP_SANDBOX = opts.sandbox;
    Object.assign(env, opts.defaults);
  }
  say();

  const entry = { command: process.execPath, args: [SERVER], env };
  const configs = desktopConfigPaths();
  if (configs.length === 0)
    warn("Claude Desktop config folder not found — skipped (open Claude Desktop once, then rerun).");
  for (const file of configs) updateDesktop(file, entry, opts);
  updateClaudeCode(env, opts);

  if (!opts.uninstall && !opts.dryRun) {
    say();
    say(
      "Next: fully quit Claude Desktop (tray/menu bar → Quit) and reopen it. In Claude Code, start a new session or run /mcp.",
    );
  }
}

try {
  main();
} catch (e) {
  console.error(color("31", `✗ ${e.message}`));
  process.exit(1);
}
