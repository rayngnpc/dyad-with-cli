import { ipcMain } from "electron";
import log from "electron-log";
import { execSync } from "node:child_process";
import type { LocalModel } from "../types";
import { findCliBinary } from "../utils/cli_binary_discovery";

type LocalModelListResponse = { models: LocalModel[] };

const logger = log.scope("opencode_handler");

// Default path to opencode CLI — cross-platform discovery (Linux + macOS + Windows).
export function getOpenCodePath(): string {
  return findCliBinary({
    name: "opencode",
    envVar: "OPENCODE_PATH",
    aliases: ["opencode-zsh"],
  });
}

/**
 * Check if OpenCode CLI is available on the system
 */
export function isOpenCodeAvailable(): boolean {
  try {
    const opencodePath = getOpenCodePath();
    execSync(`${opencodePath} --version`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the version of OpenCode CLI
 */
export function getOpenCodeVersion(): string | null {
  try {
    const opencodePath = getOpenCodePath();
    const output = execSync(`${opencodePath} --version`, { encoding: "utf-8" });
    return output.trim();
  } catch {
    return null;
  }
}

/**
 * OpenCode model information with provider grouping
 */
interface OpenCodeModelInfo {
  provider: string;
  model: string;
  displayName: string;
}

/**
 * Parse model list from opencode models command
 */
function parseOpenCodeModels(output: string): OpenCodeModelInfo[] {
  const models: OpenCodeModelInfo[] = [];
  const lines = output.split("\n").filter((line) => line.trim());

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const parts = trimmed.split("/");
    if (parts.length >= 2) {
      const provider = parts[0];
      const model = parts.slice(1).join("/");

      const prettyModel = model
        .replace(/-/g, " ")
        .replace(/\./g, " ")
        .split(" ")
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(" ");

      models.push({
        provider,
        model: trimmed,
        displayName: prettyModel,
      });
    }
  }

  // Sort by sub-provider, then by model name for clean grouping in the picker.
  models.sort((a, b) => {
    if (a.provider !== b.provider) return a.provider.localeCompare(b.provider);
    return a.model.localeCompare(b.model);
  });

  return models;
}

/**
 * Fetch available models from OpenCode CLI
 */
export async function fetchOpenCodeModels(): Promise<LocalModelListResponse> {
  if (!isOpenCodeAvailable()) {
    throw new Error(
      "OpenCode CLI is not installed or not found in PATH. Install it from: https://opencode.ai",
    );
  }

  const version = getOpenCodeVersion();
  logger.info(`OpenCode CLI detected, version: ${version}`);

  try {
    const opencodePath = getOpenCodePath();
    const output = execSync(`${opencodePath} models`, { encoding: "utf-8" });

    const parsedModels = parseOpenCodeModels(output);

    const localModels: LocalModel[] = parsedModels.map((m) => ({
      modelName: m.model,
      displayName: m.displayName,
      provider: "opencode",
    }));

    logger.info(`Found ${localModels.length} models for OpenCode CLI`);
    return { models: localModels };
  } catch (error) {
    logger.error("Failed to fetch OpenCode models:", error);
    throw new Error(
      "Failed to fetch OpenCode models. Is OpenCode CLI configured?",
    );
  }
}

/**
 * Register IPC handlers for OpenCode CLI
 */
export function registerOpenCodeHandlers() {
  ipcMain.handle(
    "local-models:list-opencode",
    async (): Promise<LocalModelListResponse> => {
      return fetchOpenCodeModels();
    },
  );

  ipcMain.handle(
    "local-models:opencode-available",
    async (): Promise<boolean> => {
      return isOpenCodeAvailable();
    },
  );

  ipcMain.handle(
    "local-models:opencode-version",
    async (): Promise<string | null> => {
      return getOpenCodeVersion();
    },
  );
}
