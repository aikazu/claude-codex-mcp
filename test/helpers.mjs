import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CLI = path.join(root, "src", "cli.mjs");
export const FIXTURES = path.join(root, "test", "fixtures");
export const FAKE_CODEX = path.join(FIXTURES, "fake-codex.mjs");

export function tempDir(prefix = "ccm-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** A sandboxed environment: fake codex, private CODEX_HOME and asset dir. */
export function makeEnv(extra = {}) {
  const base = tempDir();
  const env = {
    ...process.env,
    CODEX_BIN: FAKE_CODEX,
    CODEX_HOME: path.join(base, "codex-home"),
    CODEX_MCP_ASSET_DIR: path.join(base, "assets"),
    FAKE_CODEX_LOG: path.join(base, "calls.jsonl"),
    ...extra,
  };
  fs.mkdirSync(env.CODEX_HOME, { recursive: true });
  const project = path.join(base, "project");
  fs.mkdirSync(project);
  return {
    env,
    base,
    project,
    calls: () =>
      fs.existsSync(env.FAKE_CODEX_LOG)
        ? fs.readFileSync(env.FAKE_CODEX_LOG, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse)
        : [],
  };
}

/** Spawn the server and talk MCP to it. */
export class Client {
  constructor(env) {
    this.proc = spawn(process.execPath, [CLI], { env, stdio: ["pipe", "pipe", "pipe"] });
    this.nextId = 1;
    this.pending = new Map();
    this.notifications = [];
    this.stderr = "";
    this.proc.stderr.on("data", (d) => {
      this.stderr += d;
    });
    readline.createInterface({ input: this.proc.stdout }).on("line", (line) => {
      const msg = JSON.parse(line);
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        this.pending.get(msg.id)(msg);
        this.pending.delete(msg.id);
      } else this.notifications.push(msg);
    });
  }

  request(method, params = {}) {
    const id = this.nextId++;
    this.proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return new Promise((resolve) => this.pending.set(id, resolve));
  }

  async init() {
    const r = await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    });
    this.proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    return r.result;
  }

  async call(name, args = {}, meta) {
    const params = { name, arguments: args };
    if (meta) params._meta = meta;
    const r = await this.request("tools/call", params);
    const result = r.result;
    const text = result.content.find((c) => c.type === "text")?.text ?? "";
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { ...result, text, json, images: result.content.filter((c) => c.type === "image") };
  }

  close() {
    this.proc.stdin.end();
    return new Promise((resolve) => this.proc.on("close", resolve));
  }
}
