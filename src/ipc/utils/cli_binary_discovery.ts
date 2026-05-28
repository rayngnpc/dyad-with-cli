import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import log from "electron-log";

const logger = log.scope("cli_binary_discovery");

/**
 * Cross-platform CLI binary discovery for OpenCode / Gemini CLI / Letta.
 *
 * Resolution order:
 *   1. Environment variable override (e.g. OPENCODE_PATH)
 *   2. Shell lookup — `where` on Windows, `which`/`command -v` on Unix
 *   3. Common installation paths per OS:
 *        - Linux:   ~/bin, ~/.npm-global/bin, ~/.local/bin, /usr/local/bin, /usr/bin
 *        - macOS:   Linux paths + Homebrew (/opt/homebrew/bin on Apple Silicon,
 *                   /opt/local/bin for MacPorts users)
 *        - Windows: %USERPROFILE%\.local\bin, %APPDATA%\npm,
 *                   %LOCALAPPDATA%\Programs\<name>, %ProgramFiles%\<name>
 *                   Each with .exe / .cmd / .bat / no-extension variants.
 *   4. Bare binary name as a last-resort fallback (relies on PATH at spawn).
 */
export interface FindCliBinaryOptions {
  /** Binary base name without extension, e.g. "opencode". */
  name: string;
  /** Env var to check first, e.g. "OPENCODE_PATH". */
  envVar: string;
  /**
   * Additional binary names to also probe under each candidate dir.
   * Example: OpenCode has the alternate name "opencode-zsh".
   */
  aliases?: string[];
}

export function findCliBinary(opts: FindCliBinaryOptions): string {
  // 1. Env var override
  const envPath = process.env[opts.envVar];
  if (envPath && fs.existsSync(envPath)) return envPath;
  if (envPath) {
    // Set but missing — log and continue to PATH lookup.
    logger.warn(
      `${opts.envVar} is set to "${envPath}" but the file does not exist; falling back to PATH lookup`,
    );
  }

  const isWindows = process.platform === "win32";
  const isMac = process.platform === "darwin";
  const names = [opts.name, ...(opts.aliases ?? [])];

  // 2. Shell lookup
  for (const name of names) {
    const resolved = tryShellLookup(name, isWindows);
    if (resolved) return resolved;
  }

  // 3. OS-specific candidate paths
  const candidates: string[] = [];
  for (const name of names) {
    if (isWindows) {
      candidates.push(...windowsCandidates(name));
    } else {
      candidates.push(...unixCandidates(name, isMac));
    }
  }

  for (const candidate of candidates) {
    if (isExecutableFile(candidate, isWindows)) {
      return candidate;
    }
  }

  // 4. Last-resort fallback — let the OS resolve via PATH at spawn time.
  return opts.name;
}

/**
 * Linux + macOS candidate paths for a binary called `name`.
 */
function unixCandidates(name: string, isMac: boolean): string[] {
  const home = process.env.HOME || "";
  const paths: string[] = [
    `${home}/bin/${name}`,
    `${home}/.npm-global/bin/${name}`,
    `${home}/.local/bin/${name}`,
    `/usr/local/bin/${name}`,
    `/usr/bin/${name}`,
  ];
  if (isMac) {
    paths.push(`/opt/homebrew/bin/${name}`); // Apple Silicon Homebrew
    paths.push(`/opt/local/bin/${name}`); // MacPorts
  }
  return paths;
}

/**
 * Windows candidate paths for a binary called `name`. We probe every
 * common install location with all the extensions Windows commonly
 * uses (.exe for native binaries, .cmd / .bat for npm shims, no ext
 * if a user manually placed a wrapper script).
 */
function windowsCandidates(name: string): string[] {
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const localAppData =
    process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
  const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
  const programFiles = process.env.ProgramFiles || "C:\\Program Files";
  const exts = [".exe", ".cmd", ".bat", ""];
  const baseDirs = [
    path.join(home, ".local", "bin"),
    path.join(appData, "npm"),
    path.join(localAppData, "Programs", name),
    path.join(programFiles, name),
  ];
  const paths: string[] = [];
  for (const dir of baseDirs) {
    for (const ext of exts) {
      paths.push(path.join(dir, `${name}${ext}`));
    }
  }
  return paths;
}

/**
 * Use the OS-native PATH lookup tool to find `name`. Returns the first
 * match, or null if not found.
 */
function tryShellLookup(name: string, isWindows: boolean): string | null {
  try {
    if (isWindows) {
      // `where` is the Windows equivalent of which/command -v.
      const result = execSync(`where ${name}`, {
        encoding: "utf-8",
        windowsHide: true,
      }).trim();
      // `where` outputs one path per line; take the first.
      const firstLine = result.split(/\r?\n/)[0]?.trim();
      if (firstLine) return firstLine;
    } else {
      const result = execSync(
        `which ${name} 2>/dev/null || command -v ${name} 2>/dev/null`,
        {
          encoding: "utf-8",
          shell: "/bin/bash",
        },
      ).trim();
      if (result) return result;
    }
  } catch {
    // not found — caller falls through to candidate paths
  }
  return null;
}

/**
 * Check whether a file exists and is executable. On Windows the
 * executable bit doesn't apply, so existence is sufficient.
 */
function isExecutableFile(filePath: string, isWindows: boolean): boolean {
  try {
    if (isWindows) {
      return fs.existsSync(filePath);
    }
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
