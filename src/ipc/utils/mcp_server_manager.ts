/**
 * MCP Server Manager — Singleton
 *
 * Makes Dyad act as an MCP server, exposing its tools and resources
 * to external MCP clients (Antigravity, Claude Desktop, Cursor, etc.)
 * over HTTP on a configurable port (default: 31999).
 *
 * This is the inverse of mcp_manager.ts (which is the MCP CLIENT).
 */

import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import http from "node:http";
import { db } from "@/db";
import { apps } from "@/db/schema";
import { TOOL_DEFINITIONS } from "@/pro/main/ipc/handlers/local_agent/tool_definitions";
import type { ToolDefinition } from "@/pro/main/ipc/handlers/local_agent/tools/types";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { BrowserWindow } from "electron";
import { eq } from "drizzle-orm";
import log from "electron-log";
import { z } from "zod";
import * as z3 from "zod/v3";
import type { ComponentSelection } from "../types/chat";
import {
  type McpAuditEntry,
  logToolCall,
  summarizeArgs,
} from "./mcp_audit_logger";
import { createMcpAgentContext } from "./mcp_agent_context";
import { McpRateLimiter } from "./mcp_rate_limiter";
import { safeJoin } from "./path_utils";

const DEFAULT_PORT = 31999;

export interface McpServerConfig {
  port?: number;
  enableWriteTools?: boolean;
  enableNetworkTools?: boolean;
}

const TIER_1_TOOLS = new Set([
  "read_file",
  "list_files",
  "grep",
  "code_search",
  "read_logs",
  "get_supabase_project_info",
  "get_supabase_table_schema",
]);

const TIER_2_TOOLS = new Set([
  "write_file",
  "edit_file",
  "search_replace",
  "copy_file",
  "delete_file",
  "rename_file",
  "add_dependency",
  "execute_sql",
]);

const TIER_3_TOOLS = new Set([
  "web_search",
  "web_crawl",
  "web_fetch",
  "generate_image",
  "run_type_checks",
]);

const TIER_4_NEVER_EXPOSE = new Set([
  "set_chat_summary",
  "update_todos",
  "add_integration",
  "planning_questionnaire",
  "write_plan",
  "exit_plan",
]);

/**
 * In Zod v4, .refine() returns a ZodObject (not ZodEffects), so .shape is
 * always directly accessible. This helper safely extracts it with a fallback.
 */
function extractZodRawShape(schema: z.ZodType<unknown>): z.ZodRawShape | null {
  if (schema instanceof z.ZodObject) {
    return schema.shape as z.ZodRawShape;
  }
  return null;
}

/**
 * Convert a Zod 4 type → Zod 3 (compat) equivalent.
 * Needed because MCP SDK v1.18.x bundles Zod 3 and calls `._parse()` on shapes,
 * which Zod 4 types lack. The `zod/v3` compat layer provides `._parse()`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function convertZ4TypeToZ3(z4Type: any): z3.ZodTypeAny {
  const description =
    typeof z4Type.description === "string" ? z4Type.description : undefined;

  if (z4Type instanceof z.ZodOptional) {
    const inner = convertZ4TypeToZ3(z4Type.unwrap());
    const result = inner.optional();
    return description ? result.describe(description) : result;
  }

  if (z4Type instanceof z.ZodNullable) {
    const inner = convertZ4TypeToZ3(z4Type.unwrap());
    const result = inner.nullable();
    return description ? result.describe(description) : result;
  }

  if (z4Type instanceof z.ZodString) {
    const result = z3.string();
    return description ? result.describe(description) : result;
  }

  if (z4Type instanceof z.ZodNumber) {
    const hasIntCheck =
      z4Type._zod?.def?.checks?.some(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (c: any) => c.isInt === true,
      ) ?? false;
    const result = hasIntCheck ? z3.number().int() : z3.number();
    return description ? result.describe(description) : result;
  }

  if (z4Type instanceof z.ZodBoolean) {
    const result = z3.boolean();
    return description ? result.describe(description) : result;
  }

  if (z4Type instanceof z.ZodArray) {
    const elementZ3 = convertZ4TypeToZ3(z4Type.element);
    const result = z3.array(elementZ3);
    return description ? result.describe(description) : result;
  }

  log.warn(
    `MCP: convertZ4TypeToZ3 — unsupported type "${z4Type.constructor.name}", using z3.any()`,
  );
  return z3.any();
}

function convertZ4ShapeToZ3(shape: z.ZodRawShape): z3.ZodRawShape {
  const z3Shape: z3.ZodRawShape = {};
  for (const [key, z4Type] of Object.entries(shape)) {
    z3Shape[key] = convertZ4TypeToZ3(z4Type as z.ZodType);
  }
  return z3Shape;
}

export class McpServerManager {
  private static _instance: McpServerManager | null = null;

  private mcpServer: McpServer | null = null;
  private httpServer: http.Server | null = null;
  private port: number | null = null;
  private activeAppId: number | null = null;
  private activeAppPath: string | null = null;
  private selectedComponentsByAppId = new Map<number, ComponentSelection[]>();
  private config: McpServerConfig = {};
  private rateLimiter: McpRateLimiter | null = null;
  private authToken: string | null = null;
  private pendingScreenshots = new Map<
    string,
    {
      resolve: (dataUrl: string) => void;
      reject: (error: Error) => void;
    }
  >();
  private latestAnnotationByAppId = new Map<number, string>();

  private constructor() {}

  static get instance(): McpServerManager {
    if (!McpServerManager._instance) {
      McpServerManager._instance = new McpServerManager();
    }
    return McpServerManager._instance;
  }

  isRunning(): boolean {
    return this.httpServer?.listening === true;
  }

  getPort(): number | null {
    return this.port;
  }

  getActiveAppId(): number | null {
    return this.activeAppId;
  }

  getActiveAppPath(): string | null {
    return this.activeAppPath;
  }

  getAuthToken(): string | null {
    return this.authToken;
  }

  regenerateToken(): string {
    this.authToken = crypto.randomBytes(32).toString("hex");
    return this.authToken;
  }

  setActiveApp(appId: number, appPath: string): void {
    this.activeAppId = appId;
    this.activeAppPath = appPath;
    log.info(`Active app set to ${appId} at ${appPath}`);
  }

  syncSelectedComponents(
    appId: number,
    selectedComponents: ComponentSelection[],
  ): void {
    this.selectedComponentsByAppId.set(appId, selectedComponents);
  }

  syncAnnotation(appId: number, dataUrl: string): void {
    this.latestAnnotationByAppId.set(appId, dataUrl);
  }

  resolveScreenshotRequest(
    requestId: string,
    success: boolean,
    dataUrl?: string,
    error?: string,
  ): void {
    const pending = this.pendingScreenshots.get(requestId);
    if (!pending) return;
    this.pendingScreenshots.delete(requestId);

    if (success && dataUrl) {
      pending.resolve(dataUrl);
    } else {
      pending.reject(new Error(error ?? "Screenshot capture failed"));
    }
  }

  /**
   * Request a screenshot from the renderer's preview iframe.
   * Sends an event to the renderer, waits for the response via IPC callback.
   * Times out after 10 seconds.
   */
  async requestScreenshot(): Promise<string> {
    const windows = BrowserWindow.getAllWindows();
    if (windows.length === 0) {
      throw new Error("No Dyad window available for screenshot capture");
    }

    const requestId = `screenshot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const promise = new Promise<string>((resolve, reject) => {
      this.pendingScreenshots.set(requestId, { resolve, reject });

      setTimeout(() => {
        if (this.pendingScreenshots.has(requestId)) {
          this.pendingScreenshots.delete(requestId);
          reject(new Error("Screenshot request timed out (10s)"));
        }
      }, 10_000);
    });

    windows[0].webContents.send("mcp-server:request-screenshot", {
      requestId,
    });

    return promise;
  }

  async start(
    portOrConfig: number | McpServerConfig = DEFAULT_PORT,
  ): Promise<void> {
    if (typeof portOrConfig === "number") {
      this.config = { port: portOrConfig };
    } else {
      this.config = portOrConfig;
    }
    const port = this.config.port ?? DEFAULT_PORT;
    this.authToken = crypto.randomBytes(32).toString("hex");

    if (this.isRunning()) {
      log.info("MCP server already running, stopping first");
      await this.stop();
    }

    this.rateLimiter = new McpRateLimiter();

    this.mcpServer = new McpServer(
      {
        name: "dyad",
        version: "1.0.0",
      },
      {
        capabilities: {
          tools: {},
          resources: {},
        },
      },
    );

    this.registerProjectResource();
    this.registerProjectsResource();
    this.registerGetSelectedComponentsTool();
    this.registerSetActiveProjectTool();
    this.registerTakePreviewScreenshotTool();
    this.registerGetLatestAnnotationTool();
    this.registerDyadTools();
    this.httpServer = http.createServer(
      async (req: http.IncomingMessage, res: http.ServerResponse) => {
        if (req.method === "OPTIONS") {
          res.writeHead(204, {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization",
          });
          res.end();
          return;
        }

        if (req.url !== "/mcp") {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("Not found");
          return;
        }

        // Rate limiting
        const clientIp = req.socket.remoteAddress ?? "unknown";
        if (this.rateLimiter && !this.rateLimiter.isAllowed(clientIp)) {
          const retryAfter = this.rateLimiter.getRetryAfterSeconds(clientIp);
          res.writeHead(429, {
            "Content-Type": "text/plain",
            "Retry-After": String(retryAfter),
          });
          res.end("Too Many Requests");
          log.warn(
            `MCP rate limit exceeded for ${clientIp}, retry after ${retryAfter}s`,
          );
          return;
        }

        try {
          const body = await collectRequestBody(req);
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
          });

          res.setHeader("Access-Control-Allow-Origin", "*");

          await this.mcpServer!.connect(transport);
          await transport.handleRequest(req, res, body);
        } catch (error: unknown) {
          const message =
            error instanceof Error ? error.message : String(error);
          log.error(`MCP request error: ${message}`);
          if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "text/plain" });
            res.end("Internal server error");
          }
        }
      },
    );

    return new Promise<void>((resolve, reject) => {
      this.httpServer!.on("error", (err: Error) => {
        log.error(`MCP server failed to start: ${err.message}`);
        this.httpServer = null;
        this.mcpServer = null;
        reject(err);
      });

      this.httpServer!.listen(port, "127.0.0.1", () => {
        this.port = port;
        log.info(`MCP server listening on http://127.0.0.1:${port}/mcp`);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (this.httpServer) {
      await new Promise<void>((resolve, reject) => {
        this.httpServer!.close((err) => {
          if (err) {
            log.error(`Error closing MCP server: ${err.message}`);
            reject(err);
          } else {
            resolve();
          }
        });
      });
      this.httpServer = null;
    }

    if (this.mcpServer) {
      try {
        await this.mcpServer.close();
      } catch {
        // Server may already be disconnected
      }
      this.mcpServer = null;
    }

    this.port = null;
    if (this.rateLimiter) {
      this.rateLimiter.dispose();
      this.rateLimiter = null;
    }
    this.authToken = null;
    log.info("MCP server stopped");
  }

  private registerProjectResource(): void {
    if (!this.mcpServer) return;

    this.mcpServer.resource(
      "project-info",
      "dyad://project/info",
      {
        description: "Current active Dyad project information",
        mimeType: "application/json",
      },
      async () => ({
        contents: [
          {
            uri: "dyad://project/info",
            mimeType: "application/json",
            text: JSON.stringify({
              appId: this.activeAppId,
              appPath: this.activeAppPath,
            }),
          },
        ],
      }),
    );
  }

  private registerProjectsResource(): void {
    if (!this.mcpServer) return;

    this.mcpServer.resource(
      "projects",
      "dyad://projects",
      {
        description: "List of all Dyad projects",
        mimeType: "application/json",
      },
      async () => {
        const allApps = await db
          .select({
            id: apps.id,
            name: apps.name,
            path: apps.path,
          })
          .from(apps);

        return {
          contents: [
            {
              uri: "dyad://projects",
              mimeType: "application/json",
              text: JSON.stringify(allApps),
            },
          ],
        };
      },
    );
  }

  private registerSetActiveProjectTool(): void {
    if (!this.mcpServer) return;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this.mcpServer.tool as any)(
      "set_active_project",
      "Set the active Dyad project by app ID. Use dyad://projects resource to find available IDs.",
      convertZ4ShapeToZ3({
        appId: z.number().int().describe("Dyad app ID to set as active"),
      }),
      async ({ appId }: { appId: number }) => {
        const [app] = await db
          .select({ id: apps.id, name: apps.name, path: apps.path })
          .from(apps)
          .where(eq(apps.id, appId));

        if (!app) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Error: No project found with appId ${appId}`,
              },
            ],
            isError: true,
          };
        }

        this.setActiveApp(app.id, app.path);

        return {
          content: [
            {
              type: "text" as const,
              text: `Active project set to "${app.name}" (id: ${app.id}, path: ${app.path})`,
            },
          ],
        };
      },
    );
  }

  private isToolAllowed(toolName: string): boolean {
    if (TIER_4_NEVER_EXPOSE.has(toolName)) return false;
    if (TIER_1_TOOLS.has(toolName)) return true;
    if (TIER_2_TOOLS.has(toolName))
      return this.config.enableWriteTools === true;
    if (TIER_3_TOOLS.has(toolName))
      return this.config.enableNetworkTools === true;
    return false;
  }

  private registerDyadTools(): void {
    if (!this.mcpServer) return;

    for (const tool of TOOL_DEFINITIONS) {
      if (!this.isToolAllowed(tool.name)) continue;

      const shape = extractZodRawShape(tool.inputSchema as z.ZodType<unknown>);
      if (!shape) {
        log.warn(
          `MCP: Skipping tool "${tool.name}" — unable to extract parameter schema`,
        );
        continue;
      }

      this.registerSingleTool(tool, shape);
    }

    log.info(
      `MCP: Registered ${this.countRegisteredTools()} Dyad tools (writeTools=${String(this.config.enableWriteTools ?? false)}, networkTools=${String(this.config.enableNetworkTools ?? false)})`,
    );
  }

  private registerSingleTool(tool: ToolDefinition, shape: z.ZodRawShape): void {
    const z3Shape = convertZ4ShapeToZ3(shape);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this.mcpServer!.tool as any)(
      tool.name,
      tool.description,
      z3Shape,
      async (args: Record<string, unknown>) => {
        const startTime = Date.now();
        const argsSummary = summarizeArgs(args);

        if (this.activeAppId == null || this.activeAppPath == null) {
          const entry: McpAuditEntry = {
            timestamp: new Date(startTime).toISOString(),
            toolName: tool.name,
            argsSummary,
            status: "error",
            durationMs: Date.now() - startTime,
            clientIp: "unknown",
            errorMessage: "No active Dyad project",
          };
          logToolCall(entry);

          return {
            content: [
              {
                type: "text" as const,
                text: "Error: No active Dyad project. Call set_active_project first or set via the Dyad UI.",
              },
            ],
            isError: true,
          };
        }

        const ctx = createMcpAgentContext({
          appId: this.activeAppId,
          appPath: this.activeAppPath,
        });

        try {
          const result = await tool.execute(args, ctx);

          logToolCall({
            timestamp: new Date(startTime).toISOString(),
            toolName: tool.name,
            argsSummary,
            status: "success",
            durationMs: Date.now() - startTime,
            clientIp: "mcp-client",
          });

          return {
            content: [{ type: "text" as const, text: result }],
          };
        } catch (error: unknown) {
          const message =
            error instanceof Error ? error.message : String(error);

          logToolCall({
            timestamp: new Date(startTime).toISOString(),
            toolName: tool.name,
            argsSummary,
            status: "error",
            durationMs: Date.now() - startTime,
            clientIp: "mcp-client",
            errorMessage: message,
          });

          return {
            content: [
              {
                type: "text" as const,
                text: `Error executing ${tool.name}: ${message}`,
              },
            ],
            isError: true,
          };
        }
      },
    );
  }

  private countRegisteredTools(): number {
    return TOOL_DEFINITIONS.filter((t) => this.isToolAllowed(t.name)).length;
  }

  private registerGetSelectedComponentsTool(): void {
    if (!this.mcpServer) {
      return;
    }

    this.mcpServer.registerTool(
      "get_selected_components",
      {
        description:
          "Get components currently selected in Dyad preview with file location and source context.",
      },
      async () => {
        if (!this.activeAppId || !this.activeAppPath) {
          return {
            content: [
              {
                type: "text" as const,
                text: "Error: No active Dyad project. Set active app first.",
              },
            ],
            isError: true,
          };
        }

        const selectedComponents =
          this.selectedComponentsByAppId.get(this.activeAppId) ?? [];
        const activeAppPath = this.activeAppPath;

        if (selectedComponents.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: "No components currently selected in Dyad preview.",
              },
            ],
          };
        }

        const renderedComponents = await Promise.all(
          selectedComponents.map(async (component) => {
            let fullFilePath: string;
            try {
              fullFilePath = safeJoin(activeAppPath, component.relativePath);
            } catch (error: unknown) {
              const message =
                error instanceof Error ? error.message : String(error);
              return [
                `Component: ${component.name}`,
                `File: ${component.relativePath}:${component.lineNumber}:${component.columnNumber}`,
                "",
                `Unable to resolve source context path: ${message}`,
              ].join("\n");
            }

            try {
              const raw = await fs.readFile(fullFilePath, "utf-8");
              const lines = raw.split("\n");
              const startLine = Math.max(1, component.lineNumber - 2);
              const endLine = Math.min(lines.length, component.lineNumber + 2);
              const snippet = lines
                .slice(startLine - 1, endLine)
                .map((line, index) => {
                  const lineNumber = startLine + index;
                  const editMarker =
                    lineNumber === component.lineNumber
                      ? " // <-- EDIT HERE"
                      : "";
                  return `${lineNumber}: ${line}${editMarker}`;
                })
                .join("\n");

              return [
                `Component: ${component.name}`,
                `File: ${component.relativePath}:${component.lineNumber}:${component.columnNumber}`,
                "",
                snippet,
              ].join("\n");
            } catch (error: unknown) {
              const message =
                error instanceof Error ? error.message : String(error);
              return [
                `Component: ${component.name}`,
                `File: ${component.relativePath}:${component.lineNumber}:${component.columnNumber}`,
                "",
                `Unable to read source context: ${message}`,
              ].join("\n");
            }
          }),
        );

        return {
          content: [
            {
              type: "text" as const,
              text: renderedComponents.join("\n\n---\n\n"),
            },
          ],
        };
      },
    );
  }

  private registerTakePreviewScreenshotTool(): void {
    if (!this.mcpServer) return;

    this.mcpServer.registerTool(
      "take_preview_screenshot",
      {
        description:
          "Take a screenshot of the Dyad live preview. Returns a PNG image of the current preview state.",
      },
      async () => {
        try {
          const dataUrl = await this.requestScreenshot();
          // dataUrl is "data:image/png;base64,<base64data>"
          const base64Match = dataUrl.match(/^data:image\/png;base64,(.+)$/);
          if (!base64Match) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: "Error: Screenshot returned invalid data URL format",
                },
              ],
              isError: true,
            };
          }

          return {
            content: [
              {
                type: "image" as const,
                data: base64Match[1],
                mimeType: "image/png",
              },
            ],
          };
        } catch (error: unknown) {
          const message =
            error instanceof Error ? error.message : String(error);
          log.error(`MCP take_preview_screenshot failed: ${message}`);
          return {
            content: [
              {
                type: "text" as const,
                text: `Error: ${message}`,
              },
            ],
            isError: true,
          };
        }
      },
    );
  }

  private registerGetLatestAnnotationTool(): void {
    if (!this.mcpServer) return;

    this.mcpServer.registerTool(
      "get_latest_annotation",
      {
        description:
          "Get the latest annotated screenshot from Dyad. Returns the most recent image that was annotated by the user in the Dyad Annotator tool.",
      },
      async () => {
        if (!this.activeAppId) {
          return {
            content: [
              {
                type: "text" as const,
                text: "Error: No active Dyad project. Set active app first.",
              },
            ],
            isError: true,
          };
        }

        const dataUrl = this.latestAnnotationByAppId.get(this.activeAppId);
        if (!dataUrl) {
          return {
            content: [
              {
                type: "text" as const,
                text: "No annotations available. Use the Dyad Annotator to draw on a screenshot first.",
              },
            ],
          };
        }

        const base64Match = dataUrl.match(/^data:image\/png;base64,(.+)$/);
        if (!base64Match) {
          return {
            content: [
              {
                type: "text" as const,
                text: "Error: Annotation data is in an invalid format",
              },
            ],
            isError: true,
          };
        }

        return {
          content: [
            {
              type: "image" as const,
              data: base64Match[1],
              mimeType: "image/png",
            },
          ],
        };
      },
    );
  }
}

/**
 * Collect the full request body from an IncomingMessage stream.
 * Returns the parsed JSON body, or undefined for empty bodies.
 */
async function collectRequestBody(
  req: http.IncomingMessage,
): Promise<Record<string, unknown> | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8");
      if (!raw.trim()) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(raw) as Record<string, unknown>);
      } catch {
        reject(new Error("Invalid JSON in request body"));
      }
    });
    req.on("error", reject);
  });
}

export const mcpServerManager = McpServerManager.instance;
