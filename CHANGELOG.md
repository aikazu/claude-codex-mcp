# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

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
