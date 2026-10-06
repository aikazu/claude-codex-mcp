#!/usr/bin/env node
// Stand-in for the Codex CLI used by the test suite. It mimics the parts of
// `codex exec --json` that the server relies on and records each invocation
// to $FAKE_CODEX_LOG so tests can assert on argv, cwd and stdin.
//
// Prompt keywords: FAIL → turn.failed + exit 1, SLOW → 4 s delay, HANG → never exits,
// LOOSE → images land outside the thread folder and are not reported, while
// another session (e.g. the Codex desktop app) writes one at the same time.

import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

if (args[0] === "--version") {
  console.log("codex-cli 0.0.0-fake");
  process.exit(0);
}
if (args[0] === "login" && args[1] === "status") {
  console.error("Logged in using ChatGPT");
  process.exit(0);
}
if (args[0] === "debug" && args[1] === "models") {
  const catalog = {
    models: [
      {
        slug: "fake-pro",
        display_name: "Fake Pro",
        description: "Big model",
        visibility: "list",
        default_reasoning_level: "medium",
        supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "ultra" }],
      },
      { slug: "fake-hidden", visibility: "hide", supported_reasoning_levels: ["low"] },
    ],
  };
  process.stdout.write(JSON.stringify(catalog), () => process.exit(0));
} else if (args[0] === "exec") {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => {
    input += d;
  });
  process.stdin.on("end", () => run(input));
} else {
  console.error(`fake-codex: unsupported args ${args.join(" ")}`);
  process.exit(2);
}

function run(input) {
  const resume = args[1] === "resume";
  const tid = resume ? args[2] : `thread-${process.pid}-${Date.now()}`;
  const out = args[args.indexOf("-o") + 1];
  const emit = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
  if (process.env.FAKE_CODEX_LOG) {
    fs.appendFileSync(process.env.FAKE_CODEX_LOG, `${JSON.stringify({ args, cwd: process.cwd(), input })}\n`);
  }
  emit({ type: "thread.started", thread_id: tid });
  emit({ type: "turn.started" });
  if (input.includes("HANG")) {
    setInterval(() => {}, 1000);
    return;
  }
  const delay = input.includes("SLOW") ? 4000 : 50;
  setTimeout(() => {
    if (input.includes("$imagegen")) {
      const n = Number.parseInt(input.match(/create (\d+) image/)?.[1] ?? "1", 10);
      const loose = input.includes("LOOSE");
      const root = path.join(process.env.CODEX_HOME, "generated_images");
      const dir = path.join(root, loose ? "loose" : tid);
      fs.mkdirSync(dir, { recursive: true });
      for (let i = 0; i < n; i++) {
        const p = path.join(dir, `ig_${i}.png`);
        fs.writeFileSync(p, PNG_1PX);
        if (!loose) emit({ type: "item.completed", item: { type: "image_generation", saved_path: p } });
      }
      if (loose) {
        const other = path.join(root, "0199bbbb-cccc-7ddd-8eee-ffff00001111");
        fs.mkdirSync(other, { recursive: true });
        fs.writeFileSync(path.join(other, "foreign.png"), PNG_1PX);
      }
    }
    if (input.includes("FAIL")) {
      emit({ type: "turn.failed", error: { message: "You've hit your usage limit." } });
      console.error("simulated failure");
      process.exit(1);
    }
    emit({ type: "item.completed", item: { type: "agent_message", text: `echo: ${input.slice(0, 40)}` } });
    emit({ type: "turn.completed", usage: { input_tokens: 12, output_tokens: 3 } });
    fs.writeFileSync(out, `final for ${tid}`);
    process.exit(0);
  }, delay);
}
