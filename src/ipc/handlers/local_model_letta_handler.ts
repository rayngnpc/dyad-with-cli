import { ipcMain } from "electron";
import log from "electron-log";
import { execSync } from "node:child_process";
import type { LocalModelListResponse, LocalModel } from "../ipc_types";

const logger = log.scope("letta_handler");

// Default path to letta CLI
export function getLettaPath(): string {
  return process.env.LETTA_PATH || "letta";
}

/**
 * Check if Letta CLI is available on the system
 */
export function isLettaAvailable(): boolean {
  try {
    const lettaPath = getLettaPath();
    execSync(`${lettaPath} --version`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the version of Letta CLI
 */
export function getLettaVersion(): string | null {
  try {
    const lettaPath = getLettaPath();
    const output = execSync(`${lettaPath} --version`, { encoding: "utf-8" });
    return output.trim();
  } catch {
    return null;
  }
}

/**
 * Letta model information
 */
interface LettaModelInfo {
  model: string;
  displayName: string;
}

/**
 * Get available models for Letta
 * Letta uses -m flag with model handles
 */
function getLettaModels(): LettaModelInfo[] {
  // Letta supports various models through its -m flag
  // These are the model handles available from `letta --help`
  const models: LettaModelInfo[] = [
    { model: "auto", displayName: "Auto (Default)" },
    // Anthropic models
    { model: "opus", displayName: "Claude Opus 4.5" },
    { model: "opus-4.1", displayName: "Claude Opus 4.1" },
    { model: "sonnet-4.5", displayName: "Claude Sonnet 4.5" },
    { model: "sonnet-4.5-no-reasoning", displayName: "Claude Sonnet 4.5 (No Reasoning)" },
    { model: "haiku", displayName: "Claude Haiku 4.5" },
    // OpenAI models
    { model: "gpt-5-codex", displayName: "GPT-5 Codex" },
    { model: "gpt-5.2-medium", displayName: "GPT-5.2 (Medium)" },
    { model: "gpt-5.2-high", displayName: "GPT-5.2 (High)" },
    { model: "gpt-5.1-medium", displayName: "GPT-5.1 (Medium)" },
    { model: "gpt-5.1-high", displayName: "GPT-5.1 (High)" },
    { model: "gpt-5.1-codex-medium", displayName: "GPT-5.1 Codex (Medium)" },
    { model: "gpt-5.1-codex-high", displayName: "GPT-5.1 Codex (High)" },
    { model: "gpt-5-medium", displayName: "GPT-5 (Medium)" },
    { model: "gpt-5-high", displayName: "GPT-5 (High)" },
    { model: "gpt-4.1", displayName: "GPT-4.1" },
    { model: "o4-mini", displayName: "O4 Mini" },
    // Google models
    { model: "gemini-3", displayName: "Gemini 3 Pro" },
    { model: "gemini-pro", displayName: "Gemini 2.5 Pro" },
    { model: "gemini-flash", displayName: "Gemini 2.5 Flash" },
    // Other models
    { model: "deepseek-chat-v3.1", displayName: "DeepSeek Chat v3.1" },
    { model: "kimi-k2", displayName: "Kimi K2" },
  ];

  return models;
}

/**
 * Fetch available models from Letta CLI
 */
export async function fetchLettaModels(): Promise<LocalModelListResponse> {
  if (!isLettaAvailable()) {
    throw new Error(
      "Letta CLI is not installed or not found in PATH. Install it from: https://github.com/letta-ai/letta-code"
    );
  }

  const version = getLettaVersion();
  logger.info(`Letta CLI detected, version: ${version}`);

  try {
    const models = getLettaModels();

    const localModels: LocalModel[] = models.map((m) => ({
      modelName: m.model,
      displayName: m.displayName,
      provider: "letta",
    }));

    logger.info(`Found ${localModels.length} models for Letta CLI`);
    return { models: localModels };
  } catch (error) {
    logger.error("Failed to fetch Letta models:", error);
    throw new Error("Failed to fetch Letta models. Is Letta CLI configured?");
  }
}

/**
 * Register IPC handlers for Letta CLI
 */
export function registerLettaHandlers() {
  ipcMain.handle(
    "local-models:list-letta",
    async (): Promise<LocalModelListResponse> => {
      return fetchLettaModels();
    }
  );

  ipcMain.handle("local-models:letta-available", async (): Promise<boolean> => {
    return isLettaAvailable();
  });

  ipcMain.handle(
    "local-models:letta-version",
    async (): Promise<string | null> => {
      return getLettaVersion();
    }
  );
}
