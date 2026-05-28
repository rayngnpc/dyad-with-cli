/**
 * IPC handlers for controlling the MCP server from the renderer process.
 */

import { mcpServerContracts } from "../types/mcp_server";
import { mcpServerManager } from "../utils/mcp_server_manager";
import { createTypedHandler } from "./base";

export function registerMcpServerHandlers(): void {
  createTypedHandler(mcpServerContracts.start, async (_event, params) => {
    const port = params.port ?? 31999;
    await mcpServerManager.start(port);
    return { success: true, port };
  });

  createTypedHandler(mcpServerContracts.stop, async () => {
    await mcpServerManager.stop();
    return { success: true };
  });

  createTypedHandler(mcpServerContracts.status, async () => {
    return {
      running: mcpServerManager.isRunning(),
      port: mcpServerManager.getPort(),
      activeAppId: mcpServerManager.getActiveAppId(),
      authToken: mcpServerManager.getAuthToken(),
    };
  });

  createTypedHandler(mcpServerContracts.setActiveApp, async (_event, params) => {
    mcpServerManager.setActiveApp(params.appId, params.appPath);
    return { success: true };
  });

  createTypedHandler(
    mcpServerContracts.syncSelectedComponents,
    async (_event, params) => {
      mcpServerManager.syncSelectedComponents(
        params.appId,
        params.selectedComponents,
      );
      return { success: true };
    },
  );

  createTypedHandler(mcpServerContracts.regenerateToken, async () => {
    const authToken = mcpServerManager.regenerateToken();
    return { authToken };
  });

  createTypedHandler(
    mcpServerContracts.screenshotResponse,
    async (_event, params) => {
      mcpServerManager.resolveScreenshotRequest(
        params.requestId,
        params.success,
        params.dataUrl,
        params.error,
      );
      return { success: true };
    },
  );

  createTypedHandler(
    mcpServerContracts.syncAnnotation,
    async (_event, params) => {
      mcpServerManager.syncAnnotation(params.appId, params.dataUrl);
      return { success: true };
    },
  );
}
