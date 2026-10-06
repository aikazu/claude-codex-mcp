// Working folder of each Codex session, so `exec resume` runs where the
// session started. `exec resume` has no -C/--add-dir: Codex takes the process
// cwd as its workspace, so resuming from the wrong folder would make that
// folder writable instead of the project.

import fs from "node:fs";
import path from "node:path";

const MAX_SESSIONS = 200;
const MAX_META_BYTES = 4 * 1024 * 1024;

/** Read the first line of a file without loading the rest. */
function firstLine(file) {
  const fd = fs.openSync(file, "r");
  try {
    const chunks = [];
    const buf = Buffer.alloc(64 * 1024);
    let total = 0;
    while (total < MAX_META_BYTES) {
      const n = fs.readSync(fd, buf, 0, buf.length, total);
      if (n === 0) break;
      const nl = buf.subarray(0, n).indexOf(10);
      chunks.push(Buffer.from(buf.subarray(0, nl === -1 ? n : nl)));
      total += n;
      if (nl !== -1) break;
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

const sortedDirs = (dir) => {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
      .reverse();
  } catch {
    return [];
  }
};

/**
 * Best-effort lookup of a session's cwd in Codex's own rollout files
 * ($CODEX_HOME/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl, first line is
 * session_meta). Covers sessions started before this server process.
 */
export function rolloutCwd(codexHome, sessionId) {
  const root = path.join(codexHome, "sessions");
  const suffix = `-${sessionId}.jsonl`;
  for (const y of sortedDirs(root))
    for (const m of sortedDirs(path.join(root, y)))
      for (const d of sortedDirs(path.join(root, y, m))) {
        const dir = path.join(root, y, m, d);
        let names;
        try {
          names = fs.readdirSync(dir);
        } catch {
          continue;
        }
        const name = names.find((n) => n.endsWith(suffix));
        if (!name) continue;
        try {
          const meta = JSON.parse(firstLine(path.join(dir, name)));
          const cwd = meta?.type === "session_meta" ? meta.payload?.cwd : undefined;
          return typeof cwd === "string" && cwd ? cwd : undefined;
        } catch {
          return undefined;
        }
      }
  return undefined;
}

export class SessionStore {
  constructor(codexHome) {
    this.codexHome = codexHome;
    this.known = new Map();
  }

  remember(sessionId, { cwd, addDirs = [] }) {
    if (!sessionId || !cwd) return;
    this.known.delete(sessionId);
    this.known.set(sessionId, { cwd, addDirs });
    if (this.known.size > MAX_SESSIONS) this.known.delete(this.known.keys().next().value);
  }

  /** @returns {{cwd: string, addDirs: string[]} | undefined} */
  lookup(sessionId) {
    const hit = this.known.get(sessionId);
    if (hit) return hit;
    const cwd = rolloutCwd(this.codexHome, sessionId);
    return cwd ? { cwd, addDirs: [] } : undefined;
  }
}
