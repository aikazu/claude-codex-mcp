// MCP tool definitions and handlers.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MAX_WAIT_SECONDS, SANDBOXES } from "./config.mjs";
import { buildImagePrompt, collectImages, previewContent } from "./images.mjs";
import { tail } from "./jobs.mjs";
import { listModels } from "./models.mjs";

const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const strList = (v) =>
  Array.isArray(v)
    ? v
        .map(String)
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
const EFFORT_RE = /^[a-z]+$/;

export class ToolError extends Error {}

function existingPath(p, label, { dir = false, create = false } = {}) {
  const abs = path.resolve(p);
  if (create) fs.mkdirSync(abs, { recursive: true });
  if (!fs.existsSync(abs)) throw new ToolError(`${label} not found: ${abs}`);
  if (dir && !fs.statSync(abs).isDirectory()) throw new ToolError(`${label} is not a directory: ${abs}`);
  return abs;
}

function effortArg(value) {
  const effort = str(value)?.toLowerCase();
  if (!effort) return [];
  if (!EFFORT_RE.test(effort)) throw new ToolError(`invalid reasoning_effort: ${value}`);
  return ["-c", `model_reasoning_effort="${effort}"`];
}

function modelArg(value) {
  const model = str(value);
  if (!model) return [];
  if (!/^[\w.:/-]+$/.test(model)) throw new ToolError(`invalid model: ${value}`);
  return ["-m", model];
}

/** Build `codex exec` argv for a delegated task. Pure apart from path checks. */
export function buildTaskArgs(a, config) {
  if (!str(a.prompt)) throw new ToolError("prompt is required");
  const sessionId = str(a.session_id);
  if (sessionId && !/^[\w-]+$/.test(sessionId)) throw new ToolError(`invalid session_id: ${sessionId}`);
  if (a.sandbox !== undefined && !SANDBOXES.includes(a.sandbox))
    throw new ToolError(`sandbox must be one of: ${SANDBOXES.join(", ")}`);
  const sandbox = a.sandbox ?? config.defaultSandbox;
  const cwdIn = str(a.cwd);
  if (!cwdIn && !sessionId) throw new ToolError("cwd is required for a new task (absolute path of the project folder)");
  const cwd = cwdIn ? existingPath(cwdIn, "cwd", { dir: true }) : os.homedir();

  const args = ["exec"];
  if (sessionId) args.push("resume", sessionId);
  args.push("--json", "--skip-git-repo-check");
  // `exec resume` has no -s/-C flags; sandbox goes through config and the
  // working directory through the process cwd.
  if (sessionId) args.push("-c", `sandbox_mode="${sandbox}"`);
  else args.push("-C", cwd, "-s", sandbox);
  if (a.network === true && sandbox === "workspace-write")
    args.push("-c", "sandbox_workspace_write.network_access=true");
  args.push(...modelArg(a.model), ...effortArg(a.reasoning_effort));
  if (!sessionId)
    for (const d of strList(a.add_dirs)) args.push("--add-dir", existingPath(d, "add_dir", { dir: true }));
  for (const img of strList(a.images)) args.push("-i", existingPath(img, "image"));
  return { args, cwd, sandbox, sessionId };
}

/** Build `codex exec` argv + prompt for an image job. */
export function buildImageArgs(a, config) {
  const brief = str(a.prompt);
  if (!brief) throw new ToolError("prompt is required");
  const count = Math.max(1, Math.min(8, Number.parseInt(a.count ?? 1, 10) || 1));
  const outDir = existingPath(str(a.out_dir) || config.assetDir, "out_dir", { dir: true, create: true });
  const refs = strList(a.reference_images).map((r) => existingPath(r, "reference image"));
  const args = ["exec", "--json", "--skip-git-repo-check", "-C", outDir, "-s", "read-only"];
  args.push(...modelArg(a.model), ...effortArg(a.reasoning_effort));
  for (const r of refs) args.push("-i", r);
  const prompt = buildImagePrompt({
    brief,
    count,
    size: str(a.size),
    transparent: a.transparent === true,
    referenceCount: refs.length,
  });
  return { args, prompt, outDir, brief, count };
}

function waitSeconds(v, config) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(MAX_WAIT_SECONDS, n)) : config.defaultWaitSeconds;
}

export function summarize(job) {
  const s = {
    job_id: job.id,
    kind: job.kind,
    status: job.status,
    elapsed_seconds: Math.round(((job.finishedAt || Date.now()) - (job.startedAt || job.createdAt)) / 1000),
    session_id: job.sessionId || undefined,
  };
  if (job.status === "queued" || job.status === "running") {
    s.hint = `Not finished yet. Call codex_job with job_id "${job.id}" to wait for the result.`;
    if (job.messages.length) s.latest_message = tail(job.messages.at(-1), 1500);
    return s;
  }
  if (job.kind === "image") {
    s.out_dir = job.meta.outDir;
    s.files = job.files.map((f) => f.path);
  }
  if (job.finalMessage) s.final_message = job.finalMessage;
  if (job.usage) s.usage = job.usage;
  if (job.errors.length) s.errors = job.errors;
  if (job.status === "failed" && job.stderr) s.stderr_tail = tail(job.stderr, 2500);
  if (job.kind === "task" && job.status === "completed" && job.sessionId)
    s.next = "Pass session_id to codex_task to continue this Codex session.";
  return s;
}

function resultFor(job, config) {
  const content = [{ type: "text", text: JSON.stringify(summarize(job), null, 2) }];
  if (job.kind === "image" && job.finishedAt && job.meta.returnImages) {
    content.push(...previewContent(job.files, { maxBytes: config.previewMaxBytes, maxCount: config.previewMaxCount }));
  }
  return { content, isError: job.status === "failed" };
}

export function toolDefinitions(config) {
  const wait = {
    type: "number",
    description: `Seconds to wait before returning a job_id (0-${MAX_WAIT_SECONDS}, default ${config.defaultWaitSeconds}).`,
  };
  const effort = {
    type: "string",
    description:
      "low | medium | high | xhigh | max | ultra — support varies per model (see codex_models). Omit for the default.",
  };
  return [
    {
      name: "codex_task",
      title: "Delegate to Codex",
      description:
        "Delegate a task to OpenAI Codex, running `codex exec` on this computer with the user's own ChatGPT/Codex subscription. " +
        "Good for a second opinion or code review, implementing a well-scoped change, refactors, writing tests, or digging through a codebase. " +
        "Write a self-contained prompt: goal, relevant files, constraints, and what to report back. Codex works in `cwd`; with sandbox " +
        "workspace-write it can edit files there. Returns Codex's final message plus a session_id that continues the same Codex session. " +
        "Runs longer than wait_seconds return a job_id — poll it with codex_job.",
      inputSchema: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "Complete instructions for Codex." },
          cwd: { type: "string", description: "Absolute path of the working folder (required for a new task)." },
          sandbox: {
            type: "string",
            enum: [...SANDBOXES],
            description: `Default ${config.defaultSandbox}. read-only = analyse only.`,
          },
          network: {
            type: "boolean",
            description: "Allow network inside workspace-write (e.g. package installs). Default false.",
          },
          model: {
            type: "string",
            description: "Codex model slug (see codex_models). Omit to use the user's default.",
          },
          reasoning_effort: effort,
          images: { type: "array", items: { type: "string" }, description: "Absolute paths of images to attach." },
          add_dirs: {
            type: "array",
            items: { type: "string" },
            description: "Extra writable folders (new tasks only).",
          },
          session_id: { type: "string", description: "Continue an earlier Codex session instead of starting fresh." },
          wait_seconds: wait,
        },
        required: ["prompt"],
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    {
      name: "codex_image",
      title: "Generate images with Codex",
      description:
        "Generate image assets with Codex's built-in image_gen tool (GPT Image), billed to the user's ChatGPT/Codex plan — no API key. " +
        "Files are copied into out_dir and small previews are returned so you can check them. Use for icons, sprites, illustrations, " +
        "textures, UI mockups and similar. Supports transparent backgrounds and reference images. Each image typically takes 30-120 s.",
      inputSchema: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "Art direction: subject, style, palette, composition, intended use." },
          out_dir: {
            type: "string",
            description: `Absolute folder to save into (created if missing). Default: ${config.assetDir}`,
          },
          name: { type: "string", description: "File name prefix, e.g. 'coin-icon'." },
          count: { type: "integer", minimum: 1, maximum: 8, description: "Number of images/variants (default 1)." },
          size: { type: "string", description: "e.g. '1024x1024', '1536x1024', '16:9', 'square'." },
          transparent: { type: "boolean", description: "Request a real transparent background." },
          reference_images: {
            type: "array",
            items: { type: "string" },
            description: "Absolute paths of images to edit or match.",
          },
          model: {
            type: "string",
            description:
              "Model for the Codex agent turn that calls image_gen (not the image model). A fast model is enough.",
          },
          reasoning_effort: effort,
          return_images: { type: "boolean", description: "Embed previews in the result (default true)." },
          wait_seconds: wait,
        },
        required: ["prompt"],
      },
      annotations: { destructiveHint: false, openWorldHint: true },
    },
    {
      name: "codex_job",
      title: "Codex job status",
      description: "Wait for or fetch the result of a codex_task / codex_image job, or cancel it.",
      inputSchema: {
        type: "object",
        properties: {
          job_id: { type: "string" },
          wait_seconds: wait,
          cancel: { type: "boolean", description: "Stop the job." },
        },
        required: ["job_id"],
      },
    },
    {
      name: "codex_jobs",
      title: "List Codex jobs",
      description: "List recent jobs started by this server (status, kind, session_id).",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true },
    },
    {
      name: "codex_models",
      title: "List Codex models",
      description:
        "List Codex models available to the user's account (slug, description, supported reasoning efforts, default effort) and the " +
        "configured default from config.toml. Use before choosing `model` / `reasoning_effort`.",
      inputSchema: {
        type: "object",
        properties: { include_hidden: { type: "boolean", description: "Also list hidden/special-purpose models." } },
      },
      annotations: { readOnlyHint: true },
    },
  ];
}

/**
 * @param {{config: object, jobs: import('./jobs.mjs').JobManager, launcher: () => object}} deps
 */
export function createToolHandler({ config, jobs, launcher }) {
  const handlers = {
    async codex_task(a, ctx) {
      const { args, cwd, sandbox, sessionId } = buildTaskArgs(a, config);
      const job = jobs.submit({
        kind: "task",
        args,
        cwd,
        prompt: str(a.prompt),
        meta: { sandbox, resumeOf: sessionId },
      });
      return resultFor(await jobs.wait(job, waitSeconds(a.wait_seconds, config), ctx.progress), config);
    },

    async codex_image(a, ctx) {
      const { args, prompt, outDir, brief, count } = buildImageArgs(a, config);
      const job = jobs.submit({
        kind: "image",
        args,
        cwd: outDir,
        prompt,
        meta: { outDir, brief, count, name: str(a.name), returnImages: a.return_images !== false },
        onFinish: (j) => collectImages(j, config.generatedImagesDir),
      });
      return resultFor(await jobs.wait(job, waitSeconds(a.wait_seconds, config), ctx.progress), config);
    },

    async codex_job(a, ctx) {
      const job = jobs.get(a.job_id);
      if (!job) throw new ToolError(`Unknown job_id ${a.job_id} (jobs live only as long as this server process).`);
      if (a.cancel === true) {
        jobs.cancel(job);
        await jobs.wait(job, 10);
      } else await jobs.wait(job, waitSeconds(a.wait_seconds, config), ctx.progress);
      return resultFor(job, config);
    },

    async codex_jobs() {
      const list = jobs.list().map((j) => ({
        job_id: j.id,
        kind: j.kind,
        status: j.status,
        session_id: j.sessionId || undefined,
        created: new Date(j.createdAt).toISOString(),
        elapsed_seconds: Math.round(((j.finishedAt || Date.now()) - (j.startedAt || j.createdAt)) / 1000),
      }));
      return { content: [{ type: "text", text: JSON.stringify(list, null, 2) }] };
    },

    async codex_models(a) {
      const data = listModels(launcher(), config.codexHome, { includeHidden: a.include_hidden === true });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    },
  };

  return async function callTool(name, args = {}, ctx = {}) {
    const handler = Object.hasOwn(handlers, name) ? handlers[name] : null;
    if (!handler) throw new ToolError(`Unknown tool: ${name}`);
    return handler(args ?? {}, ctx);
  };
}
