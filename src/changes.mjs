// Files a workspace-write task changed, from `git status` snapshots taken when
// the job starts and when it finishes. Best effort: no git, not a repository,
// or a status that times out leaves the result out instead of failing the job.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function git(cwd, args) {
  const r = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 15_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return r.status === 0 ? r.stdout : undefined;
}

const mtime = (file) => {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return "gone";
  }
};

/** @returns {{root: string, entries: Map<string, string>} | undefined} */
export function gitSnapshot(cwd) {
  const root = git(cwd, ["rev-parse", "--show-toplevel"])?.trim();
  if (!root) return undefined;
  const out = git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (out === undefined) return undefined;
  const entries = new Map();
  const fields = out.split("\0");
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (field.length < 4) continue;
    const code = field.slice(0, 2);
    const file = path.resolve(root, field.slice(3));
    // With -z a rename or copy carries its source path in the next field.
    if (code[0] === "R" || code[0] === "C") i++;
    // Status plus mtime, so a file that was already dirty and changes again still counts.
    entries.set(file, `${code} ${mtime(file)}`);
  }
  return { root, entries };
}

/** Absolute paths whose status or mtime differs between two snapshots. */
export function changedFiles(before, after) {
  if (!before || !after || before.root !== after.root) return undefined;
  const changed = new Set();
  for (const [file, sig] of after.entries) if (before.entries.get(file) !== sig) changed.add(file);
  for (const file of before.entries.keys()) if (!after.entries.has(file)) changed.add(file);
  return [...changed].sort();
}
