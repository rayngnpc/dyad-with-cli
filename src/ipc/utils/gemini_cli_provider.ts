import { spawn } from "node:child_process";
import type { LanguageModelV2 } from "@ai-sdk/provider";
import log from "electron-log";
import { getGeminiCliPath, isGeminiCliAvailable } from "../handlers/local_model_gemini_cli_handler";

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
  error?: string;
}

type GeminiStreamEvent = GeminiStreamInit | GeminiStreamMessage | GeminiStreamResult | GeminiStreamToolUse | GeminiStreamToolResult;

// Module-level state for the current working directory
// This is set before each chat request to point to the app's directory
let currentWorkingDirectory: string | undefined;

// Session management - track if we should continue the session
// Gemini CLI uses --resume to continue the latest session in the current directory
let shouldResumeSession = false;
let currentSessionKey: string | undefined;

// Track which session keys have had at least one message sent
const initializedSessions = new Set<string>();

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
    logger.info(`Gemini CLI session key set to: ${key}, shouldResume: ${shouldResumeSession}`);
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
    logger.info(`Marked Gemini CLI session as initialized: ${currentSessionKey}`);
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
  options?: GeminiCliProviderOptions
): GeminiCliProvider {
  if (!isGeminiCliAvailable()) {
    throw new Error(
      "Gemini CLI is not installed. Install it from: https://github.com/google-gemini/gemini-cli"
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
        
        // Extract the user message from the prompt
        const userMessage = extractUserMessage(prompt);
        
        return new Promise((resolve, reject) => {
          const geminiPath = getGeminiCliPath();
          const args = [
            "--output-format", "json",
            "--yolo",  // Enable tool execution without prompts
          ];

          // Add resume flag if we should continue the session
          if (shouldResumeSession) {
            args.push("--resume", "latest");
            logger.info("Resuming Gemini CLI session");
          }

          args.push("-p", userMessage);

          if (effectiveModel !== "auto") {
            args.push("--model", effectiveModel);
          }

          logger.info(`Gemini CLI doGenerate with model: ${effectiveModel}, cwd: ${currentWorkingDirectory || process.cwd()}`);

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
              const lines = output.split("\n").filter(line => {
                const trimmed = line.trim();
                return trimmed && !trimmed.startsWith("[STARTUP]") && !trimmed.startsWith("Loaded cached");
              });
              
              const jsonLine = lines.find(line => {
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
                    promptTokens: response.stats?.models?.[effectiveModel]?.tokens?.prompt || 0,
                    completionTokens: response.stats?.models?.[effectiveModel]?.tokens?.candidates || 0,
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
        
        // Extract the user message from the prompt
        const userMessage = extractUserMessage(prompt);
        
        const geminiPath = getGeminiCliPath();
        const args = [
          "--output-format", "stream-json",
          "--yolo",  // Enable tool execution without prompts
        ];

        // Add resume flag if we should continue the session
        if (shouldResumeSession) {
          args.push("--resume", "latest");
          logger.info("Resuming Gemini CLI session");
        }

        args.push("-p", userMessage);

        if (effectiveModel !== "auto") {
          args.push("--model", effectiveModel);
        }

        logger.info(`Gemini CLI doStream with model: ${effectiveModel}, cwd: ${currentWorkingDirectory || process.cwd()}`);

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
        let lastContent = "";
        let streamClosed = false;
        let textStartSent = false;
        const textId = generateId();

        // Create a readable stream that yields chunks
        const stream = new ReadableStream({
          start(controller) {
            geminiProcess.stdout.on("data", (data: Buffer) => {
              buffer += data.toString();
              
              const lines = buffer.split("\n");
              buffer = lines.pop() || "";

              for (const line of lines) {
                const trimmedLine = line.trim();
                if (!trimmedLine || trimmedLine.startsWith("[STARTUP]") || trimmedLine.startsWith("Loaded cached")) {
                  continue;
                }

                try {
                  const event = JSON.parse(trimmedLine) as GeminiStreamEvent;
                  
                  // Handle init event - session has started
                  if (event.type === "init") {
                    logger.info(`Gemini CLI session initialized: ${event.session_id}`);
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
                      // Delta mode: content is the full accumulated response
                      // Calculate the actual delta
                      const deltaText = content.slice(lastContent.length);
                      lastContent = content;
                      
                      if (deltaText) {
                        controller.enqueue({
                          type: "text-delta",
                          id: textId,
                          delta: deltaText,
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
                    // Show tool usage as text in the response
                    if (!textStartSent) {
                      controller.enqueue({
                        type: "text-start",
                        id: textId,
                      });
                      textStartSent = true;
                    }
                    const toolMessage = `\n\n---\n**Using tool: ${event.tool_name}**\n`;
                    controller.enqueue({
                      type: "text-delta",
                      id: textId,
                      delta: toolMessage,
                    });
                    logger.info(`Gemini CLI tool_use: ${event.tool_name}`);
                  } else if (event.type === "tool_result") {
                    // Show tool result as text
                    const statusIcon = event.status === "success" ? "completed" : "failed";
                    const resultMessage = `**Tool ${statusIcon}**\n---\n\n`;
                    controller.enqueue({
                      type: "text-delta",
                      id: textId,
                      delta: resultMessage,
                    });
                    logger.info(`Gemini CLI tool_result: ${event.status}`);
                  } else if (event.type === "result") {
                    // Mark session as initialized on successful result
                    if (event.status === "success") {
                      markSessionInitialized();
                    }
                    
                    if (event.status === "error") {
                      controller.error(new Error("Gemini CLI returned an error"));
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
                  logger.debug(`Non-JSON from Gemini CLI: ${trimmedLine.slice(0, 100)}`);
                }
              }
            });

            geminiProcess.stderr.on("data", (data: Buffer) => {
              const text = data.toString();
              if (!text.includes("[STARTUP]") && !text.includes("Loaded cached")) {
                logger.warn(`Gemini CLI stderr: ${text}`);
              }
            });

            geminiProcess.on("error", (error) => {
              if (!streamClosed) {
                streamClosed = true;
                controller.error(error);
              }
            });

            geminiProcess.on("close", (code) => {
              if (code !== 0 && code !== null && !streamClosed) {
                streamClosed = true;
                controller.error(new Error(`Gemini CLI exited with code ${code}`));
                return;
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
                      finishReason: event.status === "success" ? "stop" : "error",
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

/**
 * Extract the user message from a prompt array, including system prompt if present
 */
function extractUserMessage(prompt: any): string {
  let userMessage = "";
  let systemPrompt = "";
  
  if (typeof prompt === "string") {
    return prompt;
  }
  
  if (Array.isArray(prompt)) {
    // First, extract system prompt if present
    for (const msg of prompt) {
      if (msg.role === "system") {
        if (typeof msg.content === "string") {
          systemPrompt = msg.content;
          break;
        }
      }
    }
    
    // Find the last user message
    for (let i = prompt.length - 1; i >= 0; i--) {
      const msg = prompt[i];
      if (msg.role === "user") {
        if (typeof msg.content === "string") {
          userMessage = msg.content;
          break;
        }
        if (Array.isArray(msg.content)) {
          userMessage = msg.content
            .filter((part: any) => part.type === "text")
            .map((part: any) => part.text)
            .join("\n");
          break;
        }
      }
    }
    
    // Fallback: concatenate all messages
    if (!userMessage) {
      userMessage = prompt
        .map((msg: any) => {
          if (typeof msg.content === "string") {
            return `${msg.role}: ${msg.content}`;
          }
          return "";
        })
        .filter(Boolean)
        .join("\n");
    }
  } else {
    return String(prompt);
  }
  
  // Prepend system prompt if found
  if (systemPrompt) {
    return `<system_instructions>\n${systemPrompt}\n</system_instructions>\n\n${userMessage}`;
  }
  
  return userMessage;
}
