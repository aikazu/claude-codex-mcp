import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { launcherFor } from "../src/codex-bin.mjs";
import { buildImagePrompt, slug } from "../src/images.mjs";
import { applyEvent } from "../src/jobs.mjs";
import { normalizeCatalog } from "../src/models.mjs";
import {
  diagnoseSandboxLock,
  findLockingProcesses,
  isSandboxSetupFailure,
  lastLockedFile,
  parseProcessList,
  sandboxFailureInEvent,
  sandboxFailureInStderr,
  sandboxFailureMessage,
} from "../src/sandbox.mjs";
import { buildImageArgs, buildTaskArgs } from "../src/tools.mjs";
import { FIXTURES, tempDir } from "./helpers.mjs";

const blankJob = () => ({ sessionId: null, messages: [], usage: null, errors: [], mentionedPaths: new Set() });

describe("applyEvent", () => {
  test("tracks thread id, agent messages, usage and errors", () => {
    const job = blankJob();
    applyEvent(job, { type: "thread.started", thread_id: "t1" });
    applyEvent(job, { type: "item.completed", item: { type: "reasoning", text: "hmm" } });
    applyEvent(job, { type: "item.completed", item: { type: "agent_message", text: "hello" } });
    applyEvent(job, { type: "turn.completed", usage: { input_tokens: 1 } });
    applyEvent(job, { type: "turn.failed", error: { message: "limit" } });
    applyEvent(job, { type: "error", message: "boom" });
    assert.equal(job.sessionId, "t1");
    assert.deepEqual(job.messages, ["hello"]);
    assert.deepEqual(job.usage, { input_tokens: 1 });
    assert.deepEqual(job.errors, ["limit", "boom"]);
  });

  test("picks up generated image paths on Windows and POSIX", () => {
    const job = blankJob();
    applyEvent(job, {
      type: "item.completed",
      item: { saved_path: "C:\\Users\\me\\.codex\\generated_images\\t1\\ig_0.png" },
    });
    applyEvent(job, { type: "x", nested: ["see /home/me/.codex/generated_images/t1/ig_1.webp now"] });
    applyEvent(job, { type: "x", text: "/tmp/unrelated.png" });
    assert.deepEqual(
      [...job.mentionedPaths],
      ["C:\\Users\\me\\.codex\\generated_images\\t1\\ig_0.png", "/home/me/.codex/generated_images/t1/ig_1.webp"],
    );
  });
});

describe("launcherFor", () => {
  test("runs npm .cmd shims through the package's JS launcher on Windows", () => {
    const dir = tempDir();
    const shim = path.join(dir, "codex.cmd");
    const js = path.join(dir, "node_modules", "@openai", "codex", "bin", "codex.js");
    fs.mkdirSync(path.dirname(js), { recursive: true });
    fs.writeFileSync(shim, "@echo off");
    fs.writeFileSync(js, "");
    const l = launcherFor(shim, { windows: true });
    assert.equal(l.command, process.execPath);
    assert.deepEqual(l.prefixArgs, [js]);
  });

  test("rejects a Windows shim without its JS launcher, accepts .exe and .js", () => {
    const dir = tempDir();
    const shim = path.join(dir, "codex.cmd");
    const exe = path.join(dir, "codex.exe");
    const js = path.join(dir, "codex.js");
    for (const f of [shim, exe, js]) fs.writeFileSync(f, "");
    assert.equal(launcherFor(shim, { windows: true }), null);
    assert.deepEqual(launcherFor(exe, { windows: true }), { command: exe, prefixArgs: [], source: exe });
    assert.equal(launcherFor(js).command, process.execPath);
    assert.equal(launcherFor(path.join(dir, "missing")), null);
  });
});

describe("helpers", () => {
  test("slug", () => {
    assert.equal(slug("Gold Coin — Icon!!"), "gold-coin-icon");
    assert.equal(slug("ÉLAN vital"), "elan-vital");
    assert.equal(slug("???"), "asset");
    assert.ok(slug("x".repeat(100)).length <= 40);
  });

  test("buildImagePrompt", () => {
    const p = buildImagePrompt({ brief: "a fox", count: 2, size: "16:9", transparent: true, referenceCount: 1 });
    assert.match(p, /^\$imagegen /);
    assert.match(p, /create 2 images/);
    assert.match(p, /Size \/ aspect ratio: 16:9/);
    assert.match(p, /transparent/);
    assert.match(p, /1 reference image/);
    assert.doesNotMatch(buildImagePrompt({ brief: "a", count: 1 }), /transparent|reference|Size/);
  });

  test("turns off the desktop app's REPL MCP servers on Windows only", () => {
    const dir = tempDir();
    const off = (args) => args.filter((x) => x.startsWith("mcp_servers.")).sort();
    const expected = [
      'mcp_servers.cua_repl={command="disabled",enabled=false}',
      'mcp_servers.node_repl={command="disabled",enabled=false}',
    ];
    const sessions = { lookup: () => ({ cwd: dir, addDirs: [] }) };
    for (const windows of [true, false]) {
      const config = { windows, defaultSandbox: "read-only", assetDir: dir };
      const want = windows ? expected : [];
      assert.deepEqual(off(buildTaskArgs({ prompt: "x", cwd: dir }, config).args), want);
      assert.deepEqual(off(buildTaskArgs({ prompt: "x", session_id: "abc" }, config, sessions).args), want);
      assert.deepEqual(off(buildImageArgs({ prompt: "x", out_dir: dir }, config).args), want);
    }
  });

  test("normalizeCatalog handles string and object effort lists", () => {
    const out = normalizeCatalog([{ slug: "m", supported_reasoning_levels: ["low", { effort: "high" }] }]);
    assert.deepEqual(out[0].reasoning_efforts, ["low", "high"]);
  });
});

const SWIFT_DLL =
  "C:\\Users\\me\\AppData\\Local\\OpenAI\\Codex\\runtimes\\cua_node\\cfb32733c877621e\\bin\\node_modules\\@oai\\sky\\bin\\windows\\swift\\x64\\VCRUNTIME140_1.dll";
// Captured from codex-cli 0.161.0 (`exec --json`) while a runtime DLL was held open exclusively.
const REJECTED = {
  type: "item.completed",
  item: {
    id: "item_0",
    type: "command_execution",
    command: "\"pwsh.exe\" -NoProfile -Command 'Get-Content -LiteralPath README.md -TotalCount 1'",
    aggregated_output: "Failed to create unified exec process: helper_unknown_error: setup refresh had errors",
    exit_code: -1,
    status: "failed",
  },
};

describe("sandbox setup failure detection", () => {
  test("isSandboxSetupFailure matches Codex's two spellings only", () => {
    assert.ok(isSandboxSetupFailure("helper_unknown_error: setup refresh had errors"));
    assert.ok(
      isSandboxSetupFailure(
        'exec_command failed: CreateProcess { message: "Rejected(\\"x: setup refresh had errors\\")" }',
      ),
    );
    assert.ok(isSandboxSetupFailure("Helper_Unknown_Error: boom"));
    for (const text of [
      "",
      "permission denied",
      "os error 32",
      "setup refresh",
      "an unknown error in the helper",
      undefined,
      42,
    ])
      assert.equal(isSandboxSetupFailure(text), false, String(text));
  });

  test("sandboxFailureInEvent flags rejected commands and error events", () => {
    assert.ok(sandboxFailureInEvent(REJECTED));
    assert.ok(sandboxFailureInEvent({ type: "error", message: "helper_unknown_error: setup refresh had errors" }));
    assert.ok(sandboxFailureInEvent({ type: "turn.failed", error: { message: "setup refresh had errors" } }));
    assert.ok(
      sandboxFailureInEvent({ type: "item.completed", item: { type: "error", message: "setup refresh had errors" } }),
    );
  });

  test("sandboxFailureInEvent ignores the model talking about it and commands that ran", () => {
    const text = "the sandbox said helper_unknown_error: setup refresh had errors";
    assert.equal(sandboxFailureInEvent({ type: "item.completed", item: { type: "agent_message", text } }), false);
    assert.equal(sandboxFailureInEvent({ type: "item.completed", item: { type: "reasoning", text } }), false);
    // grep over a repository that mentions the error exits normally
    const ran = { ...REJECTED, item: { ...REJECTED.item, status: "completed", exit_code: 0 } };
    assert.equal(sandboxFailureInEvent(ran), false);
    const grepFailed = { ...REJECTED, item: { ...REJECTED.item, status: "failed", exit_code: 1 } };
    assert.equal(sandboxFailureInEvent(grepFailed), false);
    const notLaunch = { ...REJECTED, item: { ...REJECTED.item, aggregated_output: "notes: setup refresh had errors" } };
    assert.equal(sandboxFailureInEvent(notLaunch), false);
    assert.equal(sandboxFailureInEvent({ type: "error", message: "usage limit" }), false);
    assert.equal(sandboxFailureInEvent({ type: "turn.completed" }), false);
    assert.equal(sandboxFailureInEvent(null), false);
  });

  test("sandboxFailureInStderr needs a rejected launch, not just the phrase", () => {
    assert.ok(
      sandboxFailureInStderr(
        'ERROR exec_command failed: CreateProcess { message: "Rejected(\\"setup refresh had errors\\")" }',
      ),
    );
    assert.ok(sandboxFailureInStderr("Failed to create unified exec process: helper_unknown_error: boom"));
    assert.equal(sandboxFailureInStderr("note: setup refresh had errors earlier"), false);
    assert.equal(sandboxFailureInStderr("exec_command failed: exit 1"), false);
  });

  test("applyEvent marks the job", () => {
    const job = blankJob();
    applyEvent(job, { type: "item.completed", item: { type: "agent_message", text: "setup refresh had errors" } });
    assert.equal(job.sandboxFailure, undefined);
    applyEvent(job, REJECTED);
    assert.equal(job.sandboxFailure, true);
  });
});

describe("sandbox lock diagnosis", () => {
  const logFile = path.join(FIXTURES, "sandbox.2026-10-10.log");
  const log = fs.readFileSync(logFile, "utf8");
  const since = Date.parse("2026-10-10T13:44:00Z");
  const fixtureHome = () => {
    const home = tempDir();
    fs.mkdirSync(path.join(home, ".sandbox"));
    fs.copyFileSync(logFile, path.join(home, ".sandbox", "sandbox.2026-10-10.log"));
    return home;
  };

  test("lastLockedFile returns the newest entry, unescaped, and ignores stale ones", () => {
    const hit = lastLockedFile(log);
    assert.equal(hit.path, SWIFT_DLL);
    assert.equal(hit.at, Date.parse("2026-10-10T13:44:55.344Z"));
    assert.equal(lastLockedFile(log, since).path, SWIFT_DLL);
    assert.equal(lastLockedFile(log, Date.parse("2026-10-10T14:00:00Z")), null);
    assert.equal(lastLockedFile("nothing to see\nsetup refresh completed"), null);
  });

  test("parseProcessList reads pid and name lines", () => {
    assert.deepEqual(parseProcessList("12\tcodex-computer-use-swift\r\nnoise\r\n7\tnode_repl\r\n"), [
      { pid: 12, name: "codex-computer-use-swift" },
      { pid: 7, name: "node_repl" },
    ]);
    assert.deepEqual(parseProcessList(""), []);
  });

  test("diagnoseSandboxLock combines the log with the process lookup", async () => {
    const seen = [];
    const find = async (file) => {
      seen.push(file);
      return [{ pid: 4242, name: "codex-computer-use-swift" }];
    };
    const d = await diagnoseSandboxLock({ codexHome: fixtureHome(), sinceMs: since, find });
    assert.deepEqual(d, { file: SWIFT_DLL, processes: [{ pid: 4242, name: "codex-computer-use-swift" }] });
    assert.deepEqual(seen, [SWIFT_DLL]);
    const msg = sandboxFailureMessage(d);
    assert.match(msg, /setup refresh had errors/);
    assert.ok(msg.includes(SWIFT_DLL));
    assert.match(msg, /codex-computer-use-swift \(PID 4242\)/);
    assert.match(msg, /Quit the Codex desktop app/);
  });

  test("diagnoseSandboxLock never throws and falls back to generic advice", async () => {
    const none = await diagnoseSandboxLock({ codexHome: path.join(tempDir(), "missing") });
    assert.deepEqual(none, { file: null, processes: [] });
    const failing = await diagnoseSandboxLock({
      codexHome: fixtureHome(),
      sinceMs: since,
      find: async () => {
        throw new Error("powershell is gone");
      },
    });
    assert.deepEqual(failing, { file: SWIFT_DLL, processes: [] });
    assert.match(sandboxFailureMessage(none), /codex-computer-use-swift\.exe, node_repl\.exe/);
    assert.match(sandboxFailureMessage({ file: SWIFT_DLL, processes: [] }), /could not validate/);
  });

  test("findLockingProcesses finds the process that has a file loaded", {
    skip: process.platform !== "win32",
  }, async () => {
    // A private copy of node.exe, so exactly one process has this path loaded.
    const exe = path.join(tempDir(), "lock-holder.exe");
    fs.copyFileSync(process.execPath, exe);
    const child = spawn(exe, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
    try {
      await new Promise((resolve) => setTimeout(resolve, 500));
      assert.deepEqual(await findLockingProcesses(exe), [{ pid: child.pid, name: "lock-holder" }]);
    } finally {
      child.kill();
    }
  });
});
