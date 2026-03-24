import { spawn } from "node:child_process";
import type { LanguageModelV2 } from "@ai-sdk/provider";
import log from "electron-log";
import {
  getOpenCodePath,
  isOpenCodeAvailable,
} from "../handlers/local_model_opencode_handler";
import {
  buildCliProjectContext,
  extractCliUserMessage,
} from "./cli_context";

const logger = log.scope("opencode_cli_provider");

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
 * Format tool output for display - truncate if too long
 */
function formatToolOutput(output: string | undefined, maxLength = 500): string {
  if (!output) return "";
  if (output.length <= maxLength) return output;
  return `${output.slice(0, maxLength)}\n... (truncated)`;
}

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

        // Strip Dyad's system prompt, inject project context
        const cwd = currentWorkingDirectory || process.cwd();
        const projectContext = buildCliProjectContext(cwd);
        const rawMessage = extractCliUserMessage(prompt);
        const userMessage = projectContext
          ? `${projectContext}\n\n${rawMessage}`
          : rawMessage;

        return new Promise((resolve, reject) => {
          const opencodePath = getOpenCodePath();
          const args: string[] = ["run", "--format", "json"];

          if (effectiveModel) {
            args.push("-m", effectiveModel);
          }

          // Add session continuation if we have a stored session for this key
          if (currentSessionKey) {
            const existingSessionId = sessionMap.get(currentSessionKey);
            if (existingSessionId) {
              args.push("-s", existingSessionId);
              logger.info(`Continuing OpenCode session: ${existingSessionId}`);
            }
          }

          args.push(userMessage);

          logger.info(
            `OpenCode CLI doGenerate with model: ${effectiveModel}, cwd: ${currentWorkingDirectory || process.cwd()}`,
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
              opencodeProcess.kill("SIGTERM");
              reject(new Error("Aborted"));
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

          opencodeProcess.on("error", reject);

          opencodeProcess.on("close", (code) => {
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

        // Strip Dyad's system prompt, inject project context
        const cwd = currentWorkingDirectory || process.cwd();
        const projectContext = buildCliProjectContext(cwd);
        const rawMessage = extractCliUserMessage(prompt);
        const userMessage = projectContext
          ? `${projectContext}\n\n${rawMessage}`
          : rawMessage;

        const opencodePath = getOpenCodePath();
        const args = ["run", "--format", "json"];

        if (effectiveModel) {
          args.push("-m", effectiveModel);
        }

        // Add session continuation if we have a stored session for this key
        if (currentSessionKey) {
          const existingSessionId = sessionMap.get(currentSessionKey);
          if (existingSessionId) {
            args.push("-s", existingSessionId);
            logger.info(`Continuing OpenCode session: ${existingSessionId}`);
          }
        }

        args.push(userMessage);

        logger.info(
          `OpenCode CLI doStream with model: ${effectiveModel}, cwd: ${currentWorkingDirectory || process.cwd()}`,
        );

        const opencodeProcess = spawn(opencodePath, args, {
          stdio: ["ignore", "pipe", "pipe"],
          cwd: currentWorkingDirectory || process.cwd(),
        });

        if (abortSignal) {
          abortSignal.addEventListener("abort", () => {
            opencodeProcess.kill("SIGTERM");
          });
        }

        let buffer = "";
        let streamClosed = false;
        let textStartSent = false;
        const textId = generateId();
        let totalInputTokens = 0;
        let totalOutputTokens = 0;
        let lastTextContent = "";

        // Track active tools for status updates
        const activeTools = new Map<string, string>();

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

                    if (!textStartSent) {
                      controller.enqueue({
                        type: "text-start",
                        id: textId,
                      });
                      textStartSent = true;
                    }

                    // Show tool activity with full details
                    if (status === "pending" || status === "running") {
                      if (!activeTools.has(callID)) {
                        activeTools.set(callID, toolName);
                        const title = tool.state.title || toolName;
                        let toolMessage = `\n\n---\n**Tool: ${title}**\n`;

                        // Show input if available
                        if (
                          tool.state.input &&
                          Object.keys(tool.state.input).length > 0
                        ) {
                          const inputStr = JSON.stringify(
                            tool.state.input,
                            null,
                            2,
                          );
                          if (inputStr.length < 200) {
                            toolMessage += `\`\`\`json\n${inputStr}\n\`\`\`\n`;
                          }
                        }

                        controller.enqueue({
                          type: "text-delta",
                          id: textId,
                          delta: toolMessage,
                        });
                      }
                    } else if (status === "completed") {
                      activeTools.delete(callID);
                      const title = tool.state.title || toolName;
                      let resultMessage = `**${title}** completed\n`;

                      // Show output if available (truncated)
                      if (tool.state.output) {
                        const formattedOutput = formatToolOutput(
                          tool.state.output,
                          1000,
                        );
                        resultMessage += `\`\`\`\n${formattedOutput}\n\`\`\`\n---\n\n`;
                      } else {
                        resultMessage += "---\n\n";
                      }

                      controller.enqueue({
                        type: "text-delta",
                        id: textId,
                        delta: resultMessage,
                      });
                      logger.info(`OpenCode tool completed: ${toolName}`);
                    } else if (status === "error") {
                      activeTools.delete(callID);
                      const errorMsg = tool.state.error || "Unknown error";
                      controller.enqueue({
                        type: "text-delta",
                        id: textId,
                        delta: `**${toolName}** failed: ${errorMsg}\n---\n\n`,
                      });
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
              if (!streamClosed) {
                streamClosed = true;
                controller.error(error);
              }
            });

            opencodeProcess.on("close", (code) => {
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
