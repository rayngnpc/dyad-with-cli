import { execSync, spawn } from "node:child_process";
import { ipcMain } from "electron";
import log from "electron-log";
import type { LocalModel, LocalModelListResponse } from "../ipc_types";

const logger = log.scope("gemini_cli_handler");

// Default path to gemini CLI - can be overridden with GEMINI_CLI_PATH env var
export function getGeminiCliPath(): string {
  if (process.env.GEMINI_CLI_PATH) return process.env.GEMINI_CLI_PATH;

  try {
    const resolved = execSync(
      "which gemini 2>/dev/null || command -v gemini 2>/dev/null",
      {
        encoding: "utf-8",
        shell: "/bin/bash",
      },
    ).trim();
    if (resolved) return resolved;
  } catch {
    // Fall through to common local paths.
  }

  const home = process.env.HOME || "";
  const candidates = [
    `${home}/bin/gemini`,
    `${home}/.npm-global/bin/gemini`,
    `${home}/.local/bin/gemini`,
    "/usr/local/bin/gemini",
    "/usr/bin/gemini",
  ];

  for (const candidate of candidates) {
    try {
      execSync(`test -x "${candidate}"`, { stdio: "ignore" });
      return candidate;
    } catch {
      // try next
    }
  }

  return "gemini";
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

type GeminiStreamEvent =
  | GeminiStreamInit
  | GeminiStreamMessage
  | GeminiStreamResult;

/**
 * Fetch available models from Gemini CLI
 * Note: Gemini CLI doesn't have a direct "list models" feature,
 * so we return a predefined list of available Gemini models that can be used via CLI
 */
export async function fetchGeminiCliModels(): Promise<LocalModelListResponse> {
  // First, check if Gemini CLI is available
  if (!isGeminiCliAvailable()) {
    throw new Error(
      "Gemini CLI is not installed or not found in PATH. Install it from: https://github.com/google-gemini/gemini-cli",
    );
  }

  const version = getGeminiCliVersion();
  logger.info(`Gemini CLI detected, version: ${version}`);

  // Mirror Gemini CLI selector modes + explicit model selection.
  // Notes:
  // - "Auto (Gemini 3)" maps to default headless behavior (no explicit --model).
  // - "Manual" is represented as a Dyad option; in headless mode we fall back to default routing.
  // - Specific models pass --model <name> to gemini CLI for explicit selection.
  const geminiModels: LocalModel[] = [
    // Auto modes
    {
      modelName: "auto",
      displayName: "Auto (Gemini 3)",
      provider: "gemini_cli",
    },
    {
      modelName: "auto-2.5",
      displayName: "Auto (Gemini 2.5)",
      provider: "gemini_cli",
    },
    {
      modelName: "manual",
      displayName: "Manual",
      provider: "gemini_cli",
    },
    // Gemini 3.x series
    {
      modelName: "gemini-3.1-pro-preview",
      displayName: "Gemini 3.1 Pro (Preview)",
      provider: "gemini_cli",
    },
    {
      modelName: "gemini-3-flash-preview",
      displayName: "Gemini 3 Flash (Preview)",
      provider: "gemini_cli",
    },
    {
      modelName: "gemini-3.1-flash-lite-preview",
      displayName: "Gemini 3.1 Flash Lite (Preview)",
      provider: "gemini_cli",
    },
    // Gemini 2.5 series
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
  options: GeminiCliStreamOptions,
): Promise<void> {
  const {
    prompt,
    model = "auto",
    onChunk,
    onComplete,
    onError,
    abortSignal,
  } = options;

  const geminiPath = getGeminiCliPath();
  const args = ["--output-format", "stream-json", "-p", prompt];

  if (model && model !== "auto" && model !== "manual") {
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
      if (
        !trimmedLine ||
        trimmedLine.startsWith("[STARTUP]") ||
        trimmedLine.startsWith("Loaded cached")
      ) {
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
    if (
      !errorText.includes("[STARTUP]") &&
      !errorText.includes("Loaded cached")
    ) {
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
    },
  );

  ipcMain.handle(
    "local-models:gemini-cli-available",
    async (): Promise<boolean> => {
      return isGeminiCliAvailable();
    },
  );

  ipcMain.handle(
    "local-models:gemini-cli-version",
    async (): Promise<string | null> => {
      return getGeminiCliVersion();
    },
  );
}
