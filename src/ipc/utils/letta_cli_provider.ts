import { spawn } from "node:child_process";
import type { LanguageModelV2 } from "@ai-sdk/provider";
import log from "electron-log";
import { getLettaPath, isLettaAvailable } from "../handlers/local_model_letta_handler";

const logger = log.scope("letta_cli_provider");

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
  message_type: "reasoning_message" | "assistant_message" | "tool_call" | "tool_return" | "stop_reason" | "usage_statistics";
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
 * Format tool output for display - truncate if too long
 */
function formatToolOutput(output: string | undefined, maxLength = 500): string {
  if (!output) return "";
  if (output.length <= maxLength) return output;
  return `${output.slice(0, maxLength)}\n... (truncated)`;
}

/**
 * Creates a Letta CLI provider that implements the LanguageModelV2 interface
 */
export function createLettaProvider(
  options?: LettaProviderOptions
): LettaProvider {
  if (!isLettaAvailable()) {
    throw new Error(
      "Letta CLI is not installed. Install it from: https://github.com/letta-ai/letta-code"
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
        
        const userMessage = extractUserMessage(prompt);
        
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
              logger.info(`Continuing Letta session with agent: ${existingAgentId}`);
            }
          }

          logger.info(`Letta CLI doGenerate with model: ${effectiveModel}, cwd: ${currentWorkingDirectory || process.cwd()}`);

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
        
        const userMessage = extractUserMessage(prompt);
        
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
            logger.info(`Continuing Letta session with agent: ${existingAgentId}`);
          }
        }

        logger.info(`Letta CLI doStream with model: ${effectiveModel}, cwd: ${currentWorkingDirectory || process.cwd()}`);

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
        
        // Track active tools for status updates
        const activeTools = new Map<string, string>();

        const stream = new ReadableStream({
          start(controller) {
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
                    logger.info(`Letta agent initialized: ${event.agent_id}, model: ${event.model}`);
                  }
                  
                  // Handle message events
                  if (event.type === "message") {
                    // Assistant message - the actual response text
                    if (event.message_type === "assistant_message" && event.content) {
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
                    
                    // Tool call - show what tool is being used
                    if (event.message_type === "tool_call" && event.tool_call) {
                      const toolName = event.tool_call.name;
                      const callId = event.id || toolName;
                      
                      if (!textStartSent) {
                        controller.enqueue({
                          type: "text-start",
                          id: textId,
                        });
                        textStartSent = true;
                      }
                      
                      if (!activeTools.has(callId)) {
                        activeTools.set(callId, toolName);
                        let toolMessage = `\n\n---\n**Tool: ${toolName}**\n`;
                        
                        // Show arguments if available
                        if (event.tool_call.arguments && Object.keys(event.tool_call.arguments).length > 0) {
                          const argsStr = JSON.stringify(event.tool_call.arguments, null, 2);
                          if (argsStr.length < 500) {
                            toolMessage += `\`\`\`json\n${argsStr}\n\`\`\`\n`;
                          }
                        }
                        
                        controller.enqueue({
                          type: "text-delta",
                          id: textId,
                          delta: toolMessage,
                        });
                      }
                    }
                    
                    // Tool return - show result
                    if (event.message_type === "tool_return" && event.tool_return !== undefined) {
                      if (!textStartSent) {
                        controller.enqueue({
                          type: "text-start",
                          id: textId,
                        });
                        textStartSent = true;
                      }
                      
                      const formattedOutput = formatToolOutput(event.tool_return, 1000);
                      controller.enqueue({
                        type: "text-delta",
                        id: textId,
                        delta: `\`\`\`\n${formattedOutput}\n\`\`\`\n---\n\n`,
                      });
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
                      totalInputTokens = event.usage.prompt_tokens || totalInputTokens;
                      totalOutputTokens = event.usage.completion_tokens || totalOutputTokens;
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
                  logger.debug(`Non-JSON from Letta CLI: ${trimmedLine.slice(0, 100)}`);
                }
              }
            });

            lettaProcess.stderr.on("data", (data: Buffer) => {
              const text = data.toString();
              stderrBuffer += text;
              logger.warn(`Letta CLI stderr: ${text}`);
              
              // Check for authentication errors
              if (text.includes("Missing LETTA_API_KEY") || text.includes("authenticate")) {
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
                  delta: "**Letta CLI Error:** Authentication required.\n\nPlease run `letta` in your terminal to authenticate via Letta Cloud OAuth, or set the `LETTA_API_KEY` environment variable.\n",
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
                    totalInputTokens = event.usage.prompt_tokens || totalInputTokens;
                    totalOutputTokens = event.usage.completion_tokens || totalOutputTokens;
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
