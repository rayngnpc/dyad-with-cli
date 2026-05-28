import { spawn } from "node:child_process";
import path from "node:path";
import type { LanguageModelV2 } from "@ai-sdk/provider";
import log from "electron-log";
import {
  getOpenCodePath,
  isOpenCodeAvailable,
} from "../handlers/local_model_opencode_handler";
import {
  buildCliProjectContext,
  buildConversationHistorySection,
  cleanupCliAttachments,
  extractCliUserMessageWithAttachments,
  forceKillCliProcess,
} from "./cli_context";
import { readSettings } from "../../main/settings";

const logger = log.scope("opencode_cli_provider");

/**
 * Convert absolute paths inside the current working directory to project-relative
 * paths so that <dyad-*> tags display nicely (e.g. `src/foo.ts` not `/abs/.../src/foo.ts`).
 */
function toRelativePath(filePath: string, cwd: string): string {
  if (path.isAbsolute(filePath) && filePath.startsWith(cwd)) {
    const rel = path.relative(cwd, filePath);
    return rel || filePath;
  }
  return filePath;
}

/**
 * Escape characters that would break XML attribute values.
 * Keep in sync with the helper used by gemini_cli_provider.ts.
 */
function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Truncate long tool output so the chat UI does not become unwieldy.
 */
function truncateOutput(output: string, maxLength: number): string {
  if (!output) return "";
  const trimmed = output.trim();
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.substring(0, maxLength)}\n... (truncated)`;
}

/**
 * Compose a short, human-friendly description for a tool invocation, used as
 * the `description` attribute on <dyad-write> / <dyad-search-replace>.
 */
function getOpenCodeToolTitle(
  toolName: string,
  input: Record<string, unknown> | undefined,
  fallbackTitle: string | undefined,
): string {
  const params = input || {};
  switch (toolName) {
    case "write":
      return typeof params.filePath === "string"
        ? `Writing ${params.filePath}`
        : typeof params.path === "string"
          ? `Writing ${params.path}`
          : fallbackTitle || "Writing file";
    case "edit":
      return typeof params.filePath === "string"
        ? `Editing ${params.filePath}`
        : typeof params.path === "string"
          ? `Editing ${params.path}`
          : fallbackTitle || "Editing file";
    case "read":
      return typeof params.filePath === "string"
        ? `Reading ${params.filePath}`
        : typeof params.path === "string"
          ? `Reading ${params.path}`
          : fallbackTitle || "Reading file";
    case "glob":
      return `Glob ${(params.pattern as string) || "*"}`;
    case "grep":
      return `Grep ${(params.pattern as string) || ""}`.trim();
    case "list":
      return typeof params.path === "string"
        ? `Listing ${params.path}`
        : "Listing directory";
    case "bash": {
      const cmd = typeof params.command === "string" ? params.command : "";
      if (cmd.length > 60) return `$ ${cmd.slice(0, 57)}...`;
      return cmd ? `$ ${cmd}` : fallbackTitle || "Running command";
    }
    case "webfetch":
      return typeof params.url === "string"
        ? `Fetching ${params.url}`
        : fallbackTitle || "Fetching URL";
    case "task":
      return typeof params.description === "string"
        ? `Subagent: ${params.description}`
        : fallbackTitle || "Subagent task";
    default:
      return (
        fallbackTitle ||
        toolName.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
      );
  }
}

// Specialized primary agents shipped by OpenCode for narrow internal tasks.
// They're marked `primary` but lack the broad permissions needed for general
// coding work — skip them when auto-picking a fallback agent.
const NARROW_PRIMARY_AGENTS = new Set([
  "compaction",
  "summary",
  "title",
  "general",
]);

// Cached agent name for the session. `undefined` = not resolved yet.
// `null` = resolved to "omit --agent" (stock `build` is primary).
let cachedAgentName: string | null | undefined = undefined;

/**
 * Resolution for `--agent` / `--pure` flags on `opencode run`.
 *
 * The challenge: some OpenCode plugins (e.g. `oh-my-opencode`-style sets)
 * inject "primary" agents like Sisyphus / Hephaestus that show up in
 * `opencode agent list` but whose actual IDs are NOT addressable via
 * `--agent <name>`. They also flip the stock `build` agent to subagent
 * mode, which since OpenCode v1.15.x is rejected as the default.
 *
 * Strategy:
 *   - If user sets `openCodeAgent` in Dyad settings → respect it. The user
 *     opts into plugin-mode and chooses a specific agent they know works.
 *   - Otherwise → run with `--pure`. This disables external plugins,
 *     restores stock OpenCode's agent system (where `build` is primary),
 *     and works identically on stock + plugin-laden installs.
 *
 * Auth is NOT a plugin: credentials in `~/.local/share/opencode/auth.json`
 * are read directly by OpenCode core, so `--pure` does not break any
 * provider that's already logged in (GitHub Copilot, Anthropic, etc.).
 */
interface OpenCodeAgentDecision {
  pure: boolean;
  agent: string | null;
}

function resolveOpenCodeAgent(_opencodePath: string): OpenCodeAgentDecision {
  // Silence "unused" if we ever stop probing. Kept for future strategies.
  void NARROW_PRIMARY_AGENTS;
  void cachedAgentName;

  const override = readSettings().openCodeAgent?.trim();
  if (override) {
    logger.info(
      `OpenCode agent resolution: using user-configured --agent ${override} (plugins enabled)`,
    );
    return { pure: false, agent: override };
  }

  logger.info(
    "OpenCode agent resolution: using --pure mode (stock build agent, plugins bypassed). Set openCodeAgent in Dyad settings to opt into a plugin agent.",
  );
  return { pure: true, agent: null };
}

// Generate unique IDs for stream parts
let idCounter = 0;
function generateId(): string {
  return `opencode-cli-${Date.now()}-${++idCounter}`;
}

/**
 * OpenCode CLI streaming JSON event types
 */
interface OpenCodeStepStart {
  type: "step_start";
  timestamp: number;
  sessionID: string;
  part: {
    id: string;
    sessionID: string;
    messageID: string;
    type: "step-start";
  };
}

interface OpenCodeText {
  type: "text";
  timestamp: number;
  sessionID: string;
  part: {
    id: string;
    sessionID: string;
    messageID: string;
    type: "text";
    text: string;
    time: { start: number; end: number };
  };
}

interface OpenCodeToolUse {
  type: "tool_use";
  timestamp: number;
  sessionID: string;
  part: {
    id: string;
    sessionID: string;
    messageID: string;
    type: "tool";
    callID: string;
    tool: string;
    state: {
      status: "pending" | "running" | "completed" | "error";
      input?: Record<string, unknown>;
      output?: string;
      error?: string;
      title?: string;
      metadata?: Record<string, unknown>;
      time?: { start: number; end: number };
    };
  };
}

interface OpenCodeStepFinish {
  type: "step_finish";
  timestamp: number;
  sessionID: string;
  part: {
    id: string;
    sessionID: string;
    messageID: string;
    type: "step-finish";
    reason: "stop" | "tool-calls" | "error";
    cost: number;
    tokens: {
      input: number;
      output: number;
      reasoning: number;
      cache: { read: number; write: number };
    };
  };
}

interface OpenCodeError {
  type: "error";
  timestamp: number;
  sessionID: string;
  error: {
    name: string;
    data?: {
      providerID?: string;
      message?: string;
    };
  };
}

type OpenCodeStreamEvent =
  | OpenCodeStepStart
  | OpenCodeText
  | OpenCodeToolUse
  | OpenCodeStepFinish
  | OpenCodeError;

// Module-level state for the current working directory
let currentWorkingDirectory: string | undefined;

// Session management - map of appId/chatId to OpenCode session ID
const sessionMap = new Map<string, string>();
let currentSessionKey: string | undefined;

// Cross-app reference context (@app:Name mentions). Set per-turn by
// chat_stream_handlers before spawning; cleared after the turn completes.
let currentReferencedAppsContext: string | undefined;

/**
 * Set the working directory for OpenCode CLI operations
 */
export function setOpenCodeWorkingDirectory(cwd: string | undefined): void {
  currentWorkingDirectory = cwd;
  if (cwd) {
    logger.info(`OpenCode CLI working directory set to: ${cwd}`);
  }
}

/**
 * Set the session key for the current chat (used to persist sessions)
 * The key should be unique per app/chat combination (e.g., "appId-chatId")
 */
export function setOpenCodeSessionKey(key: string | undefined): void {
  currentSessionKey = key;
  if (key) {
    logger.info(`OpenCode session key set to: ${key}`);
  }
}

/**
 * Set the @app:Name cross-app reference context for the next turn.
 * chat_stream_handlers formats the codebases of any apps referenced in
 * the user's message and passes them here so the model has context for
 * those other apps. Pass `undefined` to clear.
 */
export function setOpenCodeReferencedAppsContext(
  text: string | undefined,
): void {
  currentReferencedAppsContext = text;
}

/**
 * Get the stored session ID for a given key
 */
export function getOpenCodeSessionId(key: string): string | undefined {
  return sessionMap.get(key);
}

/**
 * Store a session ID for a given key
 */
function storeSessionId(key: string, sessionId: string): void {
  sessionMap.set(key, sessionId);
  logger.info(`Stored OpenCode session ID: ${sessionId} for key: ${key}`);
}

/**
 * Clear the session for a given key (useful when starting a new chat)
 */
export function clearOpenCodeSession(key: string): void {
  sessionMap.delete(key);
  logger.info(`Cleared OpenCode session for key: ${key}`);
}

/**
 * Parse session ID from OpenCode stream events and store it
 * Only stores the first session ID we see (the parent session)
 * Subagents may create child sessions, but we want to keep the parent session ID
 */
function parseAndStoreSessionId(event: OpenCodeStreamEvent): void {
  if (currentSessionKey && event.sessionID) {
    const existingSessionId = sessionMap.get(currentSessionKey);
    // Only store if we don't have a session ID yet (first message in the conversation)
    if (!existingSessionId) {
      storeSessionId(currentSessionKey, event.sessionID);
    }
  }
}

export interface OpenCodeProviderOptions {
  /**
   * Optional model to use (format: provider/model)
   */
  model?: string;
}

export type OpenCodeProvider = (modelId: string) => LanguageModelV2;

/**
 * Creates an OpenCode CLI provider that implements the LanguageModelV2 interface
 */
export function createOpenCodeProvider(
  options?: OpenCodeProviderOptions,
): OpenCodeProvider {
  if (!isOpenCodeAvailable()) {
    throw new Error(
      "OpenCode CLI is not installed. Install it from: https://opencode.ai",
    );
  }

  return (modelId: string): LanguageModelV2 => {
    const effectiveModel = modelId || options?.model;

    return {
      specificationVersion: "v2",
      provider: "opencode",
      modelId: effectiveModel || "default",
      supportedUrls: {},

      async doGenerate(options): Promise<any> {
        const { prompt, abortSignal } = options;

        // Strip Dyad's system prompt, inject project context.
        // Image attachments are written to temp files and passed via `-f`.
        const cwd = currentWorkingDirectory || process.cwd();
        const projectContext = buildCliProjectContext(cwd);
        const extracted = await extractCliUserMessageWithAttachments(prompt);
        const { text: rawMessage, imagePaths, imageUrls } = extracted;
        if (imageUrls.length > 0) {
          // OpenCode `-f` is a local-file flag; remote URLs aren't supported.
          logger.warn(
            `OpenCode CLI: ${imageUrls.length} remote image URL(s) dropped (OpenCode -f does not support URLs)`,
          );
        }
        // On the FIRST call for this Dyad chat (no OpenCode session yet)
        // include prior conversation. Once we have a session ID, OpenCode
        // carries history forward on its side so we skip this block.
        const hasExistingSession = Boolean(
          currentSessionKey && sessionMap.get(currentSessionKey),
        );
        const historyBlock = hasExistingSession
          ? ""
          : buildConversationHistorySection(prompt);
        const userMessage = [
          projectContext,
          currentReferencedAppsContext,
          historyBlock,
          rawMessage,
        ]
          .filter((s) => s && s.length > 0)
          .join("\n\n");

        return new Promise((resolve, reject) => {
          const opencodePath = getOpenCodePath();
          const args: string[] = ["run", "--format", "json"];

          if (effectiveModel) {
            args.push("-m", effectiveModel);
          }

          const agentDecision = resolveOpenCodeAgent(opencodePath);
          if (agentDecision.pure) {
            args.push("--pure");
          }
          if (agentDecision.agent) {
            args.push("--agent", agentDecision.agent);
          }

          // Add session continuation if we have a stored session for this key
          if (currentSessionKey) {
            const existingSessionId = sessionMap.get(currentSessionKey);
            if (existingSessionId) {
              args.push("-s", existingSessionId);
              logger.info(`Continuing OpenCode session: ${existingSessionId}`);
            }
          }

          // Attach images via `-f <path>` BEFORE the prompt message. See
          // doStream above for why the `--` delimiter is required when
          // attachments are present (OpenCode's `-f` is array-typed and
          // greedily consumes the next positional otherwise).
          if (imagePaths.length > 0) {
            for (const p of imagePaths) {
              args.push("-f", p);
            }
            args.push("--");
          }

          args.push(userMessage);

          logger.info(
            `OpenCode CLI doGenerate with model: ${effectiveModel}, cwd: ${currentWorkingDirectory || process.cwd()}, attachments: ${imagePaths.length}`,
          );

          const opencodeProcess = spawn(opencodePath, args, {
            stdio: ["ignore", "pipe", "pipe"],
            cwd: currentWorkingDirectory || process.cwd(),
          });

          let output = "";
          let totalInputTokens = 0;
          let totalOutputTokens = 0;

          if (abortSignal) {
            abortSignal.addEventListener("abort", () => {
              forceKillCliProcess(opencodeProcess, "OpenCode");
              reject(new Error("Aborted"));
              // NOTE: don't cleanup here — the `close` handler will run.
            });
          }

          opencodeProcess.stdout.on("data", (data: Buffer) => {
            const lines = data.toString().split("\n");
            for (const line of lines) {
              if (!line.trim()) continue;
              try {
                const event = JSON.parse(line) as OpenCodeStreamEvent;
                // Store session ID from any event
                parseAndStoreSessionId(event);

                if (event.type === "text") {
                  output = event.part.text;
                } else if (event.type === "step_finish") {
                  totalInputTokens += event.part.tokens.input;
                  totalOutputTokens += event.part.tokens.output;
                }
              } catch {
                // Not JSON, skip
              }
            }
          });

          opencodeProcess.on("error", (err) => {
            cleanupCliAttachments(imagePaths);
            reject(err);
          });

          opencodeProcess.on("close", (code) => {
            cleanupCliAttachments(imagePaths);
            if (code !== 0) {
              reject(new Error(`OpenCode CLI exited with code ${code}`));
              return;
            }

            resolve({
              text: output,
              finishReason: "stop",
              usage: {
                promptTokens: totalInputTokens,
                completionTokens: totalOutputTokens,
              },
              rawCall: { rawPrompt: userMessage, rawSettings: {} },
              rawResponse: { headers: {} },
            });
          });
        });
      },

      async doStream(options): Promise<any> {
        const { prompt, abortSignal } = options;

        // Strip Dyad's system prompt, inject project context.
        // Image attachments are written to temp files and passed via `-f`.
        const cwd = currentWorkingDirectory || process.cwd();
        const projectContext = buildCliProjectContext(cwd);
        const extracted = await extractCliUserMessageWithAttachments(prompt);
        const { text: rawMessage, imagePaths, imageUrls } = extracted;
        if (imageUrls.length > 0) {
          // OpenCode `-f` is a local-file flag; remote URLs aren't supported.
          logger.warn(
            `OpenCode CLI: ${imageUrls.length} remote image URL(s) dropped (OpenCode -f does not support URLs)`,
          );
        }
        // On the FIRST call for this Dyad chat (no OpenCode session yet)
        // include prior conversation. Once we have a session ID, OpenCode
        // carries history forward on its side so we skip this block.
        const hasExistingSession = Boolean(
          currentSessionKey && sessionMap.get(currentSessionKey),
        );
        const historyBlock = hasExistingSession
          ? ""
          : buildConversationHistorySection(prompt);
        const userMessage = [
          projectContext,
          currentReferencedAppsContext,
          historyBlock,
          rawMessage,
        ]
          .filter((s) => s && s.length > 0)
          .join("\n\n");

        const opencodePath = getOpenCodePath();
        const args = ["run", "--format", "json"];

        if (effectiveModel) {
          args.push("-m", effectiveModel);
        }

        const agentDecision = resolveOpenCodeAgent(opencodePath);
        if (agentDecision.pure) {
          args.push("--pure");
        }
        if (agentDecision.agent) {
          args.push("--agent", agentDecision.agent);
        }

        // Add session continuation if we have a stored session for this key
        if (currentSessionKey) {
          const existingSessionId = sessionMap.get(currentSessionKey);
          if (existingSessionId) {
            args.push("-s", existingSessionId);
            logger.info(`Continuing OpenCode session: ${existingSessionId}`);
          }
        }

        // Attach images via `-f <path>` BEFORE the prompt message. OpenCode
        // declares `-f` as a yargs `array`-type flag, which greedily consumes
        // subsequent positional args as additional file paths until it sees
        // another flag. Without an explicit `--` delimiter, the user message
        // gets swallowed as the next "file" — yielding "File not found: <user
        // message>" errors when attachments are present.
        if (imagePaths.length > 0) {
          for (const p of imagePaths) {
            args.push("-f", p);
          }
          args.push("--");
        }

        args.push(userMessage);

        logger.info(
          `OpenCode CLI doStream with model: ${effectiveModel}, cwd: ${currentWorkingDirectory || process.cwd()}, attachments: ${imagePaths.length}`,
        );

        const opencodeProcess = spawn(opencodePath, args, {
          stdio: ["ignore", "pipe", "pipe"],
          cwd: currentWorkingDirectory || process.cwd(),
        });

        if (abortSignal) {
          abortSignal.addEventListener("abort", () => {
            forceKillCliProcess(opencodeProcess, "OpenCode");
          });
        }

        let buffer = "";
        let streamClosed = false;
        let textStartSent = false;
        const textId = generateId();
        let totalInputTokens = 0;
        let totalOutputTokens = 0;
        let lastTextContent = "";

        // Track tools that have been opened (i.e. we've already emitted the
        // opening tag/markdown header for them). Maps callID -> tool name so
        // we can pick the right closing tag when the tool completes.
        const openedTools = new Map<string, string>();
        // CallIDs that opened a native <dyad-*> tag (versus a markdown
        // fallback). Mirrors Gemini's `pendingFileToolIds`.
        const nativeToolIds = new Set<string>();

        const stream = new ReadableStream({
          start(controller) {
            opencodeProcess.stdout.on("data", (data: Buffer) => {
              buffer += data.toString();

              const lines = buffer.split("\n");
              buffer = lines.pop() || "";

              for (const line of lines) {
                const trimmedLine = line.trim();
                if (!trimmedLine) continue;

                try {
                  const event = JSON.parse(trimmedLine) as OpenCodeStreamEvent;

                  // Store session ID from any event
                  parseAndStoreSessionId(event);

                  if (event.type === "error") {
                    const errorMsg =
                      event.error.data?.message || event.error.name;
                    controller.error(new Error(errorMsg));
                    streamClosed = true;
                    return;
                  }

                  if (event.type === "step_start") {
                    if (!textStartSent) {
                      controller.enqueue({
                        type: "text-start",
                        id: textId,
                      });
                      textStartSent = true;
                    }
                    controller.enqueue({
                      type: "text-delta",
                      id: textId,
                      delta: "\n*Thinking...*\n\n",
                    });
                    logger.debug(
                      `OpenCode step started: ${event.part.messageID}`,
                    );
                  }

                  if (event.type === "text") {
                    const content = event.part.text;

                    if (!textStartSent) {
                      controller.enqueue({
                        type: "text-start",
                        id: textId,
                      });
                      textStartSent = true;
                    }

                    // OpenCode sends full text, not deltas - calculate delta
                    if (content !== lastTextContent) {
                      const delta = content.startsWith(lastTextContent)
                        ? content.slice(lastTextContent.length)
                        : content;
                      lastTextContent = content;

                      if (delta) {
                        controller.enqueue({
                          type: "text-delta",
                          id: textId,
                          delta: delta,
                        });
                      }
                    }
                  }

                  if (event.type === "tool_use") {
                    const tool = event.part;
                    const toolName = tool.tool;
                    const status = tool.state.status;
                    const callID = tool.callID;
                    const input = tool.state.input || {};
                    const cwd = currentWorkingDirectory || process.cwd();

                    if (!textStartSent) {
                      controller.enqueue({
                        type: "text-start",
                        id: textId,
                      });
                      textStartSent = true;
                    }

                    const emit = (delta: string) => {
                      controller.enqueue({
                        type: "text-delta",
                        id: textId,
                        delta,
                      });
                    };

                    // ---- Open the tag/header on first observation -----------
                    // Most OpenCode tools fire `pending` -> `running` -> `completed`,
                    // but we should also handle "completed" being the first thing
                    // we see (some adapters skip pending/running). The `openedTools`
                    // map guards against double-opens.
                    const isFirstSight = !openedTools.has(callID);
                    if (isFirstSight && status !== "error") {
                      openedTools.set(callID, toolName);

                      if (
                        toolName === "write" &&
                        typeof input.filePath === "string" &&
                        typeof input.content === "string"
                      ) {
                        const relativePath = toRelativePath(
                          input.filePath,
                          cwd,
                        );
                        const description = getOpenCodeToolTitle(
                          toolName,
                          input,
                          tool.state.title,
                        );
                        // <dyad-write> carries the full content in the input,
                        // so we can emit both open + content + close right now.
                        emit(
                          `\n<dyad-write path="${escapeXmlAttr(relativePath)}" description="${escapeXmlAttr(description)}">\n${input.content}\n</dyad-write>\n`,
                        );
                        nativeToolIds.add(callID);
                      } else if (
                        toolName === "edit" &&
                        typeof input.filePath === "string" &&
                        typeof input.oldString === "string" &&
                        typeof input.newString === "string"
                      ) {
                        const relativePath = toRelativePath(
                          input.filePath,
                          cwd,
                        );
                        const description = getOpenCodeToolTitle(
                          toolName,
                          input,
                          tool.state.title,
                        );
                        const srBlock = `<<<<<<< SEARCH\n${input.oldString}\n=======\n${input.newString}\n>>>>>>> REPLACE`;
                        emit(
                          `\n<dyad-search-replace path="${escapeXmlAttr(relativePath)}" description="${escapeXmlAttr(description)}">\n${srBlock}\n</dyad-search-replace>\n`,
                        );
                        nativeToolIds.add(callID);
                      } else if (
                        toolName === "read" &&
                        (typeof input.filePath === "string" ||
                          typeof input.path === "string")
                      ) {
                        const raw =
                          (input.filePath as string) ||
                          (input.path as string) ||
                          "";
                        const relativePath = toRelativePath(raw, cwd);
                        emit(
                          `\n<dyad-read path="${escapeXmlAttr(relativePath)}">\n`,
                        );
                        nativeToolIds.add(callID);
                      } else if (toolName === "glob" || toolName === "list") {
                        const rawDir =
                          (input.path as string) ||
                          (input.pattern as string) ||
                          ".";
                        const directory = toRelativePath(rawDir, cwd);
                        emit(
                          `\n<dyad-list-files directory="${escapeXmlAttr(directory)}">\n`,
                        );
                        nativeToolIds.add(callID);
                      } else if (toolName === "grep") {
                        const pattern =
                          typeof input.pattern === "string"
                            ? input.pattern
                            : "";
                        const include =
                          typeof input.include === "string"
                            ? input.include
                            : "";
                        emit(
                          `\n<dyad-output type="info" message="${escapeXmlAttr(
                            `grep ${pattern}${include ? ` (include: ${include})` : ""}`.trim(),
                          )}">\n`,
                        );
                        nativeToolIds.add(callID);
                      } else if (toolName === "bash") {
                        const command =
                          typeof input.command === "string"
                            ? input.command
                            : "";
                        // Recognize npm/pnpm/yarn install commands and label
                        // them more clearly so the UI conveys "installing
                        // packages" rather than just a shell prompt.
                        const installMatch = command.match(
                          /^(?:npm|pnpm|yarn)\s+(?:install|add|i)\s+(.+?)(?:\s+--[a-z-]+.*)?$/,
                        );
                        let cmdTitle: string;
                        if (installMatch) {
                          const pkgs = installMatch[1]
                            .split(/\s+/)
                            .filter((p) => !p.startsWith("-"))
                            .join(" ");
                          cmdTitle = `📦 Installing: ${pkgs}`;
                        } else if (command.length > 60) {
                          cmdTitle = `$ ${command.slice(0, 57)}...`;
                        } else if (command) {
                          cmdTitle = `$ ${command}`;
                        } else {
                          cmdTitle = "Running command";
                        }
                        emit(
                          `\n<dyad-output type="info" message="${escapeXmlAttr(cmdTitle)}">\n`,
                        );
                        nativeToolIds.add(callID);
                      } else if (toolName === "webfetch") {
                        const url =
                          typeof input.url === "string" ? input.url : "";
                        // Dyad has no <dyad-web-fetch> with a url attr;
                        // <dyad-web-search> renders cleanly and matches the
                        // visual intent (info card + content).
                        emit(
                          `\n<dyad-web-search>\n${escapeXmlAttr(url || "")}\n`,
                        );
                        nativeToolIds.add(callID);
                      } else if (toolName === "task") {
                        const description =
                          typeof input.description === "string"
                            ? input.description
                            : tool.state.title || "Subagent task";
                        emit(
                          `\n<dyad-output type="info" message="${escapeXmlAttr(`Subagent: ${description}`)}">\n`,
                        );
                        nativeToolIds.add(callID);
                      } else if (
                        toolName === "todowrite" ||
                        toolName === "todo" ||
                        toolName === "todoread"
                      ) {
                        const todos = Array.isArray(input.todos)
                          ? (input.todos as Array<Record<string, unknown>>)
                          : [];
                        const total = todos.length;
                        const done = todos.filter(
                          (t) => t.status === "completed",
                        ).length;
                        const inProgress = todos.filter(
                          (t) => t.status === "in_progress",
                        ).length;
                        const statusIcon = (s: unknown): string =>
                          s === "completed"
                            ? "[x]"
                            : s === "in_progress"
                              ? "[~]"
                              : "[ ]";
                        const lines = todos
                          .map(
                            (t) =>
                              `${statusIcon(t.status)} ${t.content as string}${
                                t.priority ? ` _(${t.priority})_` : ""
                              }`,
                          )
                          .join("\n");
                        const summary = `Todos: ${done}/${total} done${
                          inProgress > 0 ? `, ${inProgress} in progress` : ""
                        }`;
                        emit(
                          `\n<dyad-output type="info" message="${escapeXmlAttr(summary)}">\n${lines}\n</dyad-output>\n`,
                        );
                        // Self-closing: mark as native-handled so the
                        // completion/error branches below skip the markdown
                        // fallback (which would dump the raw JSON).
                        nativeToolIds.add(callID);
                      } else {
                        // Fallback for unknown tools: keep the old markdown
                        // header so behavior degrades gracefully.
                        const title = tool.state.title || toolName;
                        let toolMessage = `\n\n---\n**Tool: ${title}**\n`;
                        if (Object.keys(input).length > 0) {
                          const inputStr = JSON.stringify(input, null, 2);
                          if (inputStr.length < 200) {
                            toolMessage += `\`\`\`json\n${inputStr}\n\`\`\`\n`;
                          }
                        }
                        emit(toolMessage);
                      }
                      logger.info(
                        `OpenCode tool_use opened: ${toolName} (native=${nativeToolIds.has(callID)})`,
                      );
                    }

                    // ---- Close the tag on completion -----------------------
                    if (status === "completed") {
                      if (nativeToolIds.has(callID)) {
                        nativeToolIds.delete(callID);
                        openedTools.delete(callID);
                        const output = tool.state.output || "";

                        if (
                          toolName === "write" ||
                          toolName === "edit" ||
                          toolName === "todowrite" ||
                          toolName === "todo" ||
                          toolName === "todoread"
                        ) {
                          // Already closed inline above; nothing more to emit.
                        } else if (toolName === "read") {
                          emit(
                            `${truncateOutput(output, 2000)}\n</dyad-read>\n`,
                          );
                        } else if (toolName === "glob" || toolName === "list") {
                          emit(
                            `${truncateOutput(output, 1000)}\n</dyad-list-files>\n`,
                          );
                        } else if (
                          toolName === "grep" ||
                          toolName === "bash" ||
                          toolName === "task"
                        ) {
                          emit(
                            `${truncateOutput(output, 1500)}\n</dyad-output>\n`,
                          );
                        } else if (toolName === "webfetch") {
                          emit(
                            `${truncateOutput(output, 1500)}\n</dyad-web-search>\n`,
                          );
                        }
                        logger.info(
                          `OpenCode tool completed (native): ${toolName}`,
                        );
                      } else {
                        // Markdown fallback path: close the visual block.
                        openedTools.delete(callID);
                        const title = tool.state.title || toolName;
                        let resultMessage = `**${title}** completed\n`;
                        if (tool.state.output) {
                          const formattedOutput = truncateOutput(
                            tool.state.output,
                            1000,
                          );
                          resultMessage += `\`\`\`\n${formattedOutput}\n\`\`\`\n---\n\n`;
                        } else {
                          resultMessage += "---\n\n";
                        }
                        emit(resultMessage);
                        logger.info(
                          `OpenCode tool completed (fallback): ${toolName}`,
                        );
                      }
                    } else if (status === "error") {
                      const errorMsg = tool.state.error || "Unknown error";
                      // Combine stdout (state.output) with the error message
                      // so the user sees what actually failed — `npm run lint`
                      // exiting 1 still has useful lint output in state.output.
                      const stdout = tool.state.output
                        ? truncateOutput(tool.state.output, 2000)
                        : "";
                      const errorBody = stdout
                        ? `${stdout}\n\n${errorMsg}`
                        : errorMsg;

                      if (nativeToolIds.has(callID)) {
                        // We opened a native tag — close it cleanly and then
                        // surface the error in its own <dyad-output type="error">.
                        nativeToolIds.delete(callID);
                        openedTools.delete(callID);
                        if (toolName === "read") {
                          emit(`\n</dyad-read>\n`);
                        } else if (toolName === "glob" || toolName === "list") {
                          emit(`\n</dyad-list-files>\n`);
                        } else if (
                          toolName === "grep" ||
                          toolName === "bash" ||
                          toolName === "task"
                        ) {
                          emit(`\n</dyad-output>\n`);
                        } else if (toolName === "webfetch") {
                          emit(`\n</dyad-web-search>\n`);
                        }
                        // write/edit are self-closing; nothing extra to emit.
                        emit(
                          `\n<dyad-output type="error" message="${escapeXmlAttr(`${toolName} failed`)}">\n${errorBody}\n</dyad-output>\n`,
                        );
                      } else {
                        openedTools.delete(callID);
                        emit(
                          `\n<dyad-output type="error" message="${escapeXmlAttr(`${toolName} failed`)}">\n${errorBody}\n</dyad-output>\n`,
                        );
                      }
                      logger.warn(
                        `OpenCode tool error: ${toolName} - ${errorMsg}`,
                      );
                    }
                  }

                  if (event.type === "step_finish") {
                    totalInputTokens += event.part.tokens.input;
                    totalOutputTokens += event.part.tokens.output;

                    // Only close stream if reason is "stop" (not "tool-calls")
                    if (event.part.reason === "stop") {
                      if (textStartSent) {
                        controller.enqueue({
                          type: "text-end",
                          id: textId,
                        });
                      }
                      controller.enqueue({
                        type: "finish",
                        finishReason: "stop",
                        usage: {
                          inputTokens: totalInputTokens,
                          outputTokens: totalOutputTokens,
                        },
                      });
                      if (!streamClosed) {
                        streamClosed = true;
                        controller.close();
                      }
                    }
                  }
                } catch {
                  logger.debug(
                    `Non-JSON from OpenCode CLI: ${trimmedLine.slice(0, 100)}`,
                  );
                }
              }
            });

            opencodeProcess.stderr.on("data", (data: Buffer) => {
              const text = data.toString();
              logger.warn(`OpenCode CLI stderr: ${text}`);
            });

            opencodeProcess.on("error", (error) => {
              cleanupCliAttachments(imagePaths);
              if (!streamClosed) {
                streamClosed = true;
                controller.error(error);
              }
            });

            opencodeProcess.on("close", (code) => {
              cleanupCliAttachments(imagePaths);
              // Process remaining buffer
              if (buffer.trim() && !streamClosed) {
                try {
                  const event = JSON.parse(
                    buffer.trim(),
                  ) as OpenCodeStreamEvent;
                  parseAndStoreSessionId(event);
                  if (event.type === "step_finish") {
                    totalInputTokens += event.part.tokens.input;
                    totalOutputTokens += event.part.tokens.output;
                  }
                } catch {
                  // Ignore
                }
              }

              if (!streamClosed) {
                if (textStartSent) {
                  controller.enqueue({
                    type: "text-end",
                    id: textId,
                  });
                }
                controller.enqueue({
                  type: "finish",
                  finishReason: code === 0 ? "stop" : "error",
                  usage: {
                    inputTokens: totalInputTokens,
                    outputTokens: totalOutputTokens,
                  },
                });
                streamClosed = true;
                controller.close();
              }
            });
          },
        });

        return {
          stream,
          rawCall: { rawPrompt: userMessage, rawSettings: {} },
          rawResponse: { headers: {} },
        };
      },
    };
  };
}

// extractUserMessage removed — using shared extractCliUserMessage from cli_context.ts
// which strips Dyad's system prompt (conflicting <dyad-write> tag instructions)
// and lets the CLI use its own system prompt and tools.
