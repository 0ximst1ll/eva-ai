export type {
  JsonSchema,
  Tool,
  ToolCategory,
  ToolDefinition,
  ToolExecutionContext,
  ToolMetadata,
  ToolResult,
  ToolRiskLevel,
  ToolSource,
} from './base.js';
export { createToolDefinition, toAnthropicSchema, toOpenAISchema, toolFromDefinition, withToolMetadata } from './base.js';
export { BashKillTool, BashOutputTool, BashTool, type BashOutputResult } from './bash.js';
export { EditTool, type EditToolInput } from './edit.js';
export { fileMutationQueue, FileMutationQueue } from './file-mutation-queue.js';
export { FindTool, type FindToolInput } from './find.js';
export { GrepTool, type GrepToolInput } from './grep.js';
export { LsTool, type LsToolInput } from './ls.js';
export { resolveWorkspacePath } from './path-utils.js';
export { ReadTool, type ReadToolInput } from './read.js';
export { truncateMiddle, truncateTextByTokens, type TruncationResult } from './truncate.js';
export { WriteTool, type WriteToolInput } from './write.js';
export { createToolDefinitionFromTool, wrapToolDefinition } from './tool-definition-wrapper.js';

import type { ConfigData } from '../config.js';
import { BashKillTool, BashOutputTool, BashTool } from './bash.js';
import { EditTool } from './edit.js';
import { FindTool } from './find.js';
import { GrepTool } from './grep.js';
import { LsTool } from './ls.js';
import { ReadTool } from './read.js';
import { WriteTool } from './write.js';
import type { Tool, ToolDefinition, ToolMetadata } from './base.js';
import { createToolDefinition, toolFromDefinition, withToolMetadata } from './base.js';

type ToolDiagnosticType = 'info' | 'warning';

export interface ToolDiagnostic {
  type: ToolDiagnosticType;
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

interface ToolRegistryEntry {
  definition: ToolDefinition;
  tool: Tool;
  metadata: ToolMetadata;
}

export class ToolRegistry {
  private readonly entries = new Map<string, ToolRegistryEntry>();

  add(tool: Tool, metadata: ToolMetadata): ToolDiagnostic | null {
    return this.addDefinition(createToolDefinition(tool, metadata));
  }

  addDefinition(definition: ToolDefinition): ToolDiagnostic | null {
    if (this.entries.has(definition.name)) {
      return {
        type: 'warning',
        code: 'tool_duplicate_skipped',
        message: `Skipped duplicate tool: ${definition.name}`,
        details: {
          toolName: definition.name,
          source: definition.metadata.source,
          sourceName: definition.metadata.sourceName,
        },
      };
    }

    const tool = toolFromDefinition(definition);
    this.entries.set(definition.name, {
      definition,
      tool: withToolMetadata(tool, definition.metadata),
      metadata: definition.metadata,
    });
    return null;
  }

  getDefinitions(): ToolDefinition[] {
    return [...this.entries.values()].map((entry) => entry.definition);
  }

  getTools(): Tool[] {
    return [...this.entries.values()].map((entry) => entry.tool);
  }

  getMetadata(toolName: string): ToolMetadata | undefined {
    return this.entries.get(toolName)?.metadata;
  }

  get size(): number {
    return this.entries.size;
  }
}

export interface LoadToolRegistryOptions {
  config: ConfigData;
  workspaceDir: string;
}

export interface LoadToolRegistryResult {
  registry: ToolRegistry;
  tools: Tool[];
  diagnostics: ToolDiagnostic[];
}

function addTool(
  registry: ToolRegistry,
  diagnostics: ToolDiagnostic[],
  tool: Tool,
  metadata: ToolMetadata,
): void {
  const duplicate = registry.add(tool, metadata);
  if (duplicate) diagnostics.push(duplicate);
}

export async function loadConfiguredTools({
  config,
  workspaceDir,
}: LoadToolRegistryOptions): Promise<LoadToolRegistryResult> {
  const registry = new ToolRegistry();
  const diagnostics: ToolDiagnostic[] = [];

  if (config.tools.enableFileTools) {
    addTool(registry, diagnostics, new ReadTool(workspaceDir), {
      category: 'read',
      riskLevel: 'low',
      source: 'builtin',
      isReadOnly: true,
      isConcurrencySafe: true,
    });
    addTool(registry, diagnostics, new WriteTool(workspaceDir), {
      category: 'write',
      riskLevel: 'high',
      source: 'builtin',
      isReadOnly: false,
      isConcurrencySafe: false,
      requiresConfirmation: true,
    });
    addTool(registry, diagnostics, new EditTool(workspaceDir), {
      category: 'write',
      riskLevel: 'high',
      source: 'builtin',
      isReadOnly: false,
      isConcurrencySafe: false,
      requiresConfirmation: true,
    });
    addTool(registry, diagnostics, new LsTool(workspaceDir), {
      category: 'read',
      riskLevel: 'low',
      source: 'builtin',
      isReadOnly: true,
      isConcurrencySafe: true,
    });
    addTool(registry, diagnostics, new FindTool(workspaceDir), {
      category: 'read',
      riskLevel: 'low',
      source: 'builtin',
      isReadOnly: true,
      isConcurrencySafe: true,
    });
    addTool(registry, diagnostics, new GrepTool(workspaceDir), {
      category: 'read',
      riskLevel: 'low',
      source: 'builtin',
      isReadOnly: true,
      isConcurrencySafe: true,
    });
    diagnostics.push({
      type: 'info',
      code: 'file_tools_loaded',
      message: `Loaded file/search tools (workspace: ${workspaceDir})`,
      details: { workspaceDir },
    });
  }

  if (config.tools.enableBash) {
    addTool(registry, diagnostics, new BashTool(workspaceDir), {
      category: 'bash',
      riskLevel: 'high',
      source: 'builtin',
      isReadOnly: false,
      isConcurrencySafe: false,
      requiresConfirmation: true,
    });
    addTool(registry, diagnostics, new BashOutputTool(), {
      category: 'bash',
      riskLevel: 'low',
      source: 'builtin',
      isReadOnly: true,
      isConcurrencySafe: true,
    });
    addTool(registry, diagnostics, new BashKillTool(), {
      category: 'bash',
      riskLevel: 'high',
      source: 'builtin',
      isReadOnly: false,
      isConcurrencySafe: false,
      requiresConfirmation: true,
    });
    diagnostics.push({
      type: 'info',
      code: 'bash_tools_loaded',
      message: `Loaded bash tools (cwd: ${workspaceDir})`,
      details: { workspaceDir },
    });
  }

  diagnostics.push({
    type: 'info',
    code: 'tool_registry_ready',
    message: `Tool registry ready (${registry.size} tools)`,
    details: { count: registry.size },
  });

  return {
    registry,
    tools: registry.getTools(),
    diagnostics,
  };
}
