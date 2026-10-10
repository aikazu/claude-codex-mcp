# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed

- On Windows, a run whose sandbox setup fails (`helper_unknown_error: setup refresh had errors`, e.g. because the Codex
  desktop app's `codex-computer-use-swift.exe` or `node_repl.exe` holds a file under Codex's runtimes folder open) is now
  stopped at the first rejected command and the job fails with an actionable error, instead of Codex carrying on without
  reading any files and returning a blind answer after spending hundreds of thousands of tokens. The error names the
  file from the newest `~/.codex/.sandbox/sandbox.<date>.log` and, when found, the process (name and PID) that has it
  loaded; the lookup is best effort and bounded to a few seconds.

## [0.2.0] - 2026-10-08

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

## [0.1.0] - 2026-10-05

### Added

- MCP server over stdio with `codex_task`, `codex_image`, `codex_job`, `codex_jobs` and `codex_models`.
- Delegation through `codex exec --json`, session resume via `exec resume`, model and reasoning-effort selection.
- Image generation through Codex's built-in `image_gen`, copied into the project without overwriting, with inline previews.
- Non-blocking jobs with a queue (tasks and images limited separately) and MCP progress notifications.
- Windows-safe Codex discovery: `codex.exe`, or npm/bun shims resolved to `@openai/codex/bin/codex.js`; no shell is ever used.
- Cross-platform installer (`scripts/register.mjs`, `install.ps1`, `install.sh`) for Claude Desktop (incl. Microsoft Store) and Claude Code.
- Claude Code plugin + marketplace manifests and the `codex-delegation` skill.
- Test suite against a fake Codex CLI; CI on Windows, macOS and Linux.

[0.2.0]: https://github.com/aikazu/claude-codex-mcp/releases/tag/v0.2.0
[0.1.0]: https://github.com/aikazu/claude-codex-mcp/releases/tag/v0.1.0
