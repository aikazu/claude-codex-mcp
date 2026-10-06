// Job lifecycle for `codex exec` runs: queue → running → completed | failed | cancelled.
//
// Every run is non-blocking. Tool calls wait up to `wait_seconds` and then hand
// back a job_id, so long Codex turns never trip an MCP client's request timeout.

import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const IS_WIN = process.platform === "win32";
const IMAGE_PATH_RE = /[A-Za-z]:[\\/][^\s"'<>|*?]+?\.(?:png|jpe?g|webp|gif)|\/[^\s"'<>|*?]+?\.(?:png|jpe?g|webp|gif)/gi;

export const tail = (s, n = 4000) => (s.length > n ? `…${s.slice(-n)}` : s);

function collectStrings(value, out = []) {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) collectStrings(v, out);
  else if (value && typeof value === "object") for (const v of Object.values(value)) collectStrings(v, out);
  return out;
}

/** Fold one `codex exec --json` event into the job record. Pure; exported for tests. */
export function applyEvent(job, ev) {
  switch (ev?.type) {
    case "thread.started":
      if (ev.thread_id) job.sessionId = ev.thread_id;
      break;
    case "item.completed":
      if (ev.item?.type === "agent_message" && ev.item.text) job.messages.push(ev.item.text);
      break;
    case "turn.completed":
      if (ev.usage) job.usage = ev.usage;
      break;
    case "turn.failed":
    case "thread.failed":
      job.errors.push(ev.error?.message || JSON.stringify(ev));
      break;
    case "error":
      if (ev.message) job.errors.push(ev.message);
      break;
  }
  for (const s of collectStrings(ev)) {
    for (const m of s.matchAll(IMAGE_PATH_RE)) {
      if (/generated_images/i.test(m[0])) job.mentionedPaths.add(m[0]);
    }
  }
}

export class JobManager {
  /**
   * @param {object} opts
   * @param {() => {command:string, prefixArgs:string[]}} opts.launcher
   * @param {{maxConcurrentTasks:number, maxConcurrentImages:number, jobHistory:number}} opts.config
   * @param {(msg:string)=>void} [opts.log]
   */
  constructor({ launcher, config, log = () => {} }) {
    this.launcher = launcher;
    this.config = config;
    this.log = log;
    this.jobs = new Map();
    this.queue = [];
  }

  limitFor(kind) {
    return kind === "image" ? this.config.maxConcurrentImages : this.config.maxConcurrentTasks;
  }

  running(kind) {
    let n = 0;
    for (const j of this.jobs.values()) if (j.kind === kind && j.status === "running") n++;
    return n;
  }

  /** Register a job and start it as soon as a slot for its kind is free. */
  submit({ kind, args, cwd, prompt, meta = {}, onStart, onFinish }) {
    // Resolve the binary eagerly so a missing Codex fails the tool call itself.
    const launcher = this.launcher();
    const job = {
      id: crypto.randomBytes(4).toString("hex"),
      kind,
      args,
      cwd,
      prompt,
      meta,
      onStart,
      onFinish,
      launcher,
      status: "queued",
      createdAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      sessionId: meta.resumeOf || null,
      messages: [],
      finalMessage: "",
      usage: null,
      errors: [],
      warnings: [],
      stderr: "",
      mentionedPaths: new Set(),
      files: [],
      exitCode: null,
    };
    job.done = new Promise((resolve) => {
      job.resolveDone = resolve;
    });
    this.jobs.set(job.id, job);
    this.queue.push(job);
    this.prune();
    this.pump();
    return job;
  }

  pump() {
    for (let i = 0; i < this.queue.length; ) {
      const job = this.queue[i];
      if (this.running(job.kind) < this.limitFor(job.kind)) {
        this.queue.splice(i, 1);
        this.start(job);
      } else i++;
    }
  }

  start(job) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mcp-"));
    const outFile = path.join(tmpDir, "last-message.txt");
    job.status = "running";
    job.startedAt = Date.now();
    try {
      job.onStart?.(job);
    } catch (e) {
      job.warnings.push(`pre-processing: ${e.message}`);
    }
    this.log(`job ${job.id} (${job.kind}) start: codex ${job.args.join(" ")}`);

    let child;
    try {
      child = spawn(job.launcher.command, [...job.launcher.prefixArgs, ...job.args, "-o", outFile], {
        cwd: job.cwd,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env: { ...process.env, NO_COLOR: "1" },
      });
    } catch (err) {
      job.errors.push(`spawn failed: ${err.message}`);
      this.finish(job, null, tmpDir, outFile);
      return;
    }
    job.child = child;

    readline.createInterface({ input: child.stdout }).on("line", (line) => {
      try {
        applyEvent(job, JSON.parse(line));
      } catch {
        /* non-JSON noise */
      }
    });
    child.stderr.on("data", (d) => {
      job.stderr = tail(job.stderr + d.toString(), 8000);
    });
    child.on("error", (err) => job.errors.push(`spawn failed: ${err.message}`));
    child.on("close", (code) => this.finish(job, code, tmpDir, outFile));

    // The prompt travels over stdin: no positional argument (so variadic
    // flags such as -i stay unambiguous) and no shell quoting, ever.
    child.stdin.on("error", () => {});
    child.stdin.end(job.prompt);
  }

  async finish(job, code, tmpDir, outFile) {
    job.exitCode = code;
    try {
      const last = fs.readFileSync(outFile, "utf8").trim();
      if (last) job.finalMessage = last;
    } catch {
      /* no last message written */
    }
    fs.rm(tmpDir, { recursive: true, force: true }, () => {});
    if (!job.finalMessage) job.finalMessage = job.messages.at(-1) || "";
    if (job.status !== "cancelled" && job.onFinish) {
      try {
        await job.onFinish(job);
      } catch (e) {
        job.errors.push(`post-processing: ${e.message}`);
      }
    }
    if (job.status === "running") job.status = code === 0 && job.errors.length === 0 ? "completed" : "failed";
    job.finishedAt = Date.now();
    job.child = undefined;
    this.log(`job ${job.id} ${job.status} (exit ${code})`);
    job.resolveDone(job);
    this.pump();
  }

  get(id) {
    return this.jobs.get(String(id || ""));
  }

  list() {
    return [...this.jobs.values()];
  }

  cancel(job) {
    if (job.status === "queued") {
      this.queue = this.queue.filter((j) => j !== job);
      job.status = "cancelled";
      job.finishedAt = Date.now();
      job.resolveDone(job);
      return true;
    }
    if (job.status !== "running" || !job.child) return false;
    job.status = "cancelled";
    const pid = job.child.pid;
    // On Windows the Node launcher would not forward a kill to codex.exe, so
    // end the whole process tree of this job (and only this job).
    if (IS_WIN && pid) spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
    else job.child.kill("SIGTERM");
    return true;
  }

  cancelAll() {
    for (const j of this.jobs.values()) this.cancel(j);
  }

  /** Wait up to `seconds` for the job; calls onTick every ~3 s while waiting. */
  async wait(job, seconds, onTick) {
    const ms = Math.max(0, seconds) * 1000;
    if (job.status === "completed" || job.status === "failed" || job.status === "cancelled" || ms === 0) return job;
    const deadline = Date.now() + ms;
    while (Date.now() < deadline && !job.finishedAt) {
      const slice = Math.min(3000, deadline - Date.now());
      let timer;
      await Promise.race([job.done, new Promise((r) => (timer = setTimeout(r, slice)))]);
      clearTimeout(timer);
      if (!job.finishedAt && onTick) onTick(job);
    }
    return job;
  }

  prune() {
    if (this.jobs.size <= this.config.jobHistory) return;
    for (const [id, j] of this.jobs) {
      if (j.finishedAt) {
        this.jobs.delete(id);
        if (this.jobs.size <= this.config.jobHistory) break;
      }
    }
  }
}
