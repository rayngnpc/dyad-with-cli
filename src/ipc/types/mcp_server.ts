import { z } from "zod";
import {
  createClient,
  createEventClient,
  defineContract,
  defineEvent,
} from "../contracts/core";
import { ComponentSelectionSchema } from "./chat";

// =============================================================================
// MCP Server Schemas
// =============================================================================

export const McpServerStatusSchema = z.object({
  running: z.boolean(),
  port: z.number().nullable(),
  activeAppId: z.number().nullable(),
  authToken: z.string().nullable(),
});

export type McpServerStatus = z.infer<typeof McpServerStatusSchema>;

export const McpServerStartParamsSchema = z.object({
  port: z.number().int().min(1024).max(65535).optional(),
});

export type McpServerStartParams = z.infer<typeof McpServerStartParamsSchema>;

export const McpServerStartResultSchema = z.object({
  success: z.boolean(),
  port: z.number(),
});

export type McpServerStartResult = z.infer<typeof McpServerStartResultSchema>;

export const McpServerSetActiveAppParamsSchema = z.object({
  appId: z.number(),
  appPath: z.string(),
});

export type McpServerSetActiveAppParams = z.infer<
  typeof McpServerSetActiveAppParamsSchema
>;

export const McpServerSyncSelectedComponentsParamsSchema = z.object({
  appId: z.number(),
  selectedComponents: z.array(ComponentSelectionSchema),
});

export type McpServerSyncSelectedComponentsParams = z.infer<
  typeof McpServerSyncSelectedComponentsParamsSchema
>;

export const McpServerSuccessResultSchema = z.object({
  success: z.boolean(),
});

export const McpServerRegenerateTokenResultSchema = z.object({
  authToken: z.string(),
});

export const McpServerScreenshotResponseParamsSchema = z.object({
  requestId: z.string(),
  success: z.boolean(),
  dataUrl: z.string().optional(),
  error: z.string().optional(),
});

export type McpServerScreenshotResponseParams = z.infer<
  typeof McpServerScreenshotResponseParamsSchema
>;

export const McpServerSyncAnnotationParamsSchema = z.object({
  appId: z.number(),
  dataUrl: z.string(),
});

export type McpServerSyncAnnotationParams = z.infer<
  typeof McpServerSyncAnnotationParamsSchema
>;

// =============================================================================
// MCP Server Contracts
// =============================================================================

export const mcpServerContracts = {
  start: defineContract({
    channel: "mcp-server:start",
    input: McpServerStartParamsSchema,
    output: McpServerStartResultSchema,
  }),

  stop: defineContract({
    channel: "mcp-server:stop",
    input: z.void(),
    output: McpServerSuccessResultSchema,
  }),

  status: defineContract({
    channel: "mcp-server:status",
    input: z.void(),
    output: McpServerStatusSchema,
  }),

  setActiveApp: defineContract({
    channel: "mcp-server:set-active-app",
    input: McpServerSetActiveAppParamsSchema,
    output: McpServerSuccessResultSchema,
  }),

  syncSelectedComponents: defineContract({
    channel: "mcp-server:sync-selected-components",
    input: McpServerSyncSelectedComponentsParamsSchema,
    output: McpServerSuccessResultSchema,
  }),

  regenerateToken: defineContract({
    channel: "mcp-server:regenerate-token",
    input: z.void(),
    output: McpServerRegenerateTokenResultSchema,
  }),

  screenshotResponse: defineContract({
    channel: "mcp-server:screenshot-response",
    input: McpServerScreenshotResponseParamsSchema,
    output: McpServerSuccessResultSchema,
  }),

  syncAnnotation: defineContract({
    channel: "mcp-server:sync-annotation",
    input: McpServerSyncAnnotationParamsSchema,
    output: McpServerSuccessResultSchema,
  }),
} as const;

// =============================================================================
// MCP Server Events (main → renderer)
// =============================================================================

export const mcpServerEvents = {
  requestScreenshot: defineEvent({
    channel: "mcp-server:request-screenshot",
    payload: z.object({
      requestId: z.string(),
    }),
  }),
} as const;

// =============================================================================
// MCP Server Client
// =============================================================================

export const mcpServerClient = createClient(mcpServerContracts);
export const mcpServerEventClient = createEventClient(mcpServerEvents);
