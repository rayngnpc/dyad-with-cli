import { ipcMain } from "electron";
import log from "electron-log";
import { execSync } from "node:child_process";
import type { LocalModelListResponse, LocalModel } from "../ipc_types";

const logger = log.scope("opencode_handler");

// Default path to opencode CLI
export function getOpenCodePath(): string {
  if (process.env.OPENCODE_PATH) return process.env.OPENCODE_PATH;

  try {
    const resolved = execSync(
      "which opencode 2>/dev/null || command -v opencode 2>/dev/null",
      {
        encoding: "utf-8",
        shell: "/bin/bash",
      }
    ).trim();
    if (resolved) return resolved;
  } catch {
    // Fall through to common local paths.
  }

  const home = process.env.HOME || "";
  const candidates = [
    `${home}/bin/opencode`,
    `${home}/bin/opencode-zsh`,
    `${home}/.npm-global/bin/opencode`,
    `${home}/.local/bin/opencode`,
    "/usr/local/bin/opencode",
    "/usr/bin/opencode",
  ];

  for (const candidate of candidates) {
    try {
      execSync(`test -x "${candidate}"`, { stdio: "ignore" });
      return candidate;
    } catch {
      // try next
    }
  }

  return "opencode";
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
  const lines = output.split("\n").filter(line => line.trim());
  
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("opencode/")) {
      // Skip opencode's built-in/test models
      continue;
    }
    
    const parts = trimmed.split("/");
    if (parts.length >= 2) {
      const provider = parts[0];
      const model = parts.slice(1).join("/");
      
      // Create display name
      const displayName = model
        .replace(/-/g, " ")
        .replace(/\./g, " ")
        .split(" ")
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(" ");
      
      models.push({
        provider,
        model: trimmed, // Full model ID including provider
        displayName: `${displayName} (${provider})`,
      });
    }
  }
  
  return models;
}

/**
 * Fetch available models from OpenCode CLI
 */
export async function fetchOpenCodeModels(): Promise<LocalModelListResponse> {
  if (!isOpenCodeAvailable()) {
    throw new Error(
      "OpenCode CLI is not installed or not found in PATH. Install it from: https://opencode.ai"
    );
  }

  const version = getOpenCodeVersion();
  logger.info(`OpenCode CLI detected, version: ${version}`);

  try {
    const opencodePath = getOpenCodePath();
    const output = execSync(`${opencodePath} models`, { encoding: "utf-8" });
    
    const parsedModels = parseOpenCodeModels(output);
    
    const localModels: LocalModel[] = parsedModels.map(m => ({
      modelName: m.model,
      displayName: m.displayName,
      provider: "opencode",
    }));

    logger.info(`Found ${localModels.length} models for OpenCode CLI`);
    return { models: localModels };
  } catch (error) {
    logger.error("Failed to fetch OpenCode models:", error);
    throw new Error("Failed to fetch OpenCode models. Is OpenCode CLI configured?");
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
    }
  );

  ipcMain.handle(
    "local-models:opencode-available",
    async (): Promise<boolean> => {
      return isOpenCodeAvailable();
    }
  );

  ipcMain.handle(
    "local-models:opencode-version",
    async (): Promise<string | null> => {
      return getOpenCodeVersion();
    }
  );
}
