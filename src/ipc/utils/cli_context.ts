import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { app } from "electron";
import log from "electron-log";

const logger = log.scope("cli_context");

/**
 * Both Gemini CLI's `read_file` and OpenCode's `read` tools return file
 * contents wrapped in pseudo-XML:
 *
 *   <path>/abs/path/to/file</path> <type>file</type> <content>
 *   1: line one
 *   2: line two
 *   </content>
 *
 * Embedding that verbatim inside `<dyad-read>` makes the chat UI show
 * the wrapper tags + line-number prefixes as raw text. This helper
 * extracts just the file body and strips the "N: " prefix so the card
 * shows the file's actual contents (matching API-provider rendering).
 *
 * Falls through to the raw output for unrecognized formats so we never
 * accidentally truncate non-wrapped output.
 */
export function unwrapCliFileReadContent(raw: string): string {
  if (!raw) return raw;
  const match = raw.match(/<content>([\s\S]*?)<\/content>/);
  if (!match) return raw;
  const inner = match[1].trim();
  const stripped = inner
    .split("\n")
    .map((line) => line.replace(/^\s*\d+:\s?/, ""))
    .join("\n");
  return stripped;
}

/**
 * Forcefully terminate a CLI subprocess on abort.
 *
 * Background: when a user stops a chat mid-stream in Dyad, we send
 * SIGTERM to the CLI subprocess. Some CLIs (notably Gemini CLI) catch
 * SIGTERM and continue running their current HTTP request — which may
 * be stuck in an internal exponential-backoff retry loop after a 429.
 * The process visibly keeps firing API calls in the terminal long
 * after the user clicked Stop.
 *
 * This helper:
 *   1. Sends SIGTERM (polite — lets the CLI clean up state)
 *   2. After `gracePeriodMs` (default 2s), if the process is still
 *      alive, sends SIGKILL (forceful — bypasses signal handlers)
 *
 * Safe to call multiple times and on already-exited processes — guards
 * against `proc.killed` / `proc.exitCode !== null`.
 */
export function forceKillCliProcess(
  proc: ChildProcess | undefined | null,
  label: string,
  gracePeriodMs = 2000,
): void {
  if (!proc) return;
  if (proc.killed || proc.exitCode !== null) return;
  try {
    proc.kill("SIGTERM");
  } catch (e) {
    logger.debug(`${label}: SIGTERM threw: ${(e as Error).message}`);
  }
  setTimeout(() => {
    if (!proc.killed && proc.exitCode === null) {
      logger.warn(
        `${label}: SIGTERM did not terminate process within ${gracePeriodMs}ms — escalating to SIGKILL`,
      );
      try {
        proc.kill("SIGKILL");
      } catch (e) {
        logger.debug(`${label}: SIGKILL threw: ${(e as Error).message}`);
      }
    }
  }, gracePeriodMs);
}

/**
 * Key config files to read for CLI provider context.
 * These files help CLI models understand the project setup
 * (framework, CSS config, TypeScript config) without needing
 * to manually read them via tool calls.
 *
 * NOTE: package.json is handled separately via summarizePackageJson()
 * to avoid ENAMETOOLONG errors — Gemini CLI's tools try to interpret
 * raw dependency names (e.g., "@supabase/supabase-js") as file paths.
 */
const CONFIG_FILES = [
  // CSS / styling
  { name: "tailwind.config.ts", maxChars: 2000 },
  { name: "tailwind.config.js", maxChars: 2000 },
  { name: "tailwind.config.mjs", maxChars: 2000 },
  { name: "postcss.config.js", maxChars: 500 },
  { name: "postcss.config.mjs", maxChars: 500 },
  // TypeScript
  { name: "tsconfig.json", maxChars: 1000 },
  { name: "tsconfig.app.json", maxChars: 800 },
  // Framework configs
  { name: "next.config.ts", maxChars: 1000 },
  { name: "next.config.js", maxChars: 1000 },
  { name: "next.config.mjs", maxChars: 1000 },
  { name: "vite.config.ts", maxChars: 1000 },
  { name: "vite.config.js", maxChars: 1000 },
  { name: "astro.config.mjs", maxChars: 1000 },
  { name: "svelte.config.js", maxChars: 800 },
  // ORM / DB
  { name: "drizzle.config.ts", maxChars: 800 },
  { name: "drizzle.config.js", maxChars: 800 },
  { name: "prisma/schema.prisma", maxChars: 3000 },
  // Component libraries
  { name: "components.json", maxChars: 600 }, // shadcn/ui
  // Linting / formatting
  { name: "biome.json", maxChars: 800 },
  // Project guidance (most important — Dyad scaffolds this per project)
  { name: "AI_RULES.md", maxChars: 2500 },
  { name: "README.md", maxChars: 1500 },
] as const;

/**
 * Dyad-flavored preamble for CLI providers. We strip Dyad's full system
 * prompt (it instructs models to emit <dyad-*> XML tags which conflict
 * with CLI native tools), but a slim preamble gives CLI models the
 * essential context that they're operating inside Dyad and how to behave
 * — without the conflicting tag instructions.
 *
 * Keep this SHORT and SAFE. Don't include anything that overlaps with
 * the CLI's own system prompt or that mentions specific tag formats.
 */
const DYAD_CLI_PREAMBLE = `[DYAD ASSISTANT CONTEXT]
You are operating inside Dyad — an AI app builder. The user is editing a real, running web app. Every file you write, edit, rename, or delete triggers a live preview reload that the user sees immediately on the right side of their screen.

## Operating principles
- Make minimal, focused changes. Don't refactor surrounding code unless the user asks.
- Before proceeding, check whether the user's request is already implemented. If it is, point that out instead of duplicating work.
- Only edit files related to the user's request. Leave everything else alone.
- Use your native tools (file write/edit/read/grep/shell) — Dyad converts them into the same UI cards the user sees for API providers.

## Code quality rules (these are non-negotiable in Dyad)
- ALWAYS generate responsive designs (mobile + tablet + desktop). Tailwind utility classes preferred unless AI_RULES.md says otherwise.
- DO NOT catch errors with try/catch unless the user explicitly asks. Errors must bubble up so the user (and you) see them on the next turn.
- DO NOT overengineer. Avoid complex error handling, fallback chains, or speculative abstractions unless the user requests them. Keep code simple and elegant.
- Aim for components ≤ 100 lines. If a file is growing past that, ask the user before splitting it.
- Create a NEW file for every new component or hook, no matter how small. Never add new components to existing files.
- Use toast components (the project's notification utility) for user-facing success/error events when relevant.
- Verify every import you write actually resolves. First-party imports must point at files that exist (or that you create in the same turn). Third-party imports must be in package.json (or you must install them — see below).

## Dependencies
- The project ALREADY has shadcn/ui + Radix UI + lucide-react installed if AI_RULES.md says so. Don't reinstall them.
- To install a new dependency, run \`npm install <pkg>\` via your shell tool. Dyad detects npm-install commands and shows them in the UI as an installation card — same as it does for API providers.
- For multiple packages, install them in a single command: \`npm install pkg-a pkg-b pkg-c\`.

## Thinking before you act
Before writing code for any non-trivial request, walk through your reasoning briefly (a few bullet points is fine):
1. What is the user asking for?
2. Which files are involved?
3. What's the minimal change that satisfies the request?
4. Anything I might break or any assumption to verify?

Then proceed with the implementation.

## When to suggest a user action
If the app needs to be rebuilt or refreshed, you can hint at it in plain text — e.g. "you'll want to rebuild the app for this to take effect" — and the user can click Rebuild / Restart / Refresh in the UI. Don't tell users to run shell commands themselves; the UI controls everything for them.

## Wrapping up your response
At the end of every response that involved code changes, give a ONE-sentence non-technical summary of what changed (suitable for someone who doesn't read code).

## What NOT to do
- Don't tell the user to run shell commands manually — you have shell tools.
- Don't write partial implementations or leave TODO comments. Either complete the feature or clearly say which parts you've left for a follow-up turn.
- Don't introduce new state management libraries (Redux etc.) unless explicitly asked. React's built-in state + context is preferred.
- Don't use markdown code blocks (\`\`\`) to show file content you're writing. Use your file-write tool. Markdown code blocks are fine inside explanations.
[END DYAD ASSISTANT CONTEXT]`;

/**
 * Read a file and return its content truncated to maxChars.
 * Returns null if the file doesn't exist or can't be read.
 */
function readFileContent(filePath: string, maxChars: number): string | null {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    if (content.length > maxChars) {
      return content.substring(0, maxChars) + "\n... (truncated)";
    }
    return content;
  } catch {
    return null;
  }
}

/**
 * Summarize package.json into a flat, human-readable format.
 * Avoids including raw JSON with path-like dependency names
 * (e.g., "@supabase/supabase-js") that Gemini CLI's internal
 * tools try to stat as file paths, causing ENAMETOOLONG errors.
 */
function summarizePackageJson(cwd: string): string | null {
  try {
    const raw = fs.readFileSync(path.join(cwd, "package.json"), "utf-8");
    const pkg = JSON.parse(raw) as Record<string, unknown>;

    const lines: string[] = [];
    if (pkg.name) lines.push(`Name: ${pkg.name}`);

    // List dependencies as "name@version" (no JSON, no path-like strings)
    const deps = pkg.dependencies as Record<string, string> | undefined;
    if (deps && Object.keys(deps).length > 0) {
      lines.push(
        `Dependencies: ${Object.entries(deps)
          .map(([name, ver]) => `${name}@${ver}`)
          .join(", ")}`,
      );
    }

    const devDeps = pkg.devDependencies as Record<string, string> | undefined;
    if (devDeps && Object.keys(devDeps).length > 0) {
      lines.push(
        `DevDependencies: ${Object.entries(devDeps)
          .map(([name, ver]) => `${name}@${ver}`)
          .join(", ")}`,
      );
    }

    const scripts = pkg.scripts as Record<string, string> | undefined;
    if (scripts && Object.keys(scripts).length > 0) {
      lines.push(
        `Scripts: ${Object.entries(scripts)
          .map(([name, cmd]) => `${name}="${cmd}"`)
          .join(", ")}`,
      );
    }

    return lines.length > 0 ? lines.join("\n") : null;
  } catch {
    return null;
  }
}

/**
 * Build project context for CLI providers by reading key config files.
 * This replaces the Dyad system prompt (which contains conflicting
 * instructions about <dyad-write> tags) with actual project context
 * that helps the CLI model understand the project setup.
 */
/**
 * Walk the project's `src/` directory (or root if no src/) and produce a
 * compact text map of source files: relative path + line count + the
 * first few lines (imports / first export). Gives the CLI model a sense
 * of project shape without sending the full codebase. The CLI's own
 * file-reading tools can drill into anything that looks relevant.
 */
function buildCodebaseMap(cwd: string, totalBudgetChars = 8000): string {
  const candidates = ["src", "app", "pages", "components"];
  let rootDir: string | null = null;
  for (const sub of candidates) {
    const p = path.join(cwd, sub);
    try {
      const stat = fs.statSync(p);
      if (stat.isDirectory()) {
        rootDir = p;
        break;
      }
    } catch {
      // not present; try next
    }
  }
  // Fall back to project root if no recognizable source dir.
  if (!rootDir) rootDir = cwd;

  const collected: { rel: string; preview: string; lineCount: number }[] = [];
  const SKIP_DIRS = new Set([
    "node_modules",
    "dist",
    "build",
    "out",
    ".next",
    ".turbo",
    ".cache",
    ".git",
    "coverage",
    "userData",
  ]);
  const ALLOW_EXTS = new Set([
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".vue",
    ".svelte",
    ".astro",
    ".css",
    ".scss",
    ".html",
    ".md",
  ]);

  function walk(dir: string, depth: number): void {
    if (depth > 6) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (ent.name.startsWith(".")) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name)) continue;
        walk(full, depth + 1);
        continue;
      }
      if (!ent.isFile()) continue;
      const ext = path.extname(ent.name);
      if (!ALLOW_EXTS.has(ext)) continue;
      try {
        const raw = fs.readFileSync(full, "utf-8");
        const lines = raw.split("\n");
        // Preview = first 8 non-empty lines (imports + first declaration)
        const preview = lines
          .filter((l) => l.trim().length > 0)
          .slice(0, 8)
          .join("\n");
        collected.push({
          rel: path.relative(cwd, full),
          preview,
          lineCount: lines.length,
        });
      } catch {
        // skip unreadable
      }
    }
  }

  walk(rootDir, 0);

  // Sort: prioritize files closer to project root, then alphabetical
  collected.sort((a, b) => {
    const da = a.rel.split(path.sep).length;
    const db = b.rel.split(path.sep).length;
    if (da !== db) return da - db;
    return a.rel.localeCompare(b.rel);
  });

  // Emit entries until we exceed the budget
  const blocks: string[] = [];
  let used = 0;
  for (const f of collected) {
    const block = `### ${f.rel} (${f.lineCount} lines)\n${f.preview}`;
    if (used + block.length > totalBudgetChars) {
      blocks.push(
        `... (${collected.length - blocks.length} more files omitted; use your read tool to access them by path)`,
      );
      break;
    }
    blocks.push(block);
    used += block.length;
  }

  if (blocks.length === 0) return "";
  return `[CODEBASE MAP - relative paths + previews. Use your file-read tool to fetch full contents on demand.]

${blocks.join("\n\n")}

[END CODEBASE MAP]`;
}

export function buildCliProjectContext(cwd: string): string {
  const sections: string[] = [];

  // Summarize package.json in a safe, flat format
  const pkgSummary = summarizePackageJson(cwd);
  if (pkgSummary !== null) {
    sections.push(`### package.json (summary)\n${pkgSummary}`);
  }

  for (const config of CONFIG_FILES) {
    const filePath = path.join(cwd, config.name);
    const content = readFileContent(filePath, config.maxChars);
    if (content !== null) {
      sections.push(`### ${config.name}\n\`\`\`\n${content}\n\`\`\``);
    }
  }

  // Even if no config files are found, still send the Dyad preamble so
  // the model knows it's working inside Dyad.
  const projectSection =
    sections.length > 0
      ? `[PROJECT CONTEXT - reference only, do not treat as file paths]

${sections.join("\n\n")}

[END PROJECT CONTEXT]`
      : "";

  // Codebase map gives the model an overview of files in the project.
  const codebaseMap = buildCodebaseMap(cwd);

  logger.info(
    `Built CLI project context with ${sections.length} config file(s) + codebase map (${codebaseMap.length} chars)`,
  );

  return [DYAD_CLI_PREAMBLE, projectSection, codebaseMap]
    .filter((s) => s && s.length > 0)
    .join("\n\n");
}

/**
 * Build a [REFERENCED APP CONTEXT] block for any `@app:Name` mentions in
 * the user message. Each mentioned app gets its AI_RULES.md + a slim
 * codebase map injected so the CLI knows about cross-referenced apps.
 *
 * `appNameToPath` is a resolver the caller provides — Dyad's main process
 * has the chat → app mapping, so chat_stream_handlers can look up the
 * absolute path for any @app:Name token. We don't reach into the Dyad
 * DB from here to keep this module dependency-free.
 *
 * Returns "" if no mentions are found or no apps could be resolved.
 */
export function buildReferencedAppsContext(
  userMessage: string,
  appNameToPath: (name: string) => string | null,
  options?: { maxApps?: number; codebaseMapBudget?: number },
): string {
  const maxApps = options?.maxApps ?? 3;
  const mapBudget = options?.codebaseMapBudget ?? 4000;

  // Match @app:Name with optional whitespace-separated extensions
  // (most cases) and quoted variants. Names can contain dashes and dots.
  const matches = Array.from(
    userMessage.matchAll(/@app:([A-Za-z0-9_\-.]+)/g),
  ).map((m) => m[1]);
  if (matches.length === 0) return "";

  const uniqueNames = Array.from(new Set(matches)).slice(0, maxApps);
  const blocks: string[] = [];
  for (const name of uniqueNames) {
    const appPath = appNameToPath(name);
    if (!appPath) {
      blocks.push(`### @app:${name}\n(app not found — skipped)`);
      continue;
    }
    const rules = readFileContent(path.join(appPath, "AI_RULES.md"), 2000);
    const map = buildCodebaseMap(appPath, mapBudget);
    const inner = [rules ? `--- AI_RULES.md ---\n${rules}` : "", map]
      .filter((s) => s.length > 0)
      .join("\n\n");
    blocks.push(
      `### @app:${name} (path: ${appPath})\n${inner || "(no readable context)"}`,
    );
  }
  if (blocks.length === 0) return "";
  return `[REFERENCED APP CONTEXT - other Dyad apps the user referenced via @app:Name]

${blocks.join("\n\n")}

[END REFERENCED APP CONTEXT]`;
}

/**
 * Format prior conversation turns into a transcript block. This is
 * prepended to the FIRST user message of a CLI session so the model
 * has context from earlier in the chat (which may have used a different
 * provider, or which exists in Dyad's UI but not in the CLI's own
 * session storage). Skipped for subsequent turns — the CLI's session
 * carries history forward natively.
 *
 * Limit to the last `maxTurns` non-system messages to avoid sending
 * an unbounded transcript on long chats. Each message is also truncated
 * to `maxCharsPerMessage` to keep things bounded.
 */
export function buildConversationHistorySection(
  prompt: unknown,
  options?: { maxTurns?: number; maxCharsPerMessage?: number },
): string {
  if (!Array.isArray(prompt)) return "";

  const maxTurns = options?.maxTurns ?? 12;
  const maxChars = options?.maxCharsPerMessage ?? 1500;

  const turns = (prompt as Array<Record<string, unknown>>)
    .filter((msg) => msg.role === "user" || msg.role === "assistant")
    .map((msg) => {
      let text = "";
      if (typeof msg.content === "string") {
        text = msg.content;
      } else if (Array.isArray(msg.content)) {
        text = (msg.content as Array<Record<string, unknown>>)
          .filter((p) => p.type === "text" && typeof p.text === "string")
          .map((p) => p.text as string)
          .join("\n");
      }
      return { role: msg.role as "user" | "assistant", text: text.trim() };
    })
    .filter((t) => t.text.length > 0);

  // Drop the LAST user turn — that one is the current prompt, sent
  // separately. We only want PRIOR turns in the history block.
  if (turns.length > 0 && turns[turns.length - 1].role === "user") {
    turns.pop();
  }

  if (turns.length === 0) return "";

  // Keep only the most-recent maxTurns
  const recent = turns.slice(-maxTurns);

  const formatted = recent
    .map((t) => {
      const role = t.role === "user" ? "User" : "Assistant";
      const body =
        t.text.length > maxChars
          ? `${t.text.slice(0, maxChars)}\n... (truncated)`
          : t.text;
      return `--- ${role} ---\n${body}`;
    })
    .join("\n\n");

  return `[PRIOR CONVERSATION - for context only, this is what already happened in this chat]

${formatted}

[END PRIOR CONVERSATION]`;
}

/**
 * Result of extracting a user message together with any inline image
 * attachments that should be forwarded to the CLI process.
 *
 * - `text` is the joined text content of the last user message (or the
 *   fallback non-system messages) just like `extractCliUserMessage` returns.
 * - `imagePaths` is a list of absolute local file paths the caller should
 *   pass to the CLI (e.g. via `-f <path>` for OpenCode, `@<path>` for
 *   Gemini) and clean up via `cleanupCliAttachments` once the spawn
 *   process exits.
 *
 * Remote URL images (http/https) that are NOT downloaded by us appear in
 * `imageUrls` so providers that support remote URLs (Gemini @-mention)
 * can still surface them without needing a local copy.
 */
export interface ExtractedCliUserMessage {
  text: string;
  imagePaths: string[];
  imageUrls: string[];
}

/**
 * Minimal MIME -> file extension map. Kept small on purpose — we only
 * write images so we only need image types here. Anything we don't
 * recognise falls back to `bin` so the file still gets written.
 */
const MIME_EXTENSION_MAP: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/svg+xml": "svg",
  "image/tiff": "tiff",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/avif": "avif",
};

function extensionForMediaType(mediaType: string | undefined): string {
  if (!mediaType) return "bin";
  const lower = mediaType.toLowerCase().trim();
  if (MIME_EXTENSION_MAP[lower]) return MIME_EXTENSION_MAP[lower];
  // Generic "image/<subtype>" → use the subtype as extension
  const match = lower.match(/^image\/([a-z0-9.+-]+)/);
  if (match) {
    // Strip any "+xml" / "+json" suffix
    return match[1].split("+")[0];
  }
  return "bin";
}

/**
 * Returns the directory where CLI image attachments are staged on disk.
 * Idempotent — creates the directory on first call.
 */
function getCliAttachmentsDir(): string {
  const dir = path.join(app.getPath("userData"), "cli-attachments");
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    // Ignore EEXIST; surface anything else via the caller's try/catch.
    if (
      !(e instanceof Error) ||
      !(e as NodeJS.ErrnoException).code ||
      (e as NodeJS.ErrnoException).code !== "EEXIST"
    ) {
      logger.debug(
        `mkdir cli-attachments failed (continuing): ${(e as Error).message}`,
      );
    }
  }
  return dir;
}

/**
 * Strip a `data:image/...;base64,` prefix if present and return the raw
 * base64 payload. If no prefix is present the input is returned as-is.
 */
function stripDataUrlPrefix(value: string): {
  base64: string;
  mediaType?: string;
} {
  const match = value.match(/^data:([^;]+);base64,(.*)$/s);
  if (match) {
    return { base64: match[2], mediaType: match[1] };
  }
  return { base64: value };
}

/**
 * Write a single image part to a temp file and return the absolute path.
 * Returns `null` if the part shape is unrecognised or the write fails.
 */
async function writeImagePartToDisk(
  part: Record<string, unknown>,
): Promise<
  { kind: "path"; path: string } | { kind: "url"; url: string } | null
> {
  // Two shapes to handle:
  //   1. AI SDK ImagePart:  { type: "image", image: <data|URL>, mediaType?: string }
  //   2. LanguageModelV2FilePart (image/*):
  //         { type: "file", mediaType: "image/png", data: <data|URL>, filename?: string }
  const partType = part.type;
  const isImage = partType === "image";
  const isImageFile =
    partType === "file" &&
    typeof part.mediaType === "string" &&
    (part.mediaType as string).toLowerCase().startsWith("image/");

  if (!isImage && !isImageFile) return null;

  const mediaType = (part.mediaType as string | undefined) ?? undefined;
  const rawData = (isImage ? part.image : part.data) as unknown;

  if (rawData == null) return null;

  // ----- URL handling -----------------------------------------------------
  // URL instances and `http(s)://` strings: surface the URL string back to
  // the caller; do NOT write to disk. Each CLI decides what to do (Gemini
  // can @-mention a URL; OpenCode -f wants a local file).
  if (rawData instanceof URL) {
    return { kind: "url", url: rawData.toString() };
  }
  if (typeof rawData === "string") {
    if (/^https?:\/\//i.test(rawData)) {
      return { kind: "url", url: rawData };
    }
  }

  // ----- Binary data handling --------------------------------------------
  let buffer: Buffer | null = null;
  let resolvedMediaType = mediaType;

  if (rawData instanceof Uint8Array) {
    // Buffer.from(Uint8Array) copies — keep it simple and correct.
    buffer = Buffer.from(rawData);
  } else if (rawData instanceof ArrayBuffer) {
    buffer = Buffer.from(rawData);
  } else if (typeof rawData === "string") {
    // base64 string, optionally with a data: prefix.
    const stripped = stripDataUrlPrefix(rawData);
    if (!resolvedMediaType && stripped.mediaType) {
      resolvedMediaType = stripped.mediaType;
    }
    try {
      buffer = Buffer.from(stripped.base64, "base64");
    } catch (e) {
      logger.warn(
        `Failed to decode base64 image part: ${(e as Error).message}`,
      );
      return null;
    }
  } else if (
    typeof rawData === "object" &&
    rawData !== null &&
    Buffer.isBuffer(rawData)
  ) {
    buffer = rawData;
  }

  if (!buffer || buffer.length === 0) return null;

  // Resize+re-encode large images so CLI-routed endpoints (especially
  // GitHub Copilot, which caps payload around 1 MB) accept them.
  // Annotator screenshots arrive as full-resolution PNGs that are
  // routinely 1-5 MB; that's "Request Entity Too Large" territory.
  //
  // Strategy:
  //   - Skip if buffer is already small (≤ MAX_BYTES).
  //   - Resize longer dimension to fit MAX_DIM (1568 px).
  //   - Re-encode as JPEG q85 (lossless PNG is overkill for visual
  //     context; JPEG keeps files small without obvious quality loss).
  //   - On any sharp failure, fall through to the original buffer.
  const MAX_BYTES = 1_000_000;
  const MAX_DIM = 1568;
  let outBuffer = buffer;
  let outExt = extensionForMediaType(resolvedMediaType);
  if (buffer.length > MAX_BYTES) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const sharp = require("sharp");
      const resized = await sharp(buffer)
        .resize({
          width: MAX_DIM,
          height: MAX_DIM,
          fit: "inside",
          withoutEnlargement: true,
        })
        .jpeg({ quality: 85, mozjpeg: true })
        .toBuffer();
      logger.info(
        `Resized CLI image attachment: ${buffer.length} -> ${resized.length} bytes`,
      );
      outBuffer = resized;
      outExt = "jpg";
    } catch (e) {
      logger.warn(
        `Image resize failed (${buffer.length} bytes), sending original: ${(e as Error).message}`,
      );
    }
  }

  const dir = getCliAttachmentsDir();
  const filePath = path.join(dir, `${randomUUID()}.${outExt}`);
  try {
    fs.writeFileSync(filePath, outBuffer);
    return { kind: "path", path: filePath };
  } catch (e) {
    logger.warn(
      `Failed to write CLI attachment ${filePath}: ${(e as Error).message}`,
    );
    return null;
  }
}

/**
 * Extract the user message AND any image attachments from a prompt array
 * for CLI providers.
 *
 * Image parts are written to `<userData>/cli-attachments/<uuid>.<ext>` so
 * they can be passed to CLI binaries via flags (`-f` for OpenCode) or
 * inlined as `@<path>` mentions (Gemini). Remote URLs are returned in
 * `imageUrls` without being downloaded.
 *
 * Callers MUST call `cleanupCliAttachments(result.imagePaths)` once the
 * spawned process closes so we don't leak temp files.
 */
export async function extractCliUserMessageWithAttachments(
  prompt: unknown,
): Promise<ExtractedCliUserMessage> {
  // String prompts have no parts → no attachments possible.
  if (typeof prompt === "string") {
    return { text: prompt, imagePaths: [], imageUrls: [] };
  }
  if (!Array.isArray(prompt)) {
    return { text: String(prompt), imagePaths: [], imageUrls: [] };
  }

  const imagePaths: string[] = [];
  const imageUrls: string[] = [];
  let userMessage = "";
  let foundUserMessage = false;

  // Find the LAST user message (skip system prompts entirely). This mirrors
  // the original extractCliUserMessage behavior — only the most recent user
  // message's attachments are considered current.
  for (let i = prompt.length - 1; i >= 0; i--) {
    const msg = prompt[i] as Record<string, unknown>;
    if (msg.role !== "user") continue;

    if (typeof msg.content === "string") {
      userMessage = msg.content;
      foundUserMessage = true;
      break;
    }
    if (Array.isArray(msg.content)) {
      const textParts: string[] = [];
      for (const part of msg.content as Array<Record<string, unknown>>) {
        if (part.type === "text" && typeof part.text === "string") {
          textParts.push(part.text);
          continue;
        }
        // Try to materialise image parts; ignore the rest silently so we
        // don't break tool-call results or other future parts.
        const written = await writeImagePartToDisk(part);
        if (!written) continue;
        if (written.kind === "path") imagePaths.push(written.path);
        else imageUrls.push(written.url);
      }
      userMessage = textParts.join("\n");
      foundUserMessage = true;
      break;
    }
  }

  // Fallback: concatenate non-system messages (no attachments — this branch
  // only triggers when the loop above didn't find any user role, which is
  // rare and historically only happens for malformed prompts).
  if (!foundUserMessage) {
    userMessage = (prompt as Array<Record<string, unknown>>)
      .filter((msg) => msg.role !== "system")
      .map((msg) => {
        if (typeof msg.content === "string") {
          return `${msg.role}: ${msg.content}`;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }

  if (imagePaths.length > 0 || imageUrls.length > 0) {
    logger.info(
      `Extracted CLI attachments: ${imagePaths.length} file(s), ${imageUrls.length} URL(s)`,
    );
  }

  return { text: userMessage, imagePaths, imageUrls };
}

/**
 * Extract the user message from a prompt array for CLI providers.
 *
 * IMPORTANT: This strips Dyad's system prompt because CLI providers
 * (Gemini CLI, OpenCode) have their own system prompts and tools.
 * Dyad's system prompt contains instructions about <dyad-write> tags
 * which conflict with the CLI's native tools (write_file, replace, etc.).
 *
 * Instead, the caller should prepend buildCliProjectContext() output
 * to give the model actual project context.
 *
 * Thin wrapper around `extractCliUserMessageWithAttachments`. Use the
 * full function when you need image attachments — this one drops them
 * (and is kept for any caller that doesn't care).
 */
export async function extractCliUserMessage(prompt: unknown): Promise<string> {
  return (await extractCliUserMessageWithAttachments(prompt)).text;
}

/**
 * Delete temporary CLI attachment files created by
 * `extractCliUserMessageWithAttachments`. Safe to call with paths that
 * no longer exist — ENOENT is swallowed. Other errors are logged at
 * debug level so a failed cleanup never breaks the chat flow.
 */
export function cleanupCliAttachments(paths: string[]): void {
  if (!paths || paths.length === 0) return;
  for (const p of paths) {
    try {
      fs.unlinkSync(p);
      logger.debug(`Cleaned up CLI attachment: ${p}`);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT") continue;
      logger.debug(
        `Failed to clean up CLI attachment ${p}: ${(e as Error).message}`,
      );
    }
  }
}
