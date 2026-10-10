// Detection and diagnosis of Codex's Windows "sandbox setup failed" state.
//
// Before every shell command Codex's elevated sandbox re-validates the ACLs of
// its runtime folders (%LOCALAPPDATA%\OpenAI\Codex\runtimes, ~\.cache\codex-runtimes).
// When another process keeps a file there open (the Codex desktop app's
// `codex-computer-use-swift.exe`, `node_repl.exe`, …) the check fails with
// os error 32 and every command is rejected with `setup refresh had errors`.
// Codex then carries on without reading anything, so the server stops the run
// and tells the caller which file and process to deal with.

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const FAILURE_RE = /setup refresh had errors|helper_unknown_error:/i;
// Only a rejected shell launch counts when it shows up on stderr.
const LAUNCH_FAILURE_RE = /exec_command failed|failed to create unified exec process/i;
const LOG_NAME_RE = /^sandbox\.\d{4}-\d{2}-\d{2}\.log$/;
const LOG_LINE_RE =
  /^\[([^\]]+)\] runtime read\/execute validation failed: validate runtime read\/execute access on (.+?):\s/;
const LOG_TAIL_BYTES = 256 * 1024;
const LOOKUP_TIMEOUT_MS = 8000;
const CLOCK_SLACK_MS = 5000;

/** True when `text` is the sandbox-setup failure Codex prints for a rejected shell command. Pure. */
export const isSandboxSetupFailure = (text) => typeof text === "string" && FAILURE_RE.test(text);

/**
 * True when a `codex exec --json` event reports a shell command that was rejected by the sandbox setup.
 * Codex 0.161 reports the rejection as a `command_execution` item with `exit_code: -1` and the launch error as its
 * output. Agent messages and reasoning are ignored (the model may merely discuss the error), and so is output of a
 * command that actually ran (a non-negative exit code), e.g. `grep` over a repository that mentions this error. Pure.
 */
export function sandboxFailureInEvent(ev) {
  const item = ev?.item;
  switch (ev?.type) {
    case "error":
      return isSandboxSetupFailure(ev.message);
    case "turn.failed":
    case "thread.failed":
      return isSandboxSetupFailure(ev.error?.message);
    case "item.started":
    case "item.updated":
    case "item.completed":
      if (item?.type === "error") return isSandboxSetupFailure(item.message);
      if (item?.type === "command_execution" && (item.exit_code == null || item.exit_code < 0))
        return sandboxFailureInStderr(item.aggregated_output) || isSandboxSetupFailure(item.error);
      return false;
    default:
      return false;
  }
}

/** True when a stderr line is Codex logging a rejected shell launch caused by the sandbox setup. Pure. */
export const sandboxFailureInStderr = (line) => isSandboxSetupFailure(line) && LAUNCH_FAILURE_RE.test(line ?? "");

/** Newest `runtime read/execute validation failed` entry of a sandbox log at or after `sinceMs`, or null. Pure. */
export function lastLockedFile(logText, sinceMs = 0) {
  let found = null;
  for (const line of String(logText).split(/\r?\n/)) {
    const m = LOG_LINE_RE.exec(line);
    if (!m) continue;
    const at = Date.parse(m[1]);
    if (Number.isFinite(at) && at >= sinceMs - CLOCK_SLACK_MS) found = { path: m[2], at };
  }
  return found;
}

/** Read the end of the newest sandbox logs in `<codexHome>/.sandbox` and return the last locked file, or null. */
export function readLockedFile(codexHome, sinceMs) {
  try {
    const dir = path.join(codexHome, ".sandbox");
    const logs = fs
      .readdirSync(dir)
      .filter((f) => LOG_NAME_RE.test(f))
      .sort()
      .reverse()
      .slice(0, 2);
    for (const name of logs) {
      const file = path.join(dir, name);
      const { size } = fs.statSync(file);
      const fd = fs.openSync(file, "r");
      try {
        const len = Math.min(size, LOG_TAIL_BYTES);
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, size - len);
        const hit = lastLockedFile(buf.toString("utf8"), sinceMs);
        if (hit) return hit;
      } finally {
        fs.closeSync(fd);
      }
    }
  } catch {
    /* no log, unreadable, or not Windows */
  }
  return null;
}

// Lists processes that have `$env:CCM_LOCKED_FILE` loaded. Processes running from Codex's runtime folders are
// checked first and the scan stops there when it finds any, because that is where the desktop app's helpers live;
// reading the module list of every other process is the slower fallback. Output: one `pid<TAB>name` line per hit.
const LOOKUP_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$file = $env:CCM_LOCKED_FILE
$roots = @((Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\runtimes'), (Join-Path $env:USERPROFILE '.cache\codex-runtimes'))
$all = @(Get-Process)
$near = @($all | Where-Object { $x = $_.Path; $x -and ($roots | Where-Object { $x.StartsWith($_, 'OrdinalIgnoreCase') }) })
$far = @($all | Where-Object { $near -notcontains $_ })
$hits = 0
foreach ($group in $near, $far) {
  foreach ($p in $group) {
    if ($hits -ge 5) { break }
    $has = ($p.Path -and ($p.Path -ieq $file)) -or (@($p.Modules | Where-Object { $_.FileName -ieq $file }).Count -gt 0)
    if ($has) { "$($p.Id)$([char]9)$($p.ProcessName)"; $hits++ }
  }
  if ($hits -gt 0) { break }
}
`;

/** Parse the `pid<TAB>name` lines printed by the lookup script. Pure. */
export function parseProcessList(stdout) {
  const out = [];
  for (const line of String(stdout).split(/\r?\n/)) {
    const m = /^(\d+)\t(.+)$/.exec(line.trim());
    if (m) out.push({ pid: Number(m[1]), name: m[2].trim() });
  }
  return out;
}

/** Windows only: which processes have `file` loaded. Bounded by a timeout; resolves to [] on any failure. */
export function findLockingProcesses(file, { timeoutMs = LOOKUP_TIMEOUT_MS } = {}) {
  if (process.platform !== "win32") return Promise.resolve([]);
  return new Promise((resolve) => {
    try {
      execFile(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", LOOKUP_SCRIPT],
        { env: { ...process.env, CCM_LOCKED_FILE: file }, timeout: timeoutMs, windowsHide: true, maxBuffer: 1 << 16 },
        (err, stdout) => resolve(err && !stdout ? [] : parseProcessList(stdout)),
      );
    } catch {
      resolve([]);
    }
  });
}

/**
 * Best effort: name the file the sandbox could not validate and the process holding it. Never rejects.
 * @param {{codexHome?: string, sinceMs?: number, find?: (file: string) => Promise<{pid:number,name:string}[]>}} [opts]
 * @returns {Promise<{file: string|null, processes: {pid:number,name:string}[]}>}
 */
export async function diagnoseSandboxLock({ codexHome, sinceMs = 0, find = findLockingProcesses } = {}) {
  try {
    const hit = readLockedFile(codexHome || path.join(os.homedir(), ".codex"), sinceMs);
    if (!hit) return { file: null, processes: [] };
    const processes = await Promise.resolve()
      .then(() => find(hit.path))
      .catch(() => []);
    return { file: hit.path, processes };
  } catch {
    return { file: null, processes: [] };
  }
}

/** The error text for a stopped job. Pure. */
export function sandboxFailureMessage({ file, processes = [] } = {}) {
  const parts = [
    "Codex's Windows sandbox could not start a shell (`helper_unknown_error: setup refresh had errors`), so the run was " +
      "stopped instead of letting Codex continue without reading any files.",
  ];
  if (file) parts.push(`The sandbox could not validate ${file}.`);
  if (processes.length) {
    const who = processes.map((p) => `${p.name} (PID ${p.pid})`).join(", ");
    parts.push(`It is in use by ${who}. Quit the Codex desktop app from the tray or end that process, then retry.`);
  } else {
    parts.push(
      "A file under %LOCALAPPDATA%\\OpenAI\\Codex\\runtimes (or ~\\.cache\\codex-runtimes) is held open by another process, " +
        "usually the Codex desktop app. Quit it from the tray or end its helper processes (codex-computer-use-swift.exe, " +
        "node_repl.exe), then retry.",
    );
  }
  return parts.join(" ");
}
