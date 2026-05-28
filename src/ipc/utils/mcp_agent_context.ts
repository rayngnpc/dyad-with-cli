/**
 * Factory for creating synthetic AgentContext instances for MCP tool calls.
 *
 * MCP calls originate from external clients (not Electron IPC), so they
 * don't have a real IpcMainInvokeEvent or chat context. This factory
 * creates a minimal context that satisfies the AgentContext interface
 * while safely no-oping UI-specific callbacks.
 */

import type { IpcMainInvokeEvent } from "electron";
import type {
  AgentContext,
  FileEditTracker,
} from "@/pro/main/ipc/handlers/local_agent/tools/types";

interface McpAgentContextParams {
  readonly appId: number;
  readonly appPath: string;
}

export function createMcpAgentContext(
  params: McpAgentContextParams,
): AgentContext {
  return {
    // MCP calls don't originate from Electron IPC — no real event exists.
    // No existing tool uses `event` for anything beyond sender identification.
    event: null as unknown as IpcMainInvokeEvent,
    appId: params.appId,
    appPath: params.appPath,
    chatId: -1,
    supabaseProjectId: null,
    supabaseOrganizationSlug: null,
    messageId: -1,
    isSharedModulesChanged: false,
    todos: [],
    dyadRequestId: `mcp-${Date.now()}`,
    fileEditTracker: {} as FileEditTracker,
    isDyadPro: false,
    onXmlStream: () => {},
    onXmlComplete: () => {},
    requireConsent: async () => true,
    appendUserMessage: () => {},
    onUpdateTodos: () => {},
  };
}
