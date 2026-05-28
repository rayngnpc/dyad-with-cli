/**
 * Audit logger for MCP server tool calls.
 *
 * Logs structured entries for every tool invocation so administrators
 * can review what external clients are doing. Uses electron-log to
 * stay consistent with the rest of the project (no console.log).
 */

import log from "electron-log";

export interface McpAuditEntry {
  /** ISO-8601 timestamp */
  readonly timestamp: string;
  /** Name of the MCP tool that was invoked */
  readonly toolName: string;
  /** Summarized arguments (keys only, truncated values) */
  readonly argsSummary: string;
  /** Whether the call succeeded or errored */
  readonly status: "success" | "error";
  /** Execution time in milliseconds */
  readonly durationMs: number;
  /** Client IP address */
  readonly clientIp: string;
  /** Error message if status is "error" */
  readonly errorMessage?: string;
}

/**
 * Summarize tool arguments for audit logging.
 * Shows object keys and truncates large/sensitive values.
 */
export function summarizeArgs(
  args: Record<string, unknown>,
  maxLength = 200,
): string {
  if (!args || typeof args !== "object") return "{}";

  const parts: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    let valueStr: string;
    if (typeof value === "string") {
      valueStr =
        value.length > 50 ? `"${value.slice(0, 50)}…"` : `"${value}"`;
    } else if (value === null || value === undefined) {
      valueStr = String(value);
    } else if (typeof value === "object") {
      valueStr = Array.isArray(value)
        ? `[Array(${value.length})]`
        : "[Object]";
    } else {
      valueStr = String(value);
    }
    parts.push(`${key}: ${valueStr}`);
  }

  const summary = `{ ${parts.join(", ")} }`;
  if (summary.length > maxLength) {
    return `${summary.slice(0, maxLength)}…`;
  }
  return summary;
}

/**
 * Log a completed MCP tool call.
 */
export function logToolCall(entry: McpAuditEntry): void {
  const level = entry.status === "error" ? "warn" : "info";
  const errorSuffix =
    entry.status === "error" && entry.errorMessage
      ? ` | error: ${entry.errorMessage}`
      : "";

  log[level](
    `[MCP Audit] ${entry.status.toUpperCase()} tool=${entry.toolName} ip=${entry.clientIp} duration=${entry.durationMs}ms args=${entry.argsSummary}${errorSuffix}`,
  );
}
