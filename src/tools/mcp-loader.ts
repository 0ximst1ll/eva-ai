// MCP tool loader — mirrors mini_agent/tools/mcp_loader.py

import * as fs from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Tool, ToolResult } from './base.js';

export type ConnectionType = 'stdio' | 'sse' | 'http' | 'streamable_http';

export interface MCPTimeoutConfig {
  connectTimeout: number;
  executeTimeout: number;
  sseReadTimeout: number;
}

// Module-level default config (mirrors Python's _default_timeout_config)
const _defaultTimeoutConfig: MCPTimeoutConfig = {
  connectTimeout: 10.0,
  executeTimeout: 60.0,
  sseReadTimeout: 120.0,
};

export function setMcpTimeoutConfig(overrides: Partial<MCPTimeoutConfig>): void {
  Object.assign(_defaultTimeoutConfig, overrides);
}

export function getMcpTimeoutConfig(): MCPTimeoutConfig {
  return { ..._defaultTimeoutConfig };
}

// ============ MCPTool ============

interface MCPToolInput extends Record<string, unknown> {}

export class MCPTool implements Tool<MCPToolInput> {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  private readonly client: Client;
  private readonly executeTimeout: number;

  constructor(
    name: string,
    description: string,
    parameters: Record<string, unknown>,
    client: Client,
    executeTimeout?: number,
  ) {
    this.name = name;
    this.description = description;
    this.parameters = parameters;
    this.client = client;
    this.executeTimeout = executeTimeout ?? _defaultTimeoutConfig.executeTimeout;
  }

  async execute(args: MCPToolInput): Promise<ToolResult> {
    const timeout = this.executeTimeout * 1000;

    try {
      const result = await Promise.race([
        this.client.callTool({ name: this.name, arguments: args }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`MCP tool execution timed out after ${this.executeTimeout}s`)), timeout),
        ),
      ]);

      const parts: string[] = [];
      if (result.content && Array.isArray(result.content)) {
        for (const item of result.content as Array<{ type: string; text?: string }>) {
          parts.push(item.text ?? String(item));
        }
      }

      const isError = result.isError === true;
      return {
        success: !isError,
        content: parts.join('\n'),
        error: isError ? 'Tool returned error' : undefined,
      };
    } catch (err) {
      return {
        success: false,
        content: '',
        error: `MCP tool execution failed: ${String(err)}`,
      };
    }
  }
}

// ============ MCPServerConnection ============

interface ServerConfig {
  type?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  disabled?: boolean;
  connect_timeout?: number;
  execute_timeout?: number;
  sse_read_timeout?: number;
}

interface MCPServersConfig {
  mcpServers?: Record<string, ServerConfig>;
}

export class MCPServerConnection {
  readonly name: string;
  private readonly connectionType: ConnectionType;
  private readonly command?: string;
  private readonly args: string[];
  private readonly env: Record<string, string>;
  private readonly url?: string;
  private readonly connectTimeoutOverride?: number;
  private readonly executeTimeoutOverride?: number;
  private client: Client | null = null;
  readonly tools: MCPTool[] = [];

  constructor(
    name: string,
    connectionType: ConnectionType,
    options: {
      command?: string;
      args?: string[];
      env?: Record<string, string>;
      url?: string;
      headers?: Record<string, string>;
      connectTimeout?: number;
      executeTimeout?: number;
    } = {},
  ) {
    this.name = name;
    this.connectionType = connectionType;
    this.command = options.command;
    this.args = options.args ?? [];
    this.env = options.env ?? {};
    this.url = options.url;
    this.connectTimeoutOverride = options.connectTimeout;
    this.executeTimeoutOverride = options.executeTimeout;
  }

  private get connectTimeout(): number {
    return this.connectTimeoutOverride ?? _defaultTimeoutConfig.connectTimeout;
  }

  private get executeTimeout(): number {
    return this.executeTimeoutOverride ?? _defaultTimeoutConfig.executeTimeout;
  }

  async connect(): Promise<boolean> {
    try {
      this.client = new Client({ name: `mini-agent-${this.name}`, version: '0.1.0' });

      let transport;
      if (this.connectionType === 'stdio') {
        if (!this.command) throw new Error('No command specified for stdio connection');
        transport = new StdioClientTransport({
          command: this.command,
          args: this.args,
          env: Object.keys(this.env).length ? this.env : undefined,
        });
      } else if (this.connectionType === 'sse') {
        if (!this.url) throw new Error('No url specified for SSE connection');
        transport = new SSEClientTransport(new URL(this.url));
      } else {
        if (!this.url) throw new Error('No url specified for HTTP connection');
        transport = new StreamableHTTPClientTransport(new URL(this.url));
      }

      await Promise.race([
        this.client.connect(transport),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Connection timed out after ${this.connectTimeout}s`)), this.connectTimeout * 1000),
        ),
      ]);

      const toolsResult = await this.client.listTools();
      const connInfo = this.url ?? this.command;

      for (const tool of toolsResult.tools) {
        this.tools.push(
          new MCPTool(
            tool.name,
            tool.description ?? '',
            (tool.inputSchema as Record<string, unknown>) ?? {},
            this.client,
            this.executeTimeout,
          ),
        );
      }

      console.log(
        `✓ Connected to MCP server '${this.name}' (${this.connectionType}: ${connInfo}) - loaded ${this.tools.length} tools`,
      );
      for (const t of this.tools) {
        const desc = t.description.length > 60 ? t.description.slice(0, 60) : t.description;
        console.log(`  - ${t.name}: ${desc}...`);
      }
      return true;
    } catch (err) {
      console.log(`✗ Failed to connect to MCP server '${this.name}': ${err}`);
      return false;
    }
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      try {
        await this.client.close();
      } catch {
        // Ignore errors during cleanup
      } finally {
        this.client = null;
      }
    }
  }
}

// Module-level connections registry
const _mcpConnections: MCPServerConnection[] = [];

function determineConnectionType(config: ServerConfig): ConnectionType {
  const explicit = (config.type ?? '').toLowerCase();
  if (['stdio', 'sse', 'http', 'streamable_http'].includes(explicit)) {
    return explicit as ConnectionType;
  }
  return config.url ? 'streamable_http' : 'stdio';
}

function resolveMcpConfigPath(configPath: string): string | null {
  if (fs.existsSync(configPath)) return configPath;

  if (configPath.endsWith('mcp.json')) {
    const examplePath = configPath.replace('mcp.json', 'mcp-example.json');
    if (fs.existsSync(examplePath)) {
      console.log(`mcp.json not found, using template: ${examplePath}`);
      return examplePath;
    }
  }

  return null;
}

export async function loadMcpToolsAsync(configPath: string = 'mcp.json'): Promise<Tool[]> {
  const resolved = resolveMcpConfigPath(configPath);
  if (!resolved) {
    console.log(`MCP config not found: ${configPath}`);
    return [];
  }

  try {
    const config = JSON.parse(fs.readFileSync(resolved, 'utf-8')) as MCPServersConfig;
    const mcpServers = config.mcpServers ?? {};

    if (!Object.keys(mcpServers).length) {
      console.log('No MCP servers configured');
      return [];
    }

    const allTools: Tool[] = [];

    for (const [serverName, serverConfig] of Object.entries(mcpServers)) {
      if (serverConfig.disabled) {
        console.log(`Skipping disabled server: ${serverName}`);
        continue;
      }

      const connType = determineConnectionType(serverConfig);

      if (connType === 'stdio' && !serverConfig.command) {
        console.log(`No command specified for STDIO server: ${serverName}`);
        continue;
      }
      if (connType !== 'stdio' && !serverConfig.url) {
        console.log(`No url specified for ${connType.toUpperCase()} server: ${serverName}`);
        continue;
      }

      const connection = new MCPServerConnection(serverName, connType, {
        command: serverConfig.command,
        args: serverConfig.args,
        env: serverConfig.env,
        url: serverConfig.url,
        headers: serverConfig.headers,
        connectTimeout: serverConfig.connect_timeout,
        executeTimeout: serverConfig.execute_timeout,
      });

      const success = await connection.connect();
      if (success) {
        _mcpConnections.push(connection);
        allTools.push(...connection.tools);
      }
    }

    console.log(`\nTotal MCP tools loaded: ${allTools.length}`);
    return allTools;
  } catch (err) {
    console.log(`Error loading MCP config: ${err}`);
    return [];
  }
}

export async function cleanupMcpConnections(): Promise<void> {
  for (const conn of _mcpConnections) {
    await conn.disconnect();
  }
  _mcpConnections.length = 0;
}
