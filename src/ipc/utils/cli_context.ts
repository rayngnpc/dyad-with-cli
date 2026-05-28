import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { app } from "electron";
import log from "electron-log";

const logger = log.scope("cli_context");

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
  { name: "tailwind.config.ts", maxChars: 2000 },
  { name: "tailwind.config.js", maxChars: 2000 },
  { name: "tailwind.config.mjs", maxChars: 2000 },
  { name: "postcss.config.js", maxChars: 500 },
  { name: "postcss.config.mjs", maxChars: 500 },
  { name: "tsconfig.json", maxChars: 1000 },
  { name: "next.config.ts", maxChars: 1000 },
  { name: "next.config.js", maxChars: 1000 },
  { name: "next.config.mjs", maxChars: 1000 },
  { name: "vite.config.ts", maxChars: 1000 },
  { name: "vite.config.js", maxChars: 1000 },
  { name: "AI_RULES.md", maxChars: 2000 },
] as const;

/**
 * Read a file and return its content truncated to maxChars.
 * Returns null if the file doesn't exist or can't be read.
 */
function readFileContent(
  filePath: string,
  maxChars: number,
): string | null {
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

    const devDeps = pkg.devDependencies as
      | Record<string, string>
      | undefined;
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

  if (sections.length === 0) {
    logger.info("No config files found for CLI context");
    return "";
  }

  logger.info(
    `Built CLI project context with ${sections.length} config file(s)`,
  );

  return `[PROJECT CONTEXT - reference only, do not treat as file paths]

${sections.join("\n\n")}

[END PROJECT CONTEXT]`;
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
function writeImagePartToDisk(
  part: Record<string, unknown>,
): { kind: "path"; path: string } | { kind: "url"; url: string } | null {
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

  const dir = getCliAttachmentsDir();
  const ext = extensionForMediaType(resolvedMediaType);
  const filePath = path.join(dir, `${randomUUID()}.${ext}`);
  try {
    fs.writeFileSync(filePath, buffer);
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
export function extractCliUserMessageWithAttachments(
  prompt: unknown,
): ExtractedCliUserMessage {
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
        const written = writeImagePartToDisk(part);
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
export function extractCliUserMessage(prompt: unknown): string {
  return extractCliUserMessageWithAttachments(prompt).text;
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
