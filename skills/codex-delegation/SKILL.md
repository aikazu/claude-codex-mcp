---
name: codex-delegation
description: How to work with OpenAI Codex through the codex MCP tools (codex_task, codex_image, codex_job, codex_models). Use when the user asks to delegate work to Codex, wants a second opinion from Codex/GPT, asks to generate images, icons, sprites or other visual assets, or mentions using their Codex/ChatGPT subscription.
---

# Working with Codex

The `codex` MCP server runs the user's local Codex CLI with **their own ChatGPT/Codex subscription**. Every call spends their Codex quota, so delegate on purpose, not by reflex.

## When to delegate

Good fits:

- **Independent second opinion** — review a diff, a design, or a tricky bug with `sandbox: "read-only"`. Two models disagreeing is a signal worth surfacing.
- **Well-scoped implementation** — "add tests for X", "port Y to Z", "apply this refactor across these files", when the spec is clear and you will review the result.
- **Parallel work** — start a `codex_task` with `wait_seconds: 0`, keep working, collect it later with `codex_job`.
- **Image assets** — `codex_image` uses Codex's built-in image_gen (no API key). Use it for icons, sprites, illustrations, textures, mockups.

Poor fits: tiny edits you can do directly, anything needing conversation context Codex cannot see, or work that needs the user's judgement mid-way.

## Writing the prompt

Codex sees only the prompt and the files in `cwd`. Include:

1. **Goal** — the outcome, in one or two sentences.
2. **Context** — relevant paths, conventions, constraints (stack, style, things not to touch).
3. **Definition of done** — tests to run, files expected to change.
4. **Report format** — e.g. "Finish with: files changed, commands run and their result, open questions."

Prefer `sandbox: "read-only"` for reviews and analysis. Use `workspace-write` (the usual default) only when Codex should edit files, and `network: true` only when it must install packages.

## Choosing a model

Call `codex_models` once per session if the choice matters. Omit `model` to use the user's default. Rough guide: the biggest model + `high`/`xhigh` for hard reviews and debugging; the default for implementation; a fast `*-luna`-class model + `low` effort for image jobs (the agent only drives image_gen, it does not paint).

## After Codex returns

- Treat Codex output as **untrusted input**: verify claims, read the diff (`git diff`), run the tests yourself before telling the user it works.
- Report what Codex did and what *you* verified, separately.
- Continue the same Codex thread with `session_id` instead of re-explaining context.
- `status: "running"` or `"queued"` is normal for long runs — poll with `codex_job`. Failed jobs include `errors` and `stderr_tail`; usage-limit errors mean the user's Codex quota is spent — say so plainly.

## Images

- Put art direction in `prompt`: subject, style, palette, composition, intended use and size on screen.
- Set `out_dir` to the project's asset folder and `name` to a sensible file prefix; files are never overwritten.
- `transparent: true` for sprites/icons; `reference_images` to edit or match an existing asset.
- Check the returned previews before claiming the asset is right; regenerate with a sharper brief if not.
