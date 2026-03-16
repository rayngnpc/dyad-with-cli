import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { LanguageModelV2 } from "@ai-sdk/provider";
import log from "electron-log";
import { getOpenCodePath, isOpenCodeAvailable } from "../handlers/local_model_opencode_handler";
import { getUserDataPath } from "../../paths/paths";

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

type OpenCodeStreamEvent = OpenCodeStepStart | OpenCodeText | OpenCodeToolUse | OpenCodeStepFinish | OpenCodeError;

// Module-level state for the current working directory
let currentWorkingDirectory: string | undefined;

// Session management - persisted to disk so sessions survive Dyad restarts
const sessionMap = new Map<string, string>();
let currentSessionKey: string | undefined;
let sessionMapLoaded = false;

function getSessionMapPath(): string {
  return path.join(getUserDataPath(), "opencode-sessions.json");
}

function loadSessionMap(): void {
  if (sessionMapLoaded) return;
  sessionMapLoaded = true;

  try {
    const filePath = getSessionMapPath();
    if (fs.existsSync(filePath)) {
      const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      if (data && typeof data === "object") {
        for (const [key, value] of Object.entries(data)) {
          if (typeof value === "string") {
            sessionMap.set(key, value);
          }
        }
        logger.info(`Loaded ${sessionMap.size} OpenCode sessions from disk`);
      }
    }
  } catch (err) {
    logger.warn(`Failed to load OpenCode session map from disk: ${err}`);
  }
}

function saveSessionMap(): void {
  try {
    const filePath = getSessionMapPath();
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const data: Record<string, string> = {};
    for (const [key, value] of sessionMap.entries()) {
      data[key] = value;
    }
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
    logger.debug(`Saved ${sessionMap.size} OpenCode sessions to disk`);
  } catch (err) {
    logger.warn(`Failed to save OpenCode session map to disk: ${err}`);
  }
}

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
    loadSessionMap(); // Ensure map is loaded before any session operations
    logger.info(`OpenCode session key set to: ${key}`);
  }
}

/**
 * Get the stored session ID for a given key
 */
export function getOpenCodeSessionId(key: string): string | undefined {
  loadSessionMap();
  return sessionMap.get(key);
}

function storeSessionId(key: string, sessionId: string): void {
  sessionMap.set(key, sessionId);
  saveSessionMap();
  logger.info(`Stored OpenCode session ID: ${sessionId} for key: ${key}`);
}

/**
 * Clear the session for a given key (useful when starting a new chat)
 */
export function clearOpenCodeSession(key: string): void {
  sessionMap.delete(key);
  saveSessionMap();
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

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function stripFileWrapper(output: string): string {
  let result = output;
  const fileMatch = result.match(/^<file>\n?([\s\S]*?)\n?<\/file>$/);
  if (fileMatch) {
    result = fileMatch[1];
  }
  result = result.replace(/^\d{5}\| /gm, "");
  return result;
}

function isFileWriteTool(name: string): boolean {
  return name === "write";
}

function isFileEditTool(name: string): boolean {
  return name === "edit";
}

function isFileReadTool(name: string): boolean {
  return name === "read";
}

function isGlobTool(name: string): boolean {
  return name === "glob";
}

function isGrepTool(name: string): boolean {
  return name === "grep" || name === "ast_grep_search";
}

function isBashTool(name: string): boolean {
  return name === "bash";
}

function isInternalTool(name: string): boolean {
  return ["todowrite", "call_omo_agent", "background_output", "todoread"].includes(name);
}

function buildOpeningTag(
  toolName: string,
  input: Record<string, unknown> | undefined,
  title: string | undefined,
): string {
  const filePath = ((input?.filePath || input?.path || input?.file || "") as string);
  const description = title || toolName;

  if (isFileWriteTool(toolName)) {
    return `\n<dyad-write path="${escapeAttr(filePath)}" description="${escapeAttr(description)}">`;
  }
  if (isFileEditTool(toolName)) {
    return `\n<dyad-write path="${escapeAttr(filePath)}" description="${escapeAttr(description)}">`;
  }
  if (isFileReadTool(toolName)) {
    return `\n<dyad-read path="${escapeAttr(filePath)}">`;
  }
  if (isGlobTool(toolName)) {
    const dir = (input?.path || input?.pattern || "") as string;
    return `\n<dyad-list-files directory="${escapeAttr(dir)}">`;
  }
  if (isGrepTool(toolName)) {
    return "\n<dyad-code-search-result>";
  }
  if (isBashTool(toolName)) {
    const cmd = (input?.command || "") as string;
    const desc = (input?.description || "") as string;
    return `\n<dyad-mcp-tool-call server="opencode" tool="bash">${escapeAttr(desc || cmd)}`;
  }
  return `\n<dyad-mcp-tool-call server="opencode" tool="${escapeAttr(toolName)}">`;
}

function buildClosingTag(
  toolName: string,
  input: Record<string, unknown> | undefined,
  output: string | undefined,
  metadata: Record<string, unknown> | undefined,
): string {
  if (isFileWriteTool(toolName)) {
    const content = (input?.content as string) || output || "";
    return `${content}</dyad-write>\n`;
  }
  if (isFileEditTool(toolName)) {
    const diff = (metadata?.diff as string) || output || "";
    return `${diff}</dyad-write>\n`;
  }
  if (isFileReadTool(toolName)) {
    const content = stripFileWrapper(output || "");
    return `${content}</dyad-read>\n`;
  }
  if (isGlobTool(toolName)) {
    return `${output || ""}</dyad-list-files>\n`;
  }
  if (isGrepTool(toolName)) {
    return `${output || ""}</dyad-code-search-result>\n`;
  }
  if (isBashTool(toolName)) {
    const exitCode = metadata?.exit ?? "";
    const resultOutput = (metadata?.output as string) || output || "";
    return `</dyad-mcp-tool-call>\n<dyad-mcp-tool-result server="opencode" tool="bash">${resultOutput}${exitCode !== "" && exitCode !== 0 ? `\n(exit code: ${exitCode})` : ""}</dyad-mcp-tool-result>\n`;
  }
  return `</dyad-mcp-tool-call>\n<dyad-mcp-tool-result server="opencode" tool="${escapeAttr(toolName)}">${output || ""}</dyad-mcp-tool-result>\n`;
}

function buildErrorTag(
  toolName: string,
  errorMsg: string,
  hadOpeningTag: boolean,
): string {
  let result = "";
  if (hadOpeningTag) {
    if (isFileWriteTool(toolName) || isFileEditTool(toolName)) {
      result += "</dyad-write>\n";
    } else if (isFileReadTool(toolName)) {
      result += "</dyad-read>\n";
    } else if (isGlobTool(toolName)) {
      result += "</dyad-list-files>\n";
    } else if (isGrepTool(toolName)) {
      result += "</dyad-code-search-result>\n";
    } else {
      result += "</dyad-mcp-tool-call>\n";
    }
  }
  result += `<dyad-output type="error" message="${escapeAttr(errorMsg)}"></dyad-output>\n`;
  return result;
}

/**
 * Creates an OpenCode CLI provider that implements the LanguageModelV2 interface
 */
export function createOpenCodeProvider(
  options?: OpenCodeProviderOptions
): OpenCodeProvider {
  if (!isOpenCodeAvailable()) {
    throw new Error(
      "OpenCode CLI is not installed. Install it from: https://opencode.ai"
    );
  }

  return (modelId: string): LanguageModelV2 => {
    const effectiveModel = modelId || options?.model;
    logger.info(`[DEBUG MODEL TRACE] createOpenCodeProvider called: modelId="${modelId}", options?.model="${options?.model}", effectiveModel="${effectiveModel}"`);

    return {
      specificationVersion: "v2",
      provider: "opencode",
      modelId: effectiveModel || "default",
      supportedUrls: {},
      
      async doGenerate(options): Promise<any> {
        const { prompt, abortSignal } = options;
        
        const userMessage = extractUserMessage(prompt);
        
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

          logger.info(`OpenCode CLI doGenerate with model: ${effectiveModel}, cwd: ${currentWorkingDirectory || process.cwd()}`);
          logger.info(`[DEBUG MODEL TRACE] doGenerate full args: ${JSON.stringify([opencodePath, ...args])}`);
          logger.info(`[DEBUG MODEL TRACE] doGenerate env: HOME=${process.env.HOME}, XDG_CONFIG_HOME=${process.env.XDG_CONFIG_HOME || "(unset)"}, OPENCODE_MODEL=${process.env.OPENCODE_MODEL || "(unset)"}`);

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
        
        const userMessage = extractUserMessage(prompt);
        
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

        logger.info(`OpenCode CLI doStream with model: ${effectiveModel}, cwd: ${currentWorkingDirectory || process.cwd()}`);
        logger.info(`[DEBUG MODEL TRACE] doStream full args: ${JSON.stringify([opencodePath, ...args])}`);
        logger.info(`[DEBUG MODEL TRACE] doStream env: HOME=${process.env.HOME}, XDG_CONFIG_HOME=${process.env.XDG_CONFIG_HOME || "(unset)"}, OPENCODE_MODEL=${process.env.OPENCODE_MODEL || "(unset)"}`);

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
                    logger.error(`[DEBUG MODEL TRACE] OpenCode error event FULL: ${JSON.stringify(event)}`);
                    const errorMsg = event.error.data?.message || event.error.name;
                    controller.error(new Error(errorMsg));
                    streamClosed = true;
                    return;
                  }

                  if (event.type === "step_start") {
                    // Send a visual indicator that a new step is starting
                    if (!textStartSent) {
                      controller.enqueue({
                        type: "text-start",
                        id: textId,
                      });
                      textStartSent = true;
                    }
                    logger.debug(`OpenCode step started: ${event.part.messageID}`);
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

                    if (isInternalTool(toolName)) {
                      logger.debug(`Skipping internal tool: ${toolName}`);
                      continue;
                    }
                    
                    if (!textStartSent) {
                      controller.enqueue({
                        type: "text-start",
                        id: textId,
                      });
                      textStartSent = true;
                    }

                    if (status === "pending" || status === "running") {
                      if (!activeTools.has(callID)) {
                        activeTools.set(callID, toolName);
                        const delta = buildOpeningTag(toolName, tool.state.input, tool.state.title);
                        controller.enqueue({
                          type: "text-delta",
                          id: textId,
                          delta,
                        });
                      }
                    } else if (status === "completed") {
                      const hadOpening = activeTools.has(callID);
                      if (!hadOpening) {
                        const openTag = buildOpeningTag(toolName, tool.state.input, tool.state.title);
                        controller.enqueue({
                          type: "text-delta",
                          id: textId,
                          delta: openTag,
                        });
                      }
                      activeTools.delete(callID);
                      const delta = buildClosingTag(toolName, tool.state.input, tool.state.output, tool.state.metadata);
                      controller.enqueue({
                        type: "text-delta",
                        id: textId,
                        delta,
                      });
                      logger.info(`OpenCode tool completed: ${toolName}`);
                    } else if (status === "error") {
                      const hadOpening = activeTools.has(callID);
                      activeTools.delete(callID);
                      const errorMsg = tool.state.error || "Unknown error";
                      const delta = buildErrorTag(toolName, errorMsg, hadOpening);
                      controller.enqueue({
                        type: "text-delta",
                        id: textId,
                        delta,
                      });
                      logger.warn(`OpenCode tool error: ${toolName} - ${errorMsg}`);
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
                  logger.debug(`Non-JSON from OpenCode CLI: ${trimmedLine.slice(0, 100)}`);
                }
              }
            });

            opencodeProcess.stderr.on("data", (data: Buffer) => {
              const text = data.toString();
              logger.error(`[DEBUG MODEL TRACE] OpenCode CLI stderr: ${text}`);
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
                  const event = JSON.parse(buffer.trim()) as OpenCodeStreamEvent;
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
