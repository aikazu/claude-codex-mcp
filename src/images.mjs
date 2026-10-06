// Image post-processing: find what Codex's built-in image_gen produced for a
// job, copy it next to the user's project, and build MCP image previews.
//
// image_gen has no destination argument; Codex writes into
// $CODEX_HOME/generated_images/<thread-id>/… . We attribute files to a job by
// (1) paths mentioned in the job's JSON events, (2) the job's thread id in the
// path, then (3) modification time inside the job's run window.

import fs from "node:fs";
import path from "node:path";

export const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
const THREAD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MIME = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" };

export function walkImages(dir, sinceMs, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkImages(p, sinceMs, out);
    else if (IMAGE_EXT.has(path.extname(e.name).toLowerCase())) {
      try {
        const st = fs.statSync(p);
        if (st.mtimeMs >= sinceMs) out.push({ p, mtime: st.mtimeMs });
      } catch {
        /* vanished */
      }
    }
  }
  return out;
}

export function slug(text, fallback = "asset") {
  const v = String(text || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return v || fallback;
}

export function uniquePath(dir, base, ext) {
  let p = path.join(dir, `${base}${ext}`);
  for (let i = 2; fs.existsSync(p); i++) p = path.join(dir, `${base}-${i}${ext}`);
  return p;
}

/** Locate this job's generated images and copy them into meta.outDir. */
export function collectImages(job, generatedImagesDir) {
  const since = (job.startedAt ?? job.createdAt) - 2000;
  const found = new Map();
  for (const f of walkImages(generatedImagesDir, since)) found.set(path.resolve(f.p), f);
  for (const m of job.mentionedPaths) {
    const abs = path.resolve(m);
    if (!found.has(abs) && fs.existsSync(abs)) found.set(abs, { p: abs, mtime: fs.statSync(abs).mtimeMs });
  }
  let list = [...found.values()];
  const mentioned = new Set([...job.mentionedPaths].map((m) => path.resolve(m)));
  const mine = list.filter((f) => mentioned.has(path.resolve(f.p)) || (job.sessionId && f.p.includes(job.sessionId)));
  if (mine.length) list = mine;
  else {
    // Nothing is tied to this job. CODEX_HOME is shared with other Codex
    // clients (e.g. the desktop app), so skip other threads' folders and keep
    // only the newest files this job asked for.
    const foreign = (p) =>
      path
        .relative(generatedImagesDir, p)
        .split(/[\\/]/)
        .some((seg) => THREAD_ID_RE.test(seg) && seg !== job.sessionId);
    list = list
      .filter((f) => !foreign(f.p))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, job.meta.count ?? list.length);
  }
  list.sort((a, b) => a.mtime - b.mtime);

  fs.mkdirSync(job.meta.outDir, { recursive: true });
  const base = slug(job.meta.name || job.meta.brief);
  for (const f of list) {
    const dest = uniquePath(job.meta.outDir, base, path.extname(f.p).toLowerCase());
    fs.copyFileSync(f.p, dest);
    job.files.push({ path: dest, source: f.p, bytes: fs.statSync(dest).size });
  }
  if (list.length === 0) job.errors.push(`Codex finished but no new image was found in ${generatedImagesDir}`);
}

export function previewContent(files, { maxBytes, maxCount }) {
  const out = [];
  for (const f of files) {
    if (out.length >= maxCount) break;
    if (f.bytes > maxBytes) continue;
    const ext = path.extname(f.path).slice(1).toLowerCase();
    out.push({ type: "image", data: fs.readFileSync(f.path).toString("base64"), mimeType: MIME[ext] || "image/png" });
  }
  return out;
}

/** The instruction Codex receives for an image job. */
export function buildImagePrompt({ brief, count, size, transparent, referenceCount }) {
  const lines = [
    `$imagegen Use the built-in image_gen tool to create ${count} image${count > 1 ? "s" : ""}.`,
    "",
    `Brief: ${brief}`,
  ];
  if (size) lines.push(`Size / aspect ratio: ${size}`);
  if (transparent) lines.push("Background: genuinely transparent (real alpha channel), clean cutout, no checkerboard.");
  if (referenceCount) lines.push(`${referenceCount} reference image(s) are attached; use them as the brief describes.`);
  lines.push(
    "",
    "Rules:",
    `- Make exactly ${count} image_gen call(s): one per image/variant${count > 1 ? " (vary them meaningfully)" : ""}.`,
    "- Do not write scripts, run shell commands, or move/copy/rename files; the caller collects outputs from generated_images.",
    "- Do not fall back to the API/CLI path or ask for OPENAI_API_KEY. If image_gen is unavailable, say so and stop.",
    "- Finish with one short line per image describing it.",
  );
  return lines.join("\n");
}
