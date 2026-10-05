import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { launcherFor } from "../src/codex-bin.mjs";
import { buildImagePrompt, slug } from "../src/images.mjs";
import { applyEvent } from "../src/jobs.mjs";
import { normalizeCatalog } from "../src/models.mjs";
import { tempDir } from "./helpers.mjs";

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

  test("normalizeCatalog handles string and object effort lists", () => {
    const out = normalizeCatalog([{ slug: "m", supported_reasoning_levels: ["low", { effort: "high" }] }]);
    assert.deepEqual(out[0].reasoning_efforts, ["low", "high"]);
  });
});
