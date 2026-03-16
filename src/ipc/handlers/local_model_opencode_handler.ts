import { ipcMain } from "electron";
import log from "electron-log";
import { execSync } from "node:child_process";
import type { LocalModel } from "../types/language-model";

const logger = log.scope("opencode_handler");

// Resolve opencode binary path. Electron doesn't inherit the user's full shell
// PATH, so we try common install locations in order.
export function getOpenCodePath(): string {
  if (process.env.OPENCODE_PATH) return process.env.OPENCODE_PATH;
  try {
    const result = execSync("which opencode 2>/dev/null || command -v opencode 2>/dev/null", {
      encoding: "utf-8",
      shell: "/bin/bash",
    }).trim();
    if (result) return result;
  } catch {
    // fall through to common locations
  }
  const home = process.env.HOME || "";
  const candidates = [
    `${home}/bin/opencode`,
    `${home}/.npm-global/bin/opencode`,
    `${home}/.local/bin/opencode`,
    "/usr/local/bin/opencode",
    "/usr/bin/opencode",
  ];
  for (const p of candidates) {
    try { execSync(`test -x "${p}"`, { stdio: "ignore" }); return p; } catch { /* try next */ }
  }
  return "opencode"; // last resort — let the OS find it
}

/**
 * Check if OpenCode CLI is available on the system
 */
export function isOpenCodeAvailable(): boolean {
  try {
    const opencodePath = getOpenCodePath();
    logger.info(`Checking OpenCode availability at: ${opencodePath}`);
    const version = execSync(`${opencodePath} --version`, { encoding: "utf-8", timeout: 10000 });
    logger.info(`OpenCode available: ${version.trim()}`);
    return true;
  } catch (err) {
    logger.error(`OpenCode not available at ${getOpenCodePath()}: ${err}`);
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
      
      // Create display name — preserve dots in version numbers (e.g. "4.6" stays "4.6")
      const displayName = model
        .replace(/-/g, " ")
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
export async function fetchOpenCodeModels(): Promise<{ models: LocalModel[] }> {
  if (!isOpenCodeAvailable()) {
    throw new Error(
      "OpenCode CLI is not installed or not found in PATH. Install it from: https://opencode.ai"
    );
  }

  const version = getOpenCodeVersion();
  logger.info(`OpenCode CLI detected, version: ${version}`);

  try {
    const opencodePath = getOpenCodePath();
    const output = execSync(`${opencodePath} models`, {
      encoding: "utf-8",
      timeout: 30000,
      env: { ...process.env, HOME: process.env.HOME || "" },
    });
    
    const parsedModels = parseOpenCodeModels(output);
    
    const localModels: LocalModel[] = parsedModels.map(m => ({
      modelName: m.model,
      displayName: m.displayName,
      provider: "opencode",
    }));

    logger.info(`Found ${localModels.length} models for OpenCode CLI`);
    return { models: localModels };
  } catch (error: any) {
    logger.error("Failed to fetch OpenCode models:", error?.message || error);
    logger.error("OpenCode path:", getOpenCodePath());
    logger.error("PATH env:", process.env.PATH?.substring(0, 200));
    throw new Error(`Failed to fetch OpenCode models: ${error?.message || "Unknown error"}. Is OpenCode CLI configured?`);
  }
}

/**
 * Register IPC handlers for OpenCode CLI
 */
export function registerOpenCodeHandlers() {
  ipcMain.handle(
    "local-models:list-opencode",
    async (): Promise<{ models: LocalModel[] }> => {
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
