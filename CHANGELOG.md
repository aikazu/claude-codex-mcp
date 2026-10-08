# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Server-side defaults for calls that omit `model` / `reasoning_effort`: `CODEX_MCP_TASK_MODEL`, `CODEX_MCP_TASK_EFFORT`,
  `CODEX_MCP_IMAGE_MODEL`, `CODEX_MCP_IMAGE_EFFORT` (installer: `--task-model` … / `-TaskModel` …). Shown by
  `codex_models` (`server_defaults`), `--check` and the tool descriptions.
- `codex_task` results list `changed_files` for `workspace-write` runs inside a git repository, from `git status`
  snapshots taken when the job starts and finishes, so the caller can review the diff without trusting Codex's report.
- `codex_image` with `transparent: true` checks each PNG for an alpha channel and returns `warnings` for images that
  came back opaque (e.g. a painted checkerboard).

### Changed

- The server `instructions` now carry the core delegation guidance (when to delegate, explicit model choice, sandbox
  choice, briefing, verification), since installs outside the Claude Code plugin never receive the `codex-delegation`
  skill. The skill is updated for the new defaults, `changed_files` and `warnings`.

### Fixed

- On Windows with the Codex desktop app installed, every shell command in a delegated run failed with
  `helper_unknown_error: setup refresh had errors`: the run started the app's `node_repl` / `cua_repl` MCP servers,
  and Codex's sandbox setup then could not open the running `node_repl.exe` to check its ACL (`os error 32`). Task and
  image runs now turn both servers off.
- Resuming a session without `cwd` ran Codex in the home folder, which `workspace-write` then made writable. Resume now
  runs in the folder the session started in (remembered by the server, or read from Codex's session metadata), reapplies
  its `add_dirs`, and refuses when the folder is unknown.
- When an image job's files could not be tied to its Codex thread, the fallback copied every new image in
  `generated_images`, including other Codex clients' output. It now skips other threads' folders and keeps at most
  `count` files.

## [1.0.0] - 2026-10-05

### Added

- MCP server over stdio with `codex_task`, `codex_image`, `codex_job`, `codex_jobs` and `codex_models`.
- Delegation through `codex exec --json`, session resume via `exec resume`, model and reasoning-effort selection.
- Image generation through Codex's built-in `image_gen`, copied into the project without overwriting, with inline previews.
- Non-blocking jobs with a queue (tasks and images limited separately) and MCP progress notifications.
- Windows-safe Codex discovery: `codex.exe`, or npm/bun shims resolved to `@openai/codex/bin/codex.js`; no shell is ever used.
- Cross-platform installer (`scripts/register.mjs`, `install.ps1`, `install.sh`) for Claude Desktop (incl. Microsoft Store) and Claude Code.
- Claude Code plugin + marketplace manifests and the `codex-delegation` skill.
- Test suite against a fake Codex CLI; CI on Windows, macOS and Linux.

[1.0.0]: https://github.com/aikazu/claude-codex-mcp/releases/tag/v1.0.0
