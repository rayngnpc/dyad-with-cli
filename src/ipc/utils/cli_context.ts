import fs from "node:fs";
import path from "node:path";
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
 * Extract the user message from a prompt array for CLI providers.
 *
 * IMPORTANT: This strips Dyad's system prompt because CLI providers
 * (Gemini CLI, OpenCode) have their own system prompts and tools.
 * Dyad's system prompt contains instructions about <dyad-write> tags
 * which conflict with the CLI's native tools (write_file, replace, etc.).
 *
 * Instead, the caller should prepend buildCliProjectContext() output
 * to give the model actual project context.
 */
export function extractCliUserMessage(prompt: unknown): string {
  if (typeof prompt === "string") {
    return prompt;
  }

  if (!Array.isArray(prompt)) {
    return String(prompt);
  }

  let userMessage = "";

  // Find the last user message (skip system prompts entirely)
  for (let i = prompt.length - 1; i >= 0; i--) {
    const msg = prompt[i] as Record<string, unknown>;
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        userMessage = msg.content;
        break;
      }
      if (Array.isArray(msg.content)) {
        userMessage = (msg.content as Array<Record<string, unknown>>)
          .filter((part) => part.type === "text")
          .map((part) => part.text as string)
          .join("\n");
        break;
      }
    }
  }

  // Fallback: concatenate non-system messages
  if (!userMessage) {
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

  return userMessage;
}
