import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { Client, makeEnv } from "./helpers.mjs";

describe("MCP protocol", () => {
  let ctx;
  let client;
  before(async () => {
    ctx = makeEnv();
    client = new Client(ctx.env);
  });
  after(() => client.close());

  test("initialize negotiates the protocol and names the server", async () => {
    const r = await client.init();
    assert.equal(r.protocolVersion, "2025-06-18");
    assert.equal(r.serverInfo.name, "codex");
    assert.ok(r.capabilities.tools);
    assert.match(r.instructions, /codex_task/);
  });

  test("tools/list exposes the five tools with schemas", async () => {
    const r = await client.request("tools/list");
    const names = r.result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["codex_image", "codex_job", "codex_jobs", "codex_models", "codex_task"]);
    for (const t of r.result.tools) assert.equal(t.inputSchema.type, "object");
  });

  test("unknown methods return JSON-RPC errors, unknown tools return tool errors", async () => {
    const m = await client.request("nope/nope");
    assert.equal(m.error.code, -32601);
    const t = await client.call("does_not_exist");
    assert.equal(t.isError, true);
    assert.match(t.text, /Unknown tool/);
  });

  test("ping", async () => {
    const r = await client.request("ping");
    assert.deepEqual(r.result, {});
  });
});

describe("codex_task", () => {
  let ctx;
  let client;
  before(async () => {
    ctx = makeEnv();
    client = new Client(ctx.env);
    await client.init();
  });
  after(() => client.close());

  test("runs codex exec in cwd, sends the prompt over stdin, returns the final message", async () => {
    const r = await client.call("codex_task", { prompt: "Explain the repo", cwd: ctx.project });
    assert.equal(r.isError, false);
    assert.equal(r.json.status, "completed");
    assert.match(r.json.final_message, /^final for thread-/);
    assert.ok(r.json.session_id);
    assert.deepEqual(r.json.usage, { input_tokens: 12, output_tokens: 3 });

    const call = ctx.calls().at(-1);
    assert.equal(call.input, "Explain the repo");
    assert.equal(fs.realpathSync(call.cwd), fs.realpathSync(ctx.project));
    assert.deepEqual(call.args.slice(0, 7), [
      "exec",
      "--json",
      "--skip-git-repo-check",
      "-C",
      ctx.project,
      "-s",
      "workspace-write",
    ]);
    assert.ok(!call.args.includes("Explain the repo"), "prompt must not be on argv");
  });

  test("passes model, effort, network, images and add_dirs", async () => {
    const img = path.join(ctx.base, "shot.png");
    fs.writeFileSync(img, "x");
    await client.call("codex_task", {
      prompt: "x",
      cwd: ctx.project,
      model: "fake-pro",
      reasoning_effort: "ULTRA",
      network: true,
      images: [img],
      add_dirs: [ctx.base],
    });
    const { args } = ctx.calls().at(-1);
    const joined = args.join(" ");
    assert.match(joined, /-m fake-pro/);
    assert.match(joined, /-c model_reasoning_effort="ultra"/);
    assert.match(joined, /-c sandbox_workspace_write\.network_access=true/);
    assert.match(joined, new RegExp(`--add-dir ${ctx.base.replace(/\\/g, "\\\\")}`));
    assert.equal(args[args.indexOf("-i") + 1], img);
  });

  test("resumes a session in the folder it started in, with sandbox and extra roots through config", async () => {
    const extra = path.join(ctx.base, "extra");
    fs.mkdirSync(extra);
    const first = await client.call("codex_task", { prompt: "start", cwd: ctx.project, add_dirs: [extra] });
    const id = first.json.session_id;
    const r = await client.call("codex_task", { prompt: "continue", session_id: id });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.json.session_id, id);
    const call = ctx.calls().at(-1);
    assert.deepEqual(call.args.slice(0, 3), ["exec", "resume", id]);
    assert.equal(fs.realpathSync(call.cwd), fs.realpathSync(ctx.project));
    assert.ok(call.args.includes('sandbox_mode="workspace-write"'));
    assert.ok(call.args.includes(`sandbox_workspace_write.writable_roots=[${JSON.stringify(extra)}]`));
    assert.ok(!call.args.includes("-C"));

    await client.call("codex_task", { prompt: "look", session_id: id, sandbox: "read-only" });
    const ro = ctx.calls().at(-1).args;
    assert.ok(ro.includes('sandbox_mode="read-only"'));
    assert.ok(!ro.some((x) => x.startsWith("sandbox_workspace_write.writable_roots")));
  });

  test("resumes a session started elsewhere using Codex's rollout metadata", async () => {
    const id = "0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000";
    const dir = path.join(ctx.env.CODEX_HOME, "sessions", "2026", "10", "01");
    fs.mkdirSync(dir, { recursive: true });
    const meta = { type: "session_meta", payload: { id, cwd: ctx.project } };
    fs.writeFileSync(path.join(dir, `rollout-2026-10-01T10-00-00-${id}.jsonl`), `${JSON.stringify(meta)}\n{}\n`);
    const r = await client.call("codex_task", { prompt: "continue", session_id: id });
    assert.equal(r.isError, false, r.text);
    assert.equal(fs.realpathSync(ctx.calls().at(-1).cwd), fs.realpathSync(ctx.project));
  });

  test("refuses to resume an unknown session without cwd instead of running in the home folder", async () => {
    const before = ctx.calls().length;
    const r = await client.call("codex_task", { prompt: "continue", session_id: "abc-123" });
    assert.equal(r.isError, true);
    assert.match(r.text, /working folder of session abc-123 is unknown/);
    assert.equal(ctx.calls().length, before);

    const ok = await client.call("codex_task", { prompt: "continue", session_id: "abc-123", cwd: ctx.project });
    assert.equal(ok.isError, false, ok.text);
    assert.equal(fs.realpathSync(ctx.calls().at(-1).cwd), fs.realpathSync(ctx.project));
  });

  test("reports the files a workspace-write task changed in a git repository", async () => {
    const repo = path.join(ctx.base, "repo");
    fs.mkdirSync(repo);
    assert.equal(spawnSync("git", ["init", "-q", repo]).status, 0);
    fs.writeFileSync(path.join(repo, "untouched.txt"), "dirty before the task");
    const out = path.join(repo, "codex-out.txt");
    // .native also expands Windows 8.3 names (CI's temp dir is C:\Users\RUNNER~1\…; git reports the long form).
    const same = (list, files) =>
      assert.deepEqual(
        list.map((f) => fs.realpathSync.native(f)),
        files.map((f) => fs.realpathSync.native(f)),
      );

    const first = await client.call("codex_task", { prompt: "WRITE a file", cwd: repo });
    same(first.json.changed_files, [out]);
    // Already untracked before the second run: detected through its mtime.
    const second = await client.call("codex_task", { prompt: "WRITE again", cwd: repo });
    same(second.json.changed_files, [out]);
    const quiet = await client.call("codex_task", { prompt: "no edits", cwd: repo });
    assert.deepEqual(quiet.json.changed_files, []);

    const ro = await client.call("codex_task", { prompt: "look", cwd: repo, sandbox: "read-only" });
    assert.equal(ro.json.changed_files, undefined);
    const noRepo = await client.call("codex_task", { prompt: "WRITE here", cwd: ctx.project });
    assert.equal(noRepo.json.changed_files, undefined);
  });

  test("validates input before spawning anything", async () => {
    const before = ctx.calls().length;
    for (const [args, re] of [
      [{ prompt: "x" }, /cwd is required/],
      [{ prompt: "x", cwd: path.join(ctx.base, "missing") }, /cwd not found/],
      [{ prompt: "x", cwd: ctx.project, sandbox: "danger-full-access" }, /sandbox must be one of/],
      [{ prompt: "x", cwd: ctx.project, reasoning_effort: 'high" --evil' }, /invalid reasoning_effort/],
      [{ prompt: "x", cwd: ctx.project, model: "a b" }, /invalid model/],
      [{ prompt: "x", session_id: "../etc" }, /invalid session_id/],
      [{ prompt: "   ", cwd: ctx.project }, /prompt is required/],
    ]) {
      const r = await client.call("codex_task", args);
      assert.equal(r.isError, true, JSON.stringify(args));
      assert.match(r.text, re);
    }
    assert.equal(ctx.calls().length, before);
  });

  test("surfaces Codex failures", async () => {
    const r = await client.call("codex_task", { prompt: "FAIL now", cwd: ctx.project });
    assert.equal(r.isError, true);
    assert.equal(r.json.status, "failed");
    assert.deepEqual(r.json.errors, ["You've hit your usage limit."]);
    assert.match(r.json.stderr_tail, /simulated failure/);
  });
});

describe("jobs", () => {
  let ctx;
  let client;
  before(async () => {
    ctx = makeEnv();
    client = new Client(ctx.env);
    await client.init();
  });
  after(() => client.close());

  test("long runs return a job_id that codex_job resolves, with progress notifications", async () => {
    const r = await client.call("codex_task", { prompt: "SLOW job", cwd: ctx.project, wait_seconds: 0 });
    assert.equal(r.json.status, "running");
    const done = await client.call("codex_job", { job_id: r.json.job_id, wait_seconds: 30 }, { progressToken: "p1" });
    assert.equal(done.json.status, "completed");
    const progress = client.notifications.filter((n) => n.method === "notifications/progress");
    assert.ok(progress.length >= 1, "expected at least one progress notification during a 4 s run");
    for (const p of progress) assert.equal(p.params.progressToken, "p1");
  });

  test("cancel stops a running job", async () => {
    const r = await client.call("codex_task", { prompt: "HANG", cwd: ctx.project, wait_seconds: 1 });
    assert.equal(r.json.status, "running");
    const c = await client.call("codex_job", { job_id: r.json.job_id, cancel: true });
    assert.equal(c.json.status, "cancelled");
  });

  test("a rejected sandbox setup stops the run and fails the job with an actionable error", async () => {
    // A log entry written "now", as Codex's sandbox would have; the file does not exist, so no process is named.
    const locked = path.join(ctx.base, "runtimes", "swift", "VCRUNTIME140_1.dll");
    const sandboxDir = path.join(ctx.env.CODEX_HOME, ".sandbox");
    fs.mkdirSync(sandboxDir, { recursive: true });
    fs.writeFileSync(
      path.join(sandboxDir, "sandbox.2099-01-01.log"),
      `[${new Date().toISOString()}] runtime read/execute validation failed: validate runtime read/execute access on ${locked}: open ACL target for root-only update: in use (os error 32)\n`,
    );
    const r = await client.call("codex_task", { prompt: "SANDBOX review", cwd: ctx.project, wait_seconds: 30 });
    assert.equal(r.isError, true);
    assert.equal(r.json.status, "failed");
    assert.equal(r.json.final_message, undefined, "no blind answer is returned");
    assert.equal(r.json.errors.length, 1);
    assert.match(r.json.errors[0], /setup refresh had errors/);
    assert.ok(r.json.errors[0].includes(locked));
    assert.match(r.json.errors[0], /Quit it from the tray or end its helper processes/);
  });

  test("codex_jobs lists what ran", async () => {
    const r = await client.call("codex_jobs");
    assert.ok(Array.isArray(r.json));
    assert.ok(r.json.some((j) => j.status === "cancelled"));
  });

  test("unknown job ids are an error", async () => {
    const r = await client.call("codex_job", { job_id: "nope" });
    assert.equal(r.isError, true);
  });
});

describe("codex_image", () => {
  let ctx;
  let client;
  before(async () => {
    ctx = makeEnv();
    client = new Client(ctx.env);
    await client.init();
  });
  after(() => client.close());

  test("copies generated images into out_dir and returns previews", async () => {
    const out = path.join(ctx.base, "icons");
    const r = await client.call("codex_image", {
      prompt: "Gold coin icon",
      name: "coin",
      count: 3,
      transparent: true,
      size: "1024x1024",
      out_dir: out,
    });
    assert.equal(r.json.status, "completed", r.text);
    assert.deepEqual(
      r.json.files.map((f) => path.basename(f)),
      ["coin.png", "coin-2.png", "coin-3.png"],
    );
    for (const f of r.json.files) assert.ok(fs.existsSync(f));
    assert.equal(r.images.length, 3);
    assert.equal(r.images[0].mimeType, "image/png");

    const call = ctx.calls().at(-1);
    assert.match(call.input, /^\$imagegen /);
    assert.match(call.input, /create 3 images/);
    assert.match(call.input, /transparent/);
    assert.ok(call.args.includes("read-only"));
  });

  test("never overwrites existing files and defaults to the asset dir", async () => {
    await client.call("codex_image", { prompt: "Gold coin icon", name: "coin", out_dir: path.join(ctx.base, "icons") });
    assert.ok(fs.existsSync(path.join(ctx.base, "icons", "coin-4.png")));
    const r = await client.call("codex_image", { prompt: "Sprite sheet!", return_images: false });
    assert.equal(path.dirname(r.json.files[0]), ctx.env.CODEX_MCP_ASSET_DIR);
    assert.equal(path.basename(r.json.files[0]), "sprite-sheet.png");
    assert.equal(r.images.length, 0);
  });

  test("warns when a transparent image comes back without an alpha channel", async () => {
    const out = path.join(ctx.base, "alpha");
    const ok = await client.call("codex_image", {
      prompt: "icon",
      transparent: true,
      out_dir: out,
      return_images: false,
    });
    assert.equal(ok.json.warnings, undefined);
    const bad = await client.call("codex_image", {
      prompt: "OPAQUE icon",
      transparent: true,
      out_dir: out,
      return_images: false,
    });
    assert.equal(bad.json.status, "completed");
    assert.equal(bad.isError, false);
    assert.equal(bad.json.warnings.length, 1);
    assert.match(bad.json.warnings[0], /no alpha channel/);
    const plain = await client.call("codex_image", { prompt: "OPAQUE photo", out_dir: out, return_images: false });
    assert.equal(plain.json.warnings, undefined);
  });

  test("unattributed images never include another session's output", async () => {
    const r = await client.call("codex_image", {
      prompt: "LOOSE banner",
      name: "loose",
      count: 2,
      out_dir: path.join(ctx.base, "loose"),
      return_images: false,
    });
    assert.equal(r.json.status, "completed", r.text);
    assert.deepEqual(
      r.json.files.map((f) => path.basename(f)),
      ["loose.png", "loose-2.png"],
    );
  });

  test("image jobs are serialized so outputs are attributed correctly", async () => {
    const a = await client.call("codex_image", { prompt: "SLOW one", name: "a", wait_seconds: 0 });
    const b = await client.call("codex_image", { prompt: "second", name: "b", wait_seconds: 0 });
    assert.equal(a.json.status, "running");
    assert.equal(b.json.status, "queued");
    const ra = await client.call("codex_job", { job_id: a.json.job_id, wait_seconds: 30 });
    const rb = await client.call("codex_job", { job_id: b.json.job_id, wait_seconds: 30 });
    assert.deepEqual(
      ra.json.files.map((f) => path.basename(f)),
      ["a.png"],
    );
    assert.deepEqual(
      rb.json.files.map((f) => path.basename(f)),
      ["b.png"],
    );
  });
});

describe("codex_models", () => {
  test("normalizes the catalog and reads the configured default", async () => {
    const ctx = makeEnv();
    fs.writeFileSync(
      path.join(ctx.env.CODEX_HOME, "config.toml"),
      'model = "fake-pro"\nmodel_reasoning_effort = "high"\n\n[profiles.fast]\nmodel = "other"\n',
    );
    const client = new Client(ctx.env);
    await client.init();
    const r = await client.call("codex_models");
    assert.equal(r.json.catalog, "live");
    assert.deepEqual(r.json.configured_default, { model: "fake-pro", reasoning_effort: "high" });
    assert.deepEqual(r.json.models, [
      {
        model: "fake-pro",
        name: "Fake Pro",
        description: "Big model",
        reasoning_efforts: ["low", "medium", "ultra"],
        default_effort: "medium",
      },
    ]);
    const all = await client.call("codex_models", { include_hidden: true });
    assert.equal(all.json.models.length, 2);
    await client.close();
  });
});

describe("server defaults", () => {
  let ctx;
  let client;
  before(async () => {
    ctx = makeEnv({
      CODEX_MCP_TASK_MODEL: "fake-pro",
      CODEX_MCP_TASK_EFFORT: "low",
      CODEX_MCP_IMAGE_MODEL: "fake-mini",
      CODEX_MCP_IMAGE_EFFORT: "medium",
    });
    client = new Client(ctx.env);
    await client.init();
  });
  after(() => client.close());

  test("apply only when a call omits model / reasoning_effort", async () => {
    await client.call("codex_task", { prompt: "x", cwd: ctx.project });
    let joined = ctx.calls().at(-1).args.join(" ");
    assert.match(joined, /-m fake-pro/);
    assert.match(joined, /model_reasoning_effort="low"/);

    await client.call("codex_task", { prompt: "x", cwd: ctx.project, model: "other", reasoning_effort: "high" });
    joined = ctx.calls().at(-1).args.join(" ");
    assert.match(joined, /-m other/);
    assert.match(joined, /model_reasoning_effort="high"/);
    assert.doesNotMatch(joined, /fake-pro/);

    await client.call("codex_image", { prompt: "icon", return_images: false });
    joined = ctx.calls().at(-1).args.join(" ");
    assert.match(joined, /-m fake-mini/);
    assert.match(joined, /model_reasoning_effort="medium"/);
  });

  test("are reported by codex_models and in tool descriptions", async () => {
    const r = await client.call("codex_models");
    assert.deepEqual(r.json.server_defaults, {
      task: { model: "fake-pro", reasoning_effort: "low" },
      image: { model: "fake-mini", reasoning_effort: "medium" },
    });
    const { tools } = (await client.request("tools/list")).result;
    const task = tools.find((t) => t.name === "codex_task");
    assert.match(task.inputSchema.properties.model.description, /server default fake-pro/);
  });

  test("an invalid default fails the call instead of reaching Codex", async () => {
    const bad = makeEnv({ CODEX_MCP_TASK_MODEL: "a b" });
    const c = new Client(bad.env);
    await c.init();
    const r = await c.call("codex_task", { prompt: "x", cwd: bad.project });
    assert.equal(r.isError, true);
    assert.match(r.text, /invalid model/);
    assert.equal(bad.calls().length, 0);
    await c.close();
  });
});

describe("missing Codex", () => {
  test("tool calls fail with an actionable message", async () => {
    const ctx = makeEnv({ CODEX_BIN: path.join(makeEnv().base, "nope", "codex") });
    const client = new Client(ctx.env);
    await client.init();
    const r = await client.call("codex_task", { prompt: "x", cwd: ctx.project });
    assert.equal(r.isError, true);
    assert.match(r.text, /CODEX_BIN=.* is not runnable/);
    await client.close();
  });
});
