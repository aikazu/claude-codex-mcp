# Security Policy

## Supported versions

Only the latest release receives fixes.

## Reporting a vulnerability

Please use GitHub's **private vulnerability reporting** for this repository
(Security → Report a vulnerability) rather than a public issue. Include steps to
reproduce, the affected version and your platform. You can expect a first
response within a week.

## Scope and design notes

- The server runs locally over stdio, opens no network ports and never reads,
  stores or forwards Codex/ChatGPT credentials — authentication is handled
  entirely by the Codex CLI.
- Codex is always started with an explicit sandbox (`read-only` or
  `workspace-write`). Full-access and approval-bypass modes are not exposed.
- Processes are spawned with an argv array and no shell; prompts are written to
  stdin. User-controlled values that become CLI flags (`model`,
  `reasoning_effort`, `session_id`) are validated against strict patterns.
- Codex output is returned to Claude as data. Treat it as untrusted input.

Issues in the Codex CLI itself should be reported to OpenAI.
