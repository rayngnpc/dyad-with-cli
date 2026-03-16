import { ipcMain } from "electron";
import log from "electron-log";
import { spawn, execSync } from "node:child_process";
import type { LocalModelListResponse, LocalModel } from "../ipc_types";

const logger = log.scope("gemini_cli_handler");

// Default path to gemini CLI - can be overridden with GEMINI_CLI_PATH env var
export function getGeminiCliPath(): string {
  return process.env.GEMINI_CLI_PATH || "gemini";
}

/**
 * Check if Gemini CLI is available on the system
 */
export function isGeminiCliAvailable(): boolean {
  try {
    const geminiPath = getGeminiCliPath();
    execSync(`${geminiPath} --version`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the version of Gemini CLI
 */
export function getGeminiCliVersion(): string | null {
  try {
    const geminiPath = getGeminiCliPath();
    const output = execSync(`${geminiPath} --version`, { encoding: "utf-8" });
    return output.trim();
  } catch {
    return null;
  }
}

/**
 * Interface for Gemini CLI streaming JSON responses
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

type GeminiStreamEvent = GeminiStreamInit | GeminiStreamMessage | GeminiStreamResult;

/**
 * Fetch available models from Gemini CLI
 * Note: Gemini CLI doesn't have a direct "list models" feature,
 * so we return a predefined list of available Gemini models that can be used via CLI
 */
export async function fetchGeminiCliModels(): Promise<LocalModelListResponse> {
  // First, check if Gemini CLI is available
  if (!isGeminiCliAvailable()) {
    throw new Error(
      "Gemini CLI is not installed or not found in PATH. Install it from: https://github.com/google-gemini/gemini-cli"
    );
  }

  const version = getGeminiCliVersion();
  logger.info(`Gemini CLI detected, version: ${version}`);

  // Gemini CLI supports these models through the --model flag
  // Based on the CLI's model selection menu
  const geminiModels: LocalModel[] = [
    {
      modelName: "gemini-3-pro-preview",
      displayName: "Gemini 3 Pro Preview",
      provider: "gemini_cli",
    },
    {
      modelName: "gemini-2.5-pro",
      displayName: "Gemini 2.5 Pro",
      provider: "gemini_cli",
    },
    {
      modelName: "gemini-2.5-flash",
      displayName: "Gemini 2.5 Flash",
      provider: "gemini_cli",
    },
    {
      modelName: "gemini-2.5-flash-lite",
      displayName: "Gemini 2.5 Flash Lite",
      provider: "gemini_cli",
    },
  ];

  logger.info(`Returning ${geminiModels.length} models for Gemini CLI`);
  return { models: geminiModels };
}

/**
 * Interface for streaming text from Gemini CLI
 */
export interface GeminiCliStreamOptions {
  prompt: string;
  model?: string;
  onChunk: (text: string) => void;
  onComplete: (response: string) => void;
  onError: (error: Error) => void;
  abortSignal?: AbortSignal;
}

/**
 * Stream a response from Gemini CLI
 */
export async function streamGeminiCliResponse(
  options: GeminiCliStreamOptions
): Promise<void> {
  const { prompt, model = "auto", onChunk, onComplete, onError, abortSignal } = options;
  
  const geminiPath = getGeminiCliPath();
  const args = [
    "--output-format", "stream-json",
    "-p", prompt,
  ];

  if (model && model !== "auto") {
    args.push("--model", model);
  }

  logger.info(`Spawning Gemini CLI with args: ${args.join(" ")}`);

  const geminiProcess = spawn(geminiPath, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      // Ensure GEMINI_API_KEY is passed through
    },
  });

  let fullResponse = "";
  let buffer = "";

  // Handle abort signal
  if (abortSignal) {
    abortSignal.addEventListener("abort", () => {
      logger.info("Aborting Gemini CLI process");
      geminiProcess.kill("SIGTERM");
    });
  }

  geminiProcess.stdout.on("data", (data: Buffer) => {
    buffer += data.toString();
    
    // Process line by line
    const lines = buffer.split("\n");
    buffer = lines.pop() || ""; // Keep incomplete line in buffer

    for (const line of lines) {
      const trimmedLine = line.trim();
      if (!trimmedLine || trimmedLine.startsWith("[STARTUP]") || trimmedLine.startsWith("Loaded cached")) {
        continue; // Skip startup messages and empty lines
      }

      try {
        const event = JSON.parse(trimmedLine) as GeminiStreamEvent;
        
        if (event.type === "message" && event.role === "assistant") {
          const content = event.content;
          if (event.delta) {
            // This is a delta/incremental update
            fullResponse = content;
          } else {
            fullResponse += content;
          }
          onChunk(content);
        } else if (event.type === "result") {
          if (event.status === "error") {
            onError(new Error("Gemini CLI returned an error"));
          } else {
            onComplete(fullResponse);
          }
        }
      } catch {
        // Not valid JSON, might be a status message - ignore
        logger.debug(`Non-JSON line from Gemini CLI: ${trimmedLine}`);
      }
    }
  });

  geminiProcess.stderr.on("data", (data: Buffer) => {
    const errorText = data.toString();
    // Filter out startup messages that go to stderr
    if (!errorText.includes("[STARTUP]") && !errorText.includes("Loaded cached")) {
      logger.warn(`Gemini CLI stderr: ${errorText}`);
    }
  });

  geminiProcess.on("error", (error) => {
    logger.error(`Gemini CLI process error: ${error.message}`);
    onError(error);
  });

  geminiProcess.on("close", (code) => {
    if (code !== 0 && code !== null) {
      logger.warn(`Gemini CLI exited with code ${code}`);
      if (!fullResponse) {
        onError(new Error(`Gemini CLI exited with code ${code}`));
      }
    }
    // Process any remaining buffer
    if (buffer.trim()) {
      try {
        const event = JSON.parse(buffer.trim()) as GeminiStreamEvent;
        if (event.type === "result" && event.status === "success") {
          onComplete(fullResponse);
        }
      } catch {
        // Ignore
      }
    }
  });
}

/**
 * Register IPC handlers for Gemini CLI
 */
export function registerGeminiCliHandlers() {
  ipcMain.handle(
    "local-models:list-gemini-cli",
    async (): Promise<LocalModelListResponse> => {
      return fetchGeminiCliModels();
    }
  );

  ipcMain.handle(
    "local-models:gemini-cli-available",
    async (): Promise<boolean> => {
      return isGeminiCliAvailable();
    }
  );

  ipcMain.handle(
    "local-models:gemini-cli-version",
    async (): Promise<string | null> => {
      return getGeminiCliVersion();
    }
  );
}
