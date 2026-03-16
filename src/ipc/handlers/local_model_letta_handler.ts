import { ipcMain } from "electron";
import log from "electron-log";
import { execSync } from "node:child_process";
import type { LocalModel } from "../types/language-model";

const logger = log.scope("letta_handler");

// Default path to letta CLI - use absolute path for Electron environment reliability
export function getLettaPath(): string {
  return process.env.LETTA_PATH || "/home/raywar/.npm-global/bin/letta";
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
  // Model handles verified from Letta Code v0.18.4
  const models: LettaModelInfo[] = [
    { model: "auto", displayName: "Auto (Default)" },
    // Anthropic
    { model: "claude-opus-4-6", displayName: "Claude Opus 4.6" },
    { model: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6" },
    { model: "claude-opus-4-5", displayName: "Claude Opus 4.5" },
    { model: "claude-sonnet-4-5-20250929", displayName: "Claude Sonnet 4.5" },
    { model: "claude-sonnet-4-20250514", displayName: "Claude Sonnet 4" },
    // OpenAI
    { model: "gpt-5.2", displayName: "GPT-5.2" },
    { model: "gpt-5.1", displayName: "GPT-5.1" },
    { model: "gpt-5.1-codex", displayName: "GPT-5.1 Codex" },
    { model: "gpt-5.1-codex-mini", displayName: "GPT-5.1 Codex Mini" },
    { model: "gpt-5", displayName: "GPT-5" },
    { model: "gpt-5-codex", displayName: "GPT-5 Codex" },
    { model: "gpt-5-mini", displayName: "GPT-5 Mini" },
    { model: "gpt-5-nano", displayName: "GPT-5 Nano" },
    // Google
    { model: "gemini-3.1-pro-preview", displayName: "Gemini 3.1 Pro (Preview)" },
    { model: "gemini-3-flash-preview", displayName: "Gemini 3 Flash (Preview)" },
    { model: "gemini-2.5-pro", displayName: "Gemini 2.5 Pro" },
    { model: "gemini-flash-latest", displayName: "Gemini 2.5 Flash" },
    // xAI
    { model: "grok-4", displayName: "Grok 4" },
    { model: "grok-code-fast-1", displayName: "Grok Code Fast" },
    { model: "grok-3", displayName: "Grok 3" },
    // OpenRouter
    { model: "qwen/qwen3-coder", displayName: "Qwen3 Coder (OpenRouter)" },
    { model: "deepseek/deepseek-chat-v3.1", displayName: "DeepSeek v3.1 (OpenRouter)" },
    { model: "moonshotai/kimi-k2.5", displayName: "Kimi K2.5 (OpenRouter)" },
    { model: "openrouter/free", displayName: "Free (OpenRouter)" },
  ];

  return models;
}

/**
 * Fetch available models from Letta CLI
 */
export async function fetchLettaModels(): Promise<{ models: LocalModel[] }> {
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
    async (): Promise<{ models: LocalModel[] }> => {
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
