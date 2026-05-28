import { useCallback, useEffect, useState } from "react";
import { useSettings } from "@/hooks/useSettings";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ipc } from "@/ipc/types";
import { toast } from "sonner";
import { SETTING_IDS } from "@/lib/settingsSearchIndex";
import { Copy, Check, Circle, Eye, EyeOff, RefreshCw } from "lucide-react";

const DEFAULT_PORT = 31999;

export function McpServerSettings() {
  const { settings, updateSettings } = useSettings();
  const [serverRunning, setServerRunning] = useState(false);
  const [, setServerPort] = useState<number | null>(null);
  const [authToken, setAuthToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [tokenCopied, setTokenCopied] = useState(false);
  const [showToken, setShowToken] = useState(false);

  const refreshStatus = useCallback(async () => {
    try {
      const status = await ipc.mcpServer.status(undefined as never);
      setServerRunning(status.running);
      setServerPort(status.port);
      setAuthToken(status.authToken);
    } catch {
      setServerRunning(false);
      setServerPort(null);
      setAuthToken(null);
    }
  }, []);

  useEffect(() => {
    refreshStatus();
    const interval = setInterval(refreshStatus, 5000);
    return () => clearInterval(interval);
  }, [refreshStatus]);

  const handleToggleServer = async (checked: boolean) => {
    try {
      if (checked) {
        const port = settings?.mcpServerPort ?? DEFAULT_PORT;
        await ipc.mcpServer.start({ port });
        await updateSettings({ enableMcpServer: true });
        toast.success(`MCP server started on port ${port}`);
      } else {
        await ipc.mcpServer.stop(undefined as never);
        await updateSettings({ enableMcpServer: false });
        toast.success("MCP server stopped");
      }
      await refreshStatus();
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : "Unknown error";
      toast.error(`Failed to ${checked ? "start" : "stop"} MCP server`, {
        description: message,
      });
    }
  };

  const handlePortChange = async (value: string) => {
    const port = parseInt(value, 10);
    if (isNaN(port) || port < 1024 || port > 65535) return;
    await updateSettings({ mcpServerPort: port });
    if (serverRunning) {
      toast("Port changed", {
        description: "Restart the MCP server for the new port to take effect.",
      });
    }
  };

  const handleCopyConnectionString = () => {
    const port = settings?.mcpServerPort ?? DEFAULT_PORT;
    navigator.clipboard.writeText(`http://localhost:${port}/mcp`);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleCopyToken = () => {
    if (!authToken) return;
    navigator.clipboard.writeText(authToken);
    setTokenCopied(true);
    setTimeout(() => setTokenCopied(false), 2000);
    toast.success("Auth token copied to clipboard");
  };

  const handleRegenerateToken = async () => {
    try {
      const result = await ipc.mcpServer.regenerateToken(undefined as never);
      setAuthToken(result.authToken);
      toast.success("Auth token regenerated", {
        description: "Update external MCP client configs with the new token.",
      });
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : "Unknown error";
      toast.error("Failed to regenerate token", { description: message });
    }
  };

  if (!settings) return null;

  const port = settings.mcpServerPort ?? DEFAULT_PORT;

  return (
    <div className="space-y-4">
      {/* Enable/Disable Toggle */}
      <div id={SETTING_IDS.mcpServerEnable} className="flex items-center space-x-2">
        <Switch
          id="enable-mcp-server"
          aria-label="Enable MCP Server"
          checked={serverRunning}
          onCheckedChange={handleToggleServer}
        />
        <Label htmlFor="enable-mcp-server">Enable MCP Server</Label>
        <span className="flex items-center gap-1 text-xs">
          <Circle
            className={`h-2 w-2 fill-current ${serverRunning ? "text-green-500" : "text-gray-400"}`}
          />
          {serverRunning ? "Running" : "Stopped"}
        </span>
      </div>
      <p className="text-sm text-gray-500 dark:text-gray-400">
        Expose Dyad tools to external MCP clients (Antigravity, Claude Desktop,
        Cursor, etc.)
      </p>

      {/* Port */}
      <div id={SETTING_IDS.mcpServerPort} className="flex items-center gap-4">
        <Label htmlFor="mcp-server-port" className="text-sm font-medium">
          Port
        </Label>
        <Input
          id="mcp-server-port"
          type="number"
          className="w-28"
          min={1024}
          max={65535}
          value={port}
          onChange={(e) => handlePortChange(e.target.value)}
        />
      </div>

      {/* Connection String */}
      <div className="flex items-center gap-2">
        <code className="rounded bg-gray-100 px-2 py-1 text-xs dark:bg-gray-800">
          http://localhost:{port}/mcp
        </code>
        <Button
          variant="ghost"
          size="sm"
          onClick={handleCopyConnectionString}
          aria-label="Copy connection string"
        >
          {copied ? (
            <Check className="h-4 w-4 text-green-500" />
          ) : (
            <Copy className="h-4 w-4" />
          )}
        </Button>
      </div>

      {/* Auth Token */}
      {serverRunning && authToken && (
        <div className="space-y-1">
          <Label className="text-sm font-medium">Auth Token</Label>
          <div className="flex items-center gap-2">
            <code className="flex-1 rounded bg-gray-100 px-2 py-1 font-mono text-xs dark:bg-gray-800 select-all break-all">
              {showToken ? authToken : "••••••••••••••••••••••••••••••••"}
            </code>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowToken(!showToken)}
              aria-label={showToken ? "Hide token" : "Show token"}
            >
              {showToken ? (
                <EyeOff className="h-4 w-4" />
              ) : (
                <Eye className="h-4 w-4" />
              )}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleCopyToken}
              aria-label="Copy auth token"
            >
              {tokenCopied ? (
                <Check className="h-4 w-4 text-green-500" />
              ) : (
                <Copy className="h-4 w-4" />
              )}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleRegenerateToken}
              aria-label="Regenerate auth token"
            >
              <RefreshCw className="h-4 w-4" />
            </Button>
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Use this token in external MCP client configs as{" "}
            <code className="rounded bg-gray-100 px-1 dark:bg-gray-800">
              Authorization: Bearer &lt;token&gt;
            </code>
          </p>
        </div>
      )}

      {/* Write Tools Toggle */}
      <div
        id={SETTING_IDS.mcpServerWriteTools}
        className="flex items-center space-x-2"
      >
        <Switch
          id="mcp-server-write-tools"
          aria-label="Allow write operations"
          checked={settings.mcpServerEnableWriteTools ?? false}
          onCheckedChange={(checked) => {
            updateSettings({ mcpServerEnableWriteTools: checked });
          }}
        />
        <Label htmlFor="mcp-server-write-tools">
          Allow write operations
        </Label>
      </div>
      <p className="text-sm text-gray-500 dark:text-gray-400">
        When enabled, external MCP clients can write files, edit code, and
        modify dependencies in the active project.
      </p>
    </div>
  );
}
