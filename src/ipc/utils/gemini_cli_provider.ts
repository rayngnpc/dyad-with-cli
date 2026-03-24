import { spawn } from "node:child_process";
import path from "node:path";
import type { LanguageModelV2 } from "@ai-sdk/provider";
import log from "electron-log";
import {
  getGeminiCliPath,
  isGeminiCliAvailable,
} from "../handlers/local_model_gemini_cli_handler";
import {
  buildCliProjectContext,
  extractCliUserMessage,
} from "./cli_context";

const logger = log.scope("gemini_cli_provider");

// Generate unique IDs for stream parts
let idCounter = 0;
function generateId(): string {
  return `gemini-cli-${Date.now()}-${++idCounter}`;
}

/**
 * Gemini CLI streaming JSON event types
 */
interface GeminiStreamInit {
  type: "init";
  timestamp: string;
  session_id: string;
  model: string;
}

interface GeminiStreamMessage {
  type: "message";
  timestamp: string;
  role: "user" | "assistant";
  content: string;
  delta?: boolean;
}

interface GeminiStreamResult {
  type: "result";
  timestamp: string;
  status: "success" | "error";
  stats: {
    total_tokens: number;
    input_tokens: number;
    output_tokens: number;
    duration_ms: number;
    tool_calls: number;
  };
}

interface GeminiStreamToolUse {
  type: "tool_use";
  timestamp: string;
  tool_name: string;
  tool_id: string;
  parameters: Record<string, unknown>;
}

interface GeminiStreamToolResult {
  type: "tool_result";
  timestamp: string;
  tool_id: string;
  status: "success" | "error";
  output?: string;
  error?: string | { type: string; message: string };
}

type GeminiStreamEvent =
  | GeminiStreamInit
  | GeminiStreamMessage
  | GeminiStreamResult
  | GeminiStreamToolUse
  | GeminiStreamToolResult;

// Module-level state for the current working directory
// This is set before each chat request to point to the app's directory
let currentWorkingDirectory: string | undefined;

// Session management - track if we should continue the session
// Gemini CLI uses --resume to continue the latest session in the current directory
let shouldResumeSession = false;
let currentSessionKey: string | undefined;

const initializedSessions = new Set<string>();

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

function formatToolOutput(output: string, maxLength: number): string {
  if (!output) return "";
  const trimmed = output.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return `${trimmed.substring(0, maxLength)}\n... (truncated)`;
}

/**
 * Extract a human-readable error message from tool_result events.
 * Gemini CLI v0.34.0+ sends error as { type, message } object, not a string.
 */
function extractToolError(error: unknown): string {
  if (!error) return "";
  if (typeof error === "string") return error;
  if (typeof error === "object" && error !== null) {
    const obj = error as Record<string, unknown>;
    if (typeof obj.message === "string") return obj.message;
    return JSON.stringify(error);
  }
  return String(error);
}

/**
 * Get the display content for a tool_result event.
 * Handles: success with output, success without output, and error cases.
 */
function getToolResultContent(
  event: GeminiStreamToolResult,
  maxLength: number,
  fallbackError: string,
): string {
  if (event.status === "success") {
    if (event.output) {
      return formatToolOutput(event.output, maxLength);
    }
    // Success but no output (e.g., read_file where resultDisplay is not a string)
    return "";
  }
  return extractToolError(event.error) || fallbackError;
}

/**
 * Strip Gemini CLI's bash wrapper from shell commands.
 * Gemini CLI wraps commands like:
 *   shopt -u promptvars nullglob extglob nocaseglob dotglob; { ACTUAL_COMMAND; }; __code=$?; ...
 * We extract just the ACTUAL_COMMAND part.
 */
function stripShellWrapper(rawCommand: string): string {
  // Match the pattern: ...{ ACTUAL_COMMAND; }; __code=...
  const braceMatch = rawCommand.match(/\{\s*(.+?)\s*;\s*\}\s*;\s*__code=/s);
  if (braceMatch) {
    return braceMatch[1].trim();
  }
  // Fallback: if it starts with shopt, take everything after the first semicolon-space
  if (rawCommand.startsWith("shopt ")) {
    const idx = rawCommand.indexOf("; ");
    if (idx !== -1) {
      return rawCommand.slice(idx + 2).trim();
    }
  }
  return rawCommand;
}

function getToolTitle(
  toolName: string,
  params: Record<string, unknown>,
): string {
  switch (toolName) {
    case "read_file":
      return `Reading ${params.file_path || "file"}`;
    case "write_file":
      return `Writing ${params.file_path || "file"}`;
    case "replace":
      return `Editing ${params.file_path || "file"}`;
    case "shell":
    case "run_shell_command": {
      const cmd =
        typeof params.command === "string"
          ? stripShellWrapper(params.command)
          : "";
      // Show first 60 chars of the actual command
      if (cmd.length > 60) {
        return `Running: ${cmd.slice(0, 57)}...`;
      }
      return cmd ? `Running: ${cmd}` : "Running command";
    }
    case "glob":
      return `Searching files: ${params.pattern || "..."}`;
    case "grep_search":
      return `Searching code: ${params.pattern || "..."}`;
    case "list_dir":
    case "list_directory":
      return `Listing directory: ${params.dir_path || params.path || "."}`;
    case "web_search":
    case "google_web_search":
      return `Searching web: ${params.query || "..."}`;
    case "web_fetch":
      return `Fetching ${params.url || "page"}`;
    case "read_many_files":
      return "Reading multiple files";
    case "edit_file":
      return `Editing ${params.file_path || "file"}`;
    default:
      return toolName
        .replace(/_/g, " ")
        .replace(/\b\w/g, (c) => c.toUpperCase());
  }
}

/**
 * Set the working directory for Gemini CLI operations
 * This should be called before making a chat request
 */
export function setGeminiCliWorkingDirectory(cwd: string | undefined): void {
  currentWorkingDirectory = cwd;
  if (cwd) {
    logger.info(`Gemini CLI working directory set to: ${cwd}`);
  }
}

/**
 * Set the session key for the current chat (used to persist sessions)
 * The key should be unique per app/chat combination (e.g., "appId-chatId")
 */
export function setGeminiCliSessionKey(key: string | undefined): void {
  currentSessionKey = key;
  if (key) {
    // Check if this session has been initialized (has at least one message)
    shouldResumeSession = initializedSessions.has(key);
    logger.info(
      `Gemini CLI session key set to: ${key}, shouldResume: ${shouldResumeSession}`,
    );
  } else {
    shouldResumeSession = false;
  }
}

/**
 * Mark the current session as initialized (first message has been sent)
 */
function markSessionInitialized(): void {
  if (currentSessionKey) {
    initializedSessions.add(currentSessionKey);
    logger.info(
      `Marked Gemini CLI session as initialized: ${currentSessionKey}`,
    );
  }
}

/**
 * Clear the session for a given key (useful when starting a new chat)
 */
export function clearGeminiCliSession(key: string): void {
  initializedSessions.delete(key);
  logger.info(`Cleared Gemini CLI session for key: ${key}`);
}

export interface GeminiCliProviderOptions {
  /**
   * Optional model to use (default: "auto")
   */
  model?: string;
}

export type GeminiCliProvider = (modelId: string) => LanguageModelV2;

/**
 * Creates a Gemini CLI provider that implements the LanguageModelV2 interface
 * This allows Gemini CLI to be used with the Vercel AI SDK streaming API
 */
export function createGeminiCliProvider(
  options?: GeminiCliProviderOptions,
): GeminiCliProvider {
  if (!isGeminiCliAvailable()) {
    throw new Error(
      "Gemini CLI is not installed. Install it from: https://github.com/google-gemini/gemini-cli",
    );
  }

  return (modelId: string): LanguageModelV2 => {
    const effectiveModel = modelId || options?.model || "auto";

    return {
      specificationVersion: "v2",
      provider: "gemini-cli",
      modelId: effectiveModel,
      supportedUrls: {},

      async doGenerate(options): Promise<any> {
        const { prompt, abortSignal } = options;

        // Extract the user message, stripping Dyad's system prompt
        // (which contains conflicting <dyad-write> tag instructions)
        const cwd = currentWorkingDirectory || process.cwd();
        const projectContext = buildCliProjectContext(cwd);
        const rawMessage = extractCliUserMessage(prompt);
        const userMessage = projectContext
          ? `${projectContext}\n\n${rawMessage}`
          : rawMessage;

        return new Promise((resolve, reject) => {
          const geminiPath = getGeminiCliPath();
          const args = [
            "--output-format",
            "json",
            "--yolo", // Enable tool execution without prompts
          ];

          // Add resume flag if we should continue the session
          if (shouldResumeSession) {
            args.push("--resume", "latest");
            logger.info("Resuming Gemini CLI session");
          }

          args.push("-p", userMessage);

          if (
            effectiveModel !== "auto" &&
            effectiveModel !== "manual" &&
            effectiveModel !== "auto-2.5"
          ) {
            args.push("--model", effectiveModel);
          }

          logger.info(
            `Gemini CLI doGenerate with model: ${effectiveModel}, cwd: ${currentWorkingDirectory || process.cwd()}`,
          );

          const geminiProcess = spawn(geminiPath, args, {
            stdio: ["ignore", "pipe", "pipe"],
            cwd: currentWorkingDirectory || process.cwd(),
          });

          let output = "";

          if (abortSignal) {
            abortSignal.addEventListener("abort", () => {
              geminiProcess.kill("SIGTERM");
              reject(new Error("Aborted"));
            });
          }

          geminiProcess.stdout.on("data", (data: Buffer) => {
            output += data.toString();
          });

          geminiProcess.on("error", reject);

          geminiProcess.on("close", (code) => {
            if (code !== 0) {
              reject(new Error(`Gemini CLI exited with code ${code}`));
              return;
            }

            // Mark session as initialized after successful completion
            markSessionInitialized();

            try {
              // Parse the JSON response
              const lines = output.split("\n").filter((line) => {
                const trimmed = line.trim();
                return (
                  trimmed &&
                  !trimmed.startsWith("[STARTUP]") &&
                  !trimmed.startsWith("Loaded cached")
                );
              });

              const jsonLine = lines.find((line) => {
                try {
                  JSON.parse(line);
                  return true;
                } catch {
                  return false;
                }
              });

              if (jsonLine) {
                const response = JSON.parse(jsonLine);
                resolve({
                  text: response.response || "",
                  finishReason: "stop",
                  usage: {
                    promptTokens:
                      response.stats?.models?.[effectiveModel]?.tokens
                        ?.prompt || 0,
                    completionTokens:
                      response.stats?.models?.[effectiveModel]?.tokens
                        ?.candidates || 0,
                  },
                  rawCall: { rawPrompt: userMessage, rawSettings: {} },
                  rawResponse: { headers: {} },
                });
              } else {
                reject(new Error("No valid JSON response from Gemini CLI"));
              }
            } catch (e) {
              reject(e);
            }
          });
        });
      },

      async doStream(options): Promise<any> {
        const { prompt, abortSignal } = options;

        // Extract the user message, stripping Dyad's system prompt
        const cwd = currentWorkingDirectory || process.cwd();
        const projectContext = buildCliProjectContext(cwd);
        const rawMessage = extractCliUserMessage(prompt);
        const userMessage = projectContext
          ? `${projectContext}\n\n${rawMessage}`
          : rawMessage;

        const geminiPath = getGeminiCliPath();
        const args = [
          "--output-format",
          "stream-json",
          "--yolo", // Enable tool execution without prompts
        ];

        // Add resume flag if we should continue the session
        if (shouldResumeSession) {
          args.push("--resume", "latest");
          logger.info("Resuming Gemini CLI session");
        }

        args.push("-p", userMessage);

        if (
          effectiveModel !== "auto" &&
          effectiveModel !== "manual" &&
          effectiveModel !== "auto-2.5"
        ) {
          args.push("--model", effectiveModel);
        }

        logger.info(
          `Gemini CLI doStream with model: ${effectiveModel}, cwd: ${currentWorkingDirectory || process.cwd()}`,
        );

        const geminiProcess = spawn(geminiPath, args, {
          stdio: ["ignore", "pipe", "pipe"],
          cwd: currentWorkingDirectory || process.cwd(),
        });

        if (abortSignal) {
          abortSignal.addEventListener("abort", () => {
            geminiProcess.kill("SIGTERM");
          });
        }

        let buffer = "";
        let streamClosed = false;
        let textStartSent = false;
        const textId = generateId();
        const pendingFileToolIds = new Set<string>();
        const activeTools = new Map<string, { name: string; title: string }>();

        // Create a readable stream that yields chunks
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

            geminiProcess.stdout.on("data", (data: Buffer) => {
              buffer += data.toString();

              const lines = buffer.split("\n");
              buffer = lines.pop() || "";

              for (const line of lines) {
                const trimmedLine = line.trim();
                if (
                  !trimmedLine ||
                  trimmedLine.startsWith("[STARTUP]") ||
                  trimmedLine.startsWith("Loaded cached")
                ) {
                  continue;
                }

                try {
                  const event = JSON.parse(trimmedLine) as GeminiStreamEvent;

                  // Handle init event - session has started
                  if (event.type === "init") {
                    logger.info(
                      `Gemini CLI session initialized: ${event.session_id}`,
                    );
                  }

                  if (event.type === "message" && event.role === "assistant") {
                    const content = event.content;

                    // Send text-start on first text
                    if (!textStartSent) {
                      controller.enqueue({
                        type: "text-start",
                        id: textId,
                      });
                      textStartSent = true;
                    }

                    if (event.delta) {
                      // Delta mode: content is the actual new chunk of text
                      // (Gemini CLI stream-json emits each delta as a separate chunk,
                      // NOT accumulated content)
                      if (content) {
                        controller.enqueue({
                          type: "text-delta",
                          id: textId,
                          delta: content,
                        });
                      }
                    } else {
                      // Non-delta mode: content is the new text
                      controller.enqueue({
                        type: "text-delta",
                        id: textId,
                        delta: content,
                      });
                    }
                  } else if (event.type === "tool_use") {
                    if (!textStartSent) {
                      controller.enqueue({
                        type: "text-start",
                        id: textId,
                      });
                      textStartSent = true;
                    }

                    const cwd = currentWorkingDirectory || process.cwd();
                    const toolName = event.tool_name;
                    const params = event.parameters;
                    const toolTitle = getToolTitle(toolName, params);

                    activeTools.set(event.tool_id, {
                      name: toolName,
                      title: toolTitle,
                    });

                    if (
                      toolName === "write_file" &&
                      typeof params.file_path === "string" &&
                      typeof params.content === "string"
                    ) {
                      const relativePath = toRelativePath(
                        params.file_path,
                        cwd,
                      );
                      const description =
                        typeof params.description === "string"
                          ? params.description
                          : `Writing ${relativePath}`;
                      const tag = `\n<dyad-write path="${escapeXmlAttr(relativePath)}" description="${escapeXmlAttr(description)}">\n${params.content}\n</dyad-write>\n`;
                      controller.enqueue({
                        type: "text-delta",
                        id: textId,
                        delta: tag,
                      });
                      pendingFileToolIds.add(event.tool_id);
                    } else if (
                      toolName === "replace" &&
                      typeof params.file_path === "string" &&
                      typeof params.old_string === "string" &&
                      typeof params.new_string === "string"
                    ) {
                      const relativePath = toRelativePath(
                        params.file_path,
                        cwd,
                      );
                      const description =
                        typeof params.instruction === "string"
                          ? params.instruction
                          : `Editing ${relativePath}`;
                      const srContent = `<<<<<<< SEARCH\n${params.old_string}\n=======\n${params.new_string}\n>>>>>>> REPLACE`;
                      const tag = `\n<dyad-search-replace path="${escapeXmlAttr(relativePath)}" description="${escapeXmlAttr(description)}">\n${srContent}\n</dyad-search-replace>\n`;
                      controller.enqueue({
                        type: "text-delta",
                        id: textId,
                        delta: tag,
                      });
                      pendingFileToolIds.add(event.tool_id);
                    } else if (
                      toolName === "read_file" &&
                      typeof params.file_path === "string"
                    ) {
                      const relativePath = toRelativePath(
                        params.file_path,
                        cwd,
                      );
                      const tag = `\n<dyad-read path="${escapeXmlAttr(relativePath)}">\n`;
                      controller.enqueue({
                        type: "text-delta",
                        id: textId,
                        delta: tag,
                      });
                      pendingFileToolIds.add(event.tool_id);
                    } else if (
                      (toolName === "glob" ||
                        toolName === "list_dir" ||
                        toolName === "list_directory") &&
                      (typeof params.pattern === "string" ||
                        typeof params.path === "string" ||
                        typeof params.dir_path === "string")
                    ) {
                      const directory =
                        typeof params.dir_path === "string"
                          ? toRelativePath(params.dir_path, cwd)
                          : typeof params.path === "string"
                            ? toRelativePath(params.path, cwd)
                            : typeof params.pattern === "string"
                              ? params.pattern
                              : ".";
                      const tag = `\n<dyad-list-files directory="${escapeXmlAttr(directory)}">\n`;
                      controller.enqueue({
                        type: "text-delta",
                        id: textId,
                        delta: tag,
                      });
                      pendingFileToolIds.add(event.tool_id);
                    } else if (
                      (toolName === "web_search" ||
                        toolName === "google_web_search") &&
                      typeof params.query === "string"
                    ) {
                      const tag = `\n<dyad-web-search>\n${escapeXmlAttr(params.query)}\n`;
                      controller.enqueue({
                        type: "text-delta",
                        id: textId,
                        delta: tag,
                      });
                      pendingFileToolIds.add(event.tool_id);
                    } else if (
                      toolName === "shell" ||
                      toolName === "run_shell_command"
                    ) {
                      const rawCommand =
                        typeof params.command === "string"
                          ? params.command
                          : JSON.stringify(params);
                      const command = stripShellWrapper(rawCommand);
                      // Use the actual command (truncated) as the title
                      const cmdTitle =
                        command.length > 60
                          ? `$ ${command.slice(0, 57)}...`
                          : `$ ${command}`;
                      const tag = `\n<dyad-output type="info" message="${escapeXmlAttr(cmdTitle)}">\n`;
                      controller.enqueue({
                        type: "text-delta",
                        id: textId,
                        delta: tag,
                      });
                      pendingFileToolIds.add(event.tool_id);
                    } else {
                      let toolMessage = `\n\n---\n**${toolTitle}**\n`;
                      const inputStr = JSON.stringify(params, null, 2);
                      if (inputStr.length < 300 && inputStr !== "{}") {
                        toolMessage += `\`\`\`json\n${inputStr}\n\`\`\`\n`;
                      }
                      controller.enqueue({
                        type: "text-delta",
                        id: textId,
                        delta: toolMessage,
                      });
                    }
                    logger.info(
                      `Gemini CLI tool_use: ${toolName} (native=${pendingFileToolIds.has(event.tool_id)})`,
                    );
                  } else if (event.type === "tool_result") {
                    const toolInfo = activeTools.get(event.tool_id);
                    activeTools.delete(event.tool_id);

                    if (pendingFileToolIds.has(event.tool_id)) {
                      pendingFileToolIds.delete(event.tool_id);
                      const toolName = toolInfo?.name || "tool";

                      if (toolName === "read_file") {
                        const content = getToolResultContent(
                          event,
                          2000,
                          "Error reading file",
                        );
                        controller.enqueue({
                          type: "text-delta",
                          id: textId,
                          delta: `${content}\n</dyad-read>\n`,
                        });
                      } else if (
                        toolName === "glob" ||
                        toolName === "list_dir" ||
                        toolName === "list_directory"
                      ) {
                        const content = getToolResultContent(
                          event,
                          1000,
                          "Error listing files",
                        );
                        controller.enqueue({
                          type: "text-delta",
                          id: textId,
                          delta: `${content}\n</dyad-list-files>\n`,
                        });
                      } else if (
                        toolName === "web_search" ||
                        toolName === "google_web_search"
                      ) {
                        const content = getToolResultContent(
                          event,
                          1500,
                          "Search failed",
                        );
                        controller.enqueue({
                          type: "text-delta",
                          id: textId,
                          delta: `${content}\n</dyad-web-search>\n`,
                        });
                      } else if (
                        toolName === "shell" ||
                        toolName === "run_shell_command"
                      ) {
                        const content = getToolResultContent(
                          event,
                          1500,
                          "Command completed",
                        );
                        controller.enqueue({
                          type: "text-delta",
                          id: textId,
                          delta: `${content}\n</dyad-output>\n`,
                        });
                      }

                      logger.info(
                        `Gemini CLI tool_result: ${event.status} (native: ${toolName})`,
                      );
                    } else {
                      const title = toolInfo?.title || "Tool";
                      const statusText =
                        event.status === "success" ? "completed" : "failed";
                      let resultMessage = `**${title}** ${statusText}\n`;

                      if (event.status === "success" && event.output) {
                        const formattedOutput = formatToolOutput(
                          event.output,
                          800,
                        );
                        resultMessage += `\`\`\`\n${formattedOutput}\n\`\`\`\n`;
                      } else if (event.status === "error" && event.error) {
                        const errorMsg = extractToolError(event.error);
                        resultMessage += `\`\`\`\n${errorMsg}\n\`\`\`\n`;
                      }
                      resultMessage += "---\n\n";

                      controller.enqueue({
                        type: "text-delta",
                        id: textId,
                        delta: resultMessage,
                      });
                      logger.info(`Gemini CLI tool_result: ${event.status}`);
                    }
                  } else if (event.type === "result") {
                    // Mark session as initialized on successful result
                    if (event.status === "success") {
                      markSessionInitialized();
                    }

                    if (event.status === "error") {
                      controller.error(
                        new Error("Gemini CLI returned an error"),
                      );
                      streamClosed = true;
                    } else {
                      // Send text-end if we sent text-start
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
                          inputTokens: event.stats.input_tokens,
                          outputTokens: event.stats.output_tokens,
                        },
                      });
                      if (!streamClosed) {
                        streamClosed = true;
                        controller.close();
                      }
                    }
                  }
                } catch {
                  // Not valid JSON, skip
                  logger.debug(
                    `Non-JSON from Gemini CLI: ${trimmedLine.slice(0, 100)}`,
                  );
                }
              }
            });

            geminiProcess.stderr.on("data", (data: Buffer) => {
              const text = data.toString();
              if (
                !text.includes("[STARTUP]") &&
                !text.includes("Loaded cached")
              ) {
                logger.warn(`Gemini CLI stderr: ${text}`);
              }
              logger.debug(`Gemini CLI stderr (all): ${text.slice(0, 500)}`);
            });

            geminiProcess.on("error", (error) => {
              if (!streamClosed) {
                streamClosed = true;
                controller.error(error);
              }
            });

            geminiProcess.on("close", (code, signal) => {
              logger.info(
                `Gemini CLI process closed - code: ${code}, signal: ${signal}, streamClosed: ${streamClosed}, bufferLength: ${buffer.length}`,
              );

              if (code !== 0 && code !== null && !streamClosed) {
                logger.error(
                  `Gemini CLI exited with non-zero code: ${code}, signal: ${signal}`,
                );
                streamClosed = true;
                controller.error(
                  new Error(
                    `Gemini CLI exited with code ${code}${signal ? `, signal: ${signal}` : ""}`,
                  ),
                );
                return;
              }

              // Log if closing without receiving result event
              if (!streamClosed) {
                logger.warn(
                  `Gemini CLI closed without sending 'result' event - code: ${code}, remaining buffer: ${buffer.slice(0, 200)}`,
                );
              }

              // Process remaining buffer
              if (buffer.trim() && !streamClosed) {
                try {
                  const event = JSON.parse(buffer.trim()) as GeminiStreamEvent;
                  if (event.type === "result") {
                    // Mark session as initialized on successful result
                    if (event.status === "success") {
                      markSessionInitialized();
                    }
                    // Send text-end if we sent text-start
                    if (textStartSent) {
                      controller.enqueue({
                        type: "text-end",
                        id: textId,
                      });
                    }
                    controller.enqueue({
                      type: "finish",
                      finishReason:
                        event.status === "success" ? "stop" : "error",
                      usage: {
                        inputTokens: event.stats?.input_tokens || 0,
                        outputTokens: event.stats?.output_tokens || 0,
                      },
                    });
                  }
                } catch {
                  // Ignore
                }
              }
              if (!streamClosed) {
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
