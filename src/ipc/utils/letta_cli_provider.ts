import { spawn } from "node:child_process";
import path from "node:path";
import type { LanguageModelV2 } from "@ai-sdk/provider";
import log from "electron-log";
import {
  getLettaPath,
  isLettaAvailable,
} from "../handlers/local_model_letta_handler";
import {
  buildCliProjectContext,
  buildConversationHistorySection,
  cleanupCliAttachments,
  extractCliUserMessageWithAttachments,
} from "./cli_context";

/*
 * NOTE on Letta image attachments:
 *
 * As of letta-code v0.x there is no headless flag for attaching binary
 * images to a `-p` prompt (checked via `letta --help`). When the caller
 * provides image parts we extract the text, log a warning, and drop the
 * images (cleaning up any temp files we materialised so they don't
 * leak). If Letta later gains an attachment flag, wire it up the same
 * way OpenCode does with `-f`.
 */

const logger = log.scope("letta_cli_provider");

function toRelativePath(filePath: string, cwd: string): string {
  if (path.isAbsolute(filePath) && filePath.startsWith(cwd)) {
    const rel = path.relative(cwd, filePath);
    return rel || filePath;
  }
  return filePath;
}

function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function truncateOutput(output: string, maxLength: number): string {
  if (!output) return "";
  const trimmed = output.trim();
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.substring(0, maxLength)}\n... (truncated)`;
}

/** Pull a string field from arguments, preferring `primary` then `fallback`. */
function strArg(
  args: Record<string, unknown>,
  primary: string,
  fallback?: string,
): string | undefined {
  if (typeof args[primary] === "string") return args[primary] as string;
  if (fallback && typeof args[fallback] === "string")
    return args[fallback] as string;
  return undefined;
}

// Generate unique IDs for stream parts
let idCounter = 0;
function generateId(): string {
  return `letta-cli-${Date.now()}-${++idCounter}`;
}

/**
 * Letta CLI streaming JSON event types
 * Based on the actual --output-format stream-json output
 */
interface LettaInitEvent {
  type: "init";
  agent_id: string;
  model: string;
  tools: string[];
}

interface LettaMessageEvent {
  type: "message";
  id?: string;
  message_type:
    | "reasoning_message"
    | "assistant_message"
    | "tool_call"
    | "tool_return"
    | "stop_reason"
    | "usage_statistics";
  content?: string;
  reasoning?: string;
  stop_reason?: string;
  tool_call?: {
    name: string;
    arguments: Record<string, unknown>;
  };
  tool_return?: string;
  completion_tokens?: number;
  prompt_tokens?: number;
  total_tokens?: number;
}

interface LettaResultEvent {
  type: "result";
  subtype: "success" | "error";
  is_error: boolean;
  result: string;
  agent_id: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

type LettaStreamEvent = LettaInitEvent | LettaMessageEvent | LettaResultEvent;

// Module-level state for the current working directory
let currentWorkingDirectory: string | undefined;

// Session management - map of appId/chatId to Letta agent ID
const sessionMap = new Map<string, string>();
let currentSessionKey: string | undefined;

/**
 * Set the working directory for Letta CLI operations
 */
export function setLettaWorkingDirectory(cwd: string | undefined): void {
  currentWorkingDirectory = cwd;
  if (cwd) {
    logger.info(`Letta CLI working directory set to: ${cwd}`);
  }
}

/**
 * Set the session key for the current chat (used to persist sessions)
 * The key should be unique per app/chat combination (e.g., "appId-chatId")
 */
export function setLettaSessionKey(key: string | undefined): void {
  currentSessionKey = key;
  if (key) {
    logger.info(`Letta session key set to: ${key}`);
  }
}

/**
 * Get the stored agent ID for a given key
 */
export function getLettaSessionId(key: string): string | undefined {
  return sessionMap.get(key);
}

/**
 * Store an agent ID for a given key
 */
function storeSessionId(key: string, agentId: string): void {
  sessionMap.set(key, agentId);
  logger.info(`Stored Letta agent ID: ${agentId} for key: ${key}`);
}

/**
 * Clear the session for a given key (useful when starting a new chat)
 */
export function clearLettaSession(key: string): void {
  sessionMap.delete(key);
  logger.info(`Cleared Letta session for key: ${key}`);
}

export interface LettaProviderOptions {
  /**
   * Optional model to use (e.g., "opus", "sonnet-4.5")
   */
  model?: string;
}

export type LettaProvider = (modelId: string) => LanguageModelV2;

/**
 * Creates a Letta CLI provider that implements the LanguageModelV2 interface
 */
export function createLettaProvider(
  options?: LettaProviderOptions,
): LettaProvider {
  if (!isLettaAvailable()) {
    throw new Error(
      "Letta CLI is not installed. Install it from: https://github.com/letta-ai/letta-code",
    );
  }

  return (modelId: string): LanguageModelV2 => {
    const effectiveModel = modelId || options?.model;

    return {
      specificationVersion: "v2",
      provider: "letta",
      modelId: effectiveModel || "auto",
      supportedUrls: {},

      async doGenerate(options): Promise<any> {
        const { prompt, abortSignal } = options;

        // Strip Dyad's system prompt, inject project context.
        // Letta CLI doesn't support image attachments in headless mode;
        // we still extract them (which materialises them to disk) so we
        // can warn AND cleanup, instead of leaving stale temp files.
        const cwd = currentWorkingDirectory || process.cwd();
        const projectContext = buildCliProjectContext(cwd);
        const extracted = extractCliUserMessageWithAttachments(prompt);
        const { text: rawMessage, imagePaths, imageUrls } = extracted;
        if (imagePaths.length > 0 || imageUrls.length > 0) {
          logger.warn(
            `Letta CLI: dropping ${imagePaths.length} image file(s) and ${imageUrls.length} image URL(s) — Letta headless mode does not support attachments`,
          );
          cleanupCliAttachments(imagePaths);
        }
        // On the FIRST call for this Dyad chat (no Letta agent assigned
        // yet) include prior conversation. Once an agent is in sessionMap,
        // Letta carries history forward in the agent's memory.
        const hasExistingSession = Boolean(
          currentSessionKey && sessionMap.get(currentSessionKey),
        );
        const historyBlock = hasExistingSession
          ? ""
          : buildConversationHistorySection(prompt);
        const userMessage = [projectContext, historyBlock, rawMessage]
          .filter((s) => s && s.length > 0)
          .join("\n\n");

        return new Promise((resolve, reject) => {
          const lettaPath = getLettaPath();
          const args: string[] = ["-p", userMessage, "--output-format", "json"];

          if (effectiveModel && effectiveModel !== "auto") {
            args.push("-m", effectiveModel);
          }

          // Add agent continuation if we have a stored session for this key
          if (currentSessionKey) {
            const existingAgentId = sessionMap.get(currentSessionKey);
            if (existingAgentId) {
              args.push("-a", existingAgentId);
              logger.info(
                `Continuing Letta session with agent: ${existingAgentId}`,
              );
            }
          }

          logger.info(
            `Letta CLI doGenerate with model: ${effectiveModel}, cwd: ${currentWorkingDirectory || process.cwd()}`,
          );

          const lettaProcess = spawn(lettaPath, args, {
            stdio: ["ignore", "pipe", "pipe"],
            cwd: currentWorkingDirectory || process.cwd(),
          });

          let output = "";
          let totalInputTokens = 0;
          let totalOutputTokens = 0;

          if (abortSignal) {
            abortSignal.addEventListener("abort", () => {
              lettaProcess.kill("SIGTERM");
              reject(new Error("Aborted"));
            });
          }

          lettaProcess.stdout.on("data", (data: Buffer) => {
            const text = data.toString();
            try {
              const response = JSON.parse(text);
              if (response.text) {
                output = response.text;
              }
              if (response.agentId && currentSessionKey) {
                storeSessionId(currentSessionKey, response.agentId);
              }
              if (response.usage) {
                totalInputTokens = response.usage.input_tokens || 0;
                totalOutputTokens = response.usage.output_tokens || 0;
              }
            } catch {
              // Not JSON, accumulate as raw text
              output += text;
            }
          });

          lettaProcess.on("error", reject);

          lettaProcess.on("close", (code) => {
            if (code !== 0) {
              reject(new Error(`Letta CLI exited with code ${code}`));
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
        // Letta CLI doesn't support image attachments in headless mode;
        // we still extract them (which materialises them to disk) so we
        // can warn AND cleanup, instead of leaving stale temp files.
        const cwd = currentWorkingDirectory || process.cwd();
        const projectContext = buildCliProjectContext(cwd);
        const extracted = extractCliUserMessageWithAttachments(prompt);
        const { text: rawMessage, imagePaths, imageUrls } = extracted;
        if (imagePaths.length > 0 || imageUrls.length > 0) {
          logger.warn(
            `Letta CLI: dropping ${imagePaths.length} image file(s) and ${imageUrls.length} image URL(s) — Letta headless mode does not support attachments`,
          );
          cleanupCliAttachments(imagePaths);
        }
        // On the FIRST call for this Dyad chat (no Letta agent assigned
        // yet) include prior conversation. Once an agent is in sessionMap,
        // Letta carries history forward in the agent's memory.
        const hasExistingSession = Boolean(
          currentSessionKey && sessionMap.get(currentSessionKey),
        );
        const historyBlock = hasExistingSession
          ? ""
          : buildConversationHistorySection(prompt);
        const userMessage = [projectContext, historyBlock, rawMessage]
          .filter((s) => s && s.length > 0)
          .join("\n\n");

        const lettaPath = getLettaPath();
        const args = ["-p", userMessage, "--output-format", "stream-json"];

        if (effectiveModel && effectiveModel !== "auto") {
          args.push("-m", effectiveModel);
        }

        // Add agent continuation if we have a stored session for this key
        if (currentSessionKey) {
          const existingAgentId = sessionMap.get(currentSessionKey);
          if (existingAgentId) {
            args.push("-a", existingAgentId);
            logger.info(
              `Continuing Letta session with agent: ${existingAgentId}`,
            );
          }
        }

        logger.info(
          `Letta CLI doStream with model: ${effectiveModel}, cwd: ${currentWorkingDirectory || process.cwd()}`,
        );

        const lettaProcess = spawn(lettaPath, args, {
          stdio: ["ignore", "pipe", "pipe"],
          cwd: currentWorkingDirectory || process.cwd(),
        });

        if (abortSignal) {
          abortSignal.addEventListener("abort", () => {
            lettaProcess.kill("SIGTERM");
          });
        }

        let buffer = "";
        let streamClosed = false;
        let textStartSent = false;
        const textId = generateId();
        let totalInputTokens = 0;
        let totalOutputTokens = 0;
        let stderrBuffer = "";

        // Track tools that have been opened via a tool_call event so that
        // the matching tool_return event can close them with the correct tag.
        // Maps callId -> { name, native }. `native = true` means we emitted a
        // <dyad-*> opening tag and need to emit the matching closer.
        const activeTools = new Map<
          string,
          { name: string; native: boolean }
        >();

        const stream = new ReadableStream({
          start(controller) {
            // Send "Thinking..." indicator immediately so user sees activity
            controller.enqueue({
              type: "text-start",
              id: textId,
            });
            textStartSent = true;
            controller.enqueue({
              type: "text-delta",
              id: textId,
              delta: "*Thinking...*\n\n",
            });

            lettaProcess.stdout.on("data", (data: Buffer) => {
              buffer += data.toString();

              const lines = buffer.split("\n");
              buffer = lines.pop() || "";

              for (const line of lines) {
                const trimmedLine = line.trim();
                if (!trimmedLine) continue;

                try {
                  const event = JSON.parse(trimmedLine) as LettaStreamEvent;

                  // Handle init event - store agent ID
                  if (event.type === "init") {
                    if (currentSessionKey && event.agent_id) {
                      const existingAgentId = sessionMap.get(currentSessionKey);
                      if (!existingAgentId) {
                        storeSessionId(currentSessionKey, event.agent_id);
                      }
                    }
                    logger.info(
                      `Letta agent initialized: ${event.agent_id}, model: ${event.model}`,
                    );
                  }

                  // Handle message events
                  if (event.type === "message") {
                    // Assistant message - the actual response text
                    if (
                      event.message_type === "assistant_message" &&
                      event.content
                    ) {
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
                        delta: event.content,
                      });
                    }

                    // Tool call - show what tool is being used (emit native
                    // <dyad-*> tags when we recognise the tool name; fall back
                    // to a markdown header for Letta-only tools like memory
                    // ops where Dyad has no rendering counterpart).
                    if (event.message_type === "tool_call" && event.tool_call) {
                      const toolName = event.tool_call.name;
                      const callId = event.id || toolName;
                      const args = event.tool_call.arguments || {};
                      const cwd = currentWorkingDirectory || process.cwd();

                      if (!textStartSent) {
                        controller.enqueue({
                          type: "text-start",
                          id: textId,
                        });
                        textStartSent = true;
                      }

                      if (!activeTools.has(callId)) {
                        const emit = (delta: string) =>
                          controller.enqueue({
                            type: "text-delta",
                            id: textId,
                            delta,
                          });

                        let native = false;
                        const filePath = strArg(args, "file_path", "path");
                        const command = strArg(args, "command");
                        const query = strArg(args, "query");
                        const url = strArg(args, "url");
                        const content = strArg(args, "content", "file_text");
                        const oldStr = strArg(args, "old_string", "old_str");
                        const newStr = strArg(args, "new_string", "new_str");

                        if (
                          (toolName === "write_file" ||
                            toolName === "create_file") &&
                          filePath &&
                          content !== undefined
                        ) {
                          const rel = toRelativePath(filePath, cwd);
                          emit(
                            `\n<dyad-write path="${escapeXmlAttr(rel)}" description="${escapeXmlAttr(`Writing ${rel}`)}">\n${content}\n</dyad-write>\n`,
                          );
                          native = true; // self-closing — no return-event work
                        } else if (
                          (toolName === "str_replace" ||
                            toolName === "str_replace_editor" ||
                            toolName === "replace") &&
                          filePath &&
                          oldStr !== undefined &&
                          newStr !== undefined
                        ) {
                          const rel = toRelativePath(filePath, cwd);
                          const srBlock = `<<<<<<< SEARCH\n${oldStr}\n=======\n${newStr}\n>>>>>>> REPLACE`;
                          emit(
                            `\n<dyad-search-replace path="${escapeXmlAttr(rel)}" description="${escapeXmlAttr(`Editing ${rel}`)}">\n${srBlock}\n</dyad-search-replace>\n`,
                          );
                          native = true; // self-closing
                        } else if (
                          (toolName === "read_file" || toolName === "view") &&
                          filePath
                        ) {
                          const rel = toRelativePath(filePath, cwd);
                          emit(`\n<dyad-read path="${escapeXmlAttr(rel)}">\n`);
                          native = true;
                        } else if (
                          toolName === "list_files" ||
                          toolName === "list_directory" ||
                          toolName === "glob"
                        ) {
                          const dir =
                            strArg(args, "path", "directory") ||
                            strArg(args, "pattern") ||
                            ".";
                          emit(
                            `\n<dyad-list-files directory="${escapeXmlAttr(toRelativePath(dir, cwd))}">\n`,
                          );
                          native = true;
                        } else if (
                          (toolName === "bash" ||
                            toolName === "run_command" ||
                            toolName === "shell") &&
                          command !== undefined
                        ) {
                          const cmdTitle =
                            command.length > 60
                              ? `$ ${command.slice(0, 57)}...`
                              : command
                                ? `$ ${command}`
                                : "Running command";
                          emit(
                            `\n<dyad-output type="info" message="${escapeXmlAttr(cmdTitle)}">\n`,
                          );
                          native = true;
                        } else if (
                          (toolName === "web_search" ||
                            toolName === "google_web_search") &&
                          query !== undefined
                        ) {
                          emit(
                            `\n<dyad-web-search>\n${escapeXmlAttr(query)}\n`,
                          );
                          native = true;
                        } else if (toolName === "web_fetch" && url) {
                          emit(`\n<dyad-web-search>\n${escapeXmlAttr(url)}\n`);
                          native = true;
                        } else {
                          // Memory tools (core_memory_append, etc.) and any
                          // other unrecognised tool — fall back to a small
                          // markdown header rather than spamming JSON.
                          let toolMessage = `\n\n---\n**Tool: ${toolName}**\n`;
                          if (Object.keys(args).length > 0) {
                            const argsStr = JSON.stringify(args, null, 2);
                            if (argsStr.length < 500) {
                              toolMessage += `\`\`\`json\n${argsStr}\n\`\`\`\n`;
                            }
                          }
                          emit(toolMessage);
                        }

                        activeTools.set(callId, { name: toolName, native });
                      }
                    }

                    // Tool return - close the matching opened tag (or print
                    // a markdown result block for the fallback path).
                    if (
                      event.message_type === "tool_return" &&
                      event.tool_return !== undefined
                    ) {
                      if (!textStartSent) {
                        controller.enqueue({
                          type: "text-start",
                          id: textId,
                        });
                        textStartSent = true;
                      }

                      // Letta does not provide a per-event tool ID on returns,
                      // so we just match the most recent open entry. Iterate
                      // and grab the last (insertion-ordered) callId.
                      let matchedCallId: string | undefined;
                      let matchedInfo:
                        | { name: string; native: boolean }
                        | undefined;
                      for (const [k, v] of activeTools) {
                        matchedCallId = k;
                        matchedInfo = v;
                      }

                      const emit = (delta: string) =>
                        controller.enqueue({
                          type: "text-delta",
                          id: textId,
                          delta,
                        });

                      const output = truncateOutput(event.tool_return, 1500);

                      if (matchedInfo?.native) {
                        const toolName = matchedInfo.name;
                        if (
                          toolName === "write_file" ||
                          toolName === "create_file" ||
                          toolName === "str_replace" ||
                          toolName === "str_replace_editor" ||
                          toolName === "replace"
                        ) {
                          // Self-closing — nothing to emit.
                        } else if (
                          toolName === "read_file" ||
                          toolName === "view"
                        ) {
                          emit(`${output}\n</dyad-read>\n`);
                        } else if (
                          toolName === "list_files" ||
                          toolName === "list_directory" ||
                          toolName === "glob"
                        ) {
                          emit(`${output}\n</dyad-list-files>\n`);
                        } else if (
                          toolName === "bash" ||
                          toolName === "run_command" ||
                          toolName === "shell"
                        ) {
                          emit(`${output}\n</dyad-output>\n`);
                        } else if (
                          toolName === "web_search" ||
                          toolName === "google_web_search" ||
                          toolName === "web_fetch"
                        ) {
                          emit(`${output}\n</dyad-web-search>\n`);
                        }
                      } else {
                        emit(`\`\`\`\n${output}\n\`\`\`\n---\n\n`);
                      }

                      if (matchedCallId) {
                        activeTools.delete(matchedCallId);
                      }
                    }

                    // Usage statistics
                    if (event.message_type === "usage_statistics") {
                      totalInputTokens = event.prompt_tokens || 0;
                      totalOutputTokens = event.completion_tokens || 0;
                    }
                  }

                  // Handle result event - final response
                  if (event.type === "result") {
                    // Store agent ID from result
                    if (currentSessionKey && event.agent_id) {
                      const existingAgentId = sessionMap.get(currentSessionKey);
                      if (!existingAgentId) {
                        storeSessionId(currentSessionKey, event.agent_id);
                      }
                    }

                    // Update usage from result if available
                    if (event.usage) {
                      totalInputTokens =
                        event.usage.prompt_tokens || totalInputTokens;
                      totalOutputTokens =
                        event.usage.completion_tokens || totalOutputTokens;
                    }

                    // Send the final result if we haven't streamed content yet
                    if (!textStartSent && event.result) {
                      controller.enqueue({
                        type: "text-start",
                        id: textId,
                      });
                      textStartSent = true;
                      controller.enqueue({
                        type: "text-delta",
                        id: textId,
                        delta: event.result,
                      });
                    }

                    // Close the stream
                    if (textStartSent) {
                      controller.enqueue({
                        type: "text-end",
                        id: textId,
                      });
                    }
                    controller.enqueue({
                      type: "finish",
                      finishReason: event.is_error ? "error" : "stop",
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
                } catch {
                  logger.debug(
                    `Non-JSON from Letta CLI: ${trimmedLine.slice(0, 100)}`,
                  );
                }
              }
            });

            lettaProcess.stderr.on("data", (data: Buffer) => {
              const text = data.toString();
              stderrBuffer += text;
              logger.warn(`Letta CLI stderr: ${text}`);

              // Check for authentication errors
              if (
                text.includes("Missing LETTA_API_KEY") ||
                text.includes("authenticate")
              ) {
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
                  delta:
                    "**Letta CLI Error:** Authentication required.\n\nPlease run `letta` in your terminal to authenticate via Letta Cloud OAuth, or set the `LETTA_API_KEY` environment variable.\n",
                });
              }
            });

            lettaProcess.on("error", (error) => {
              if (!streamClosed) {
                streamClosed = true;
                controller.error(error);
              }
            });

            lettaProcess.on("close", (code) => {
              // Process remaining buffer
              if (buffer.trim() && !streamClosed) {
                try {
                  const event = JSON.parse(buffer.trim()) as LettaStreamEvent;
                  if (event.type === "result" && event.usage) {
                    totalInputTokens =
                      event.usage.prompt_tokens || totalInputTokens;
                    totalOutputTokens =
                      event.usage.completion_tokens || totalOutputTokens;
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
