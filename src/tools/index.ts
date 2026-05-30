export type {
  JsonSchema,
  Tool,
  ToolCategory,
  ToolDefinition,
  ToolExecutionContext,
  ToolMetadata,
  ToolResult,
  ToolResultDetails,
  ToolRiskLevel,
  ToolSource,
} from './base.js';
export { createToolDefinition, toAnthropicSchema, toOpenAISchema, toolFromDefinition, withToolMetadata } from './base.js';
export { BashKillTool, BashOutputTool, BashTool, type BashExecOptions, type BashOperations, type BashOutputResult, type BashSpawnOptions, type BashToolDetails } from './bash.js';
export { EditTool, type EditToolInput } from './edit.js';
export { localFileToolOperations, type FileToolDirent, type FileToolOperations, type FileToolStats } from './file-operations.js';
export { fileMutationQueue, FileMutationQueue } from './file-mutation-queue.js';
export { FindTool, type FindToolDetails, type FindToolInput } from './find.js';
export { GrepTool, type GrepToolInput, type SearchToolDetails } from './grep.js';
export { LsTool, type ListToolDetails, type LsToolInput } from './ls.js';
export { resolveWorkspacePath } from './path-utils.js';
export { ReadTool, type ReadToolDetails, type ReadToolInput } from './read.js';
export { truncateMiddle, truncateTextByTokens, type ToolOutputTruncationDetails, type TruncationResult } from './truncate.js';
export { WriteTool, type WriteToolInput } from './write.js';
export { createToolDefinitionFromTool, wrapToolDefinition } from './tool-definition-wrapper.js';

import type { ConfigData } from '../config.js';
import { createDiagnostic, type RuntimeDiagnostic } from '../diagnostics.js';
import { BashKillTool, BashOutputTool, BashTool } from './bash.js';
import { EditTool } from './edit.js';
import { FindTool } from './find.js';
import { GrepTool } from './grep.js';
import { LsTool } from './ls.js';
import { ReadTool } from './read.js';
import { WriteTool } from './write.js';
import type { Tool, ToolDefinition, ToolMetadata } from './base.js';
import { createToolDefinition, toolFromDefinition, withToolMetadata } from './base.js';

export type ToolDiagnostic = RuntimeDiagnostic;

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
        source: 'tools',
        level: 'warning',
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

  has(toolName: string): boolean {
    return this.entries.has(toolName);
  }

  remove(toolName: string): ToolRegistryEntry | undefined {
    const entry = this.entries.get(toolName);
    if (entry) this.entries.delete(toolName);
    return entry;
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

function applyToolGovernance(registry: ToolRegistry, diagnostics: ToolDiagnostic[], config: ConfigData): void {
  const allNames = new Set(registry.getTools().map((tool) => tool.name));
  const enabledTools = new Set(config.tools.enabledTools);
  const disabledTools = new Set(config.tools.disabledTools);
  const disabledCategories = new Set(config.tools.disabledCategories);

  for (const toolName of enabledTools) {
    if (!allNames.has(toolName)) {
      diagnostics.push({
        source: 'tools',
        level: 'warning',
        type: 'warning',
        code: 'tool_enabled_unknown',
        message: 'Configured enabled tool does not exist: ' + toolName,
        details: { toolName },
      });
    }
  }

  if (enabledTools.size > 0) {
    for (const tool of registry.getTools()) {
      if (!enabledTools.has(tool.name)) {
        registry.remove(tool.name);
        diagnostics.push({
          source: 'tools',
          level: 'info',
          type: 'info',
          code: 'tool_not_enabled_skipped',
          message: 'Skipped tool not present in enabled_tools: ' + tool.name,
          details: { toolName: tool.name },
        });
      }
    }
  }

  for (const toolName of disabledTools) {
    const removed = registry.remove(toolName);
    if (removed) {
      diagnostics.push({
        source: 'tools',
        level: 'info',
        type: 'info',
        code: 'tool_disabled',
        message: 'Disabled tool by config: ' + toolName,
        details: { toolName, category: removed.metadata.category },
      });
    } else if (!allNames.has(toolName)) {
      diagnostics.push({
        source: 'tools',
        level: 'warning',
        type: 'warning',
        code: 'tool_disabled_unknown',
        message: 'Configured disabled tool does not exist: ' + toolName,
        details: { toolName },
      });
    }
  }

  if (disabledCategories.size > 0) {
    for (const tool of registry.getTools()) {
      const category = tool.metadata?.category;
      if (category && disabledCategories.has(category)) {
        registry.remove(tool.name);
        diagnostics.push({
          source: 'tools',
          level: 'info',
          type: 'info',
          code: 'tool_category_disabled',
          message: 'Disabled ' + category + ' tool by config: ' + tool.name,
          details: { toolName: tool.name, category },
        });
      }
    }
  }
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
    diagnostics.push(createDiagnostic({
      source: 'tools',
      level: 'info',
      code: 'file_tools_loaded',
      message: `Loaded file/search tools (workspace: ${workspaceDir})`,
      details: { workspaceDir },
    }));
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
    diagnostics.push(createDiagnostic({
      source: 'tools',
      level: 'info',
      code: 'bash_tools_loaded',
      message: `Loaded bash tools (cwd: ${workspaceDir})`,
      details: { workspaceDir },
    }));
  }

  applyToolGovernance(registry, diagnostics, config);

  diagnostics.push(createDiagnostic({
    source: 'tools',
    level: 'info',
    code: 'tool_registry_ready',
    message: `Tool registry ready (${registry.size} tools)`,
    details: { count: registry.size },
  }));

  return {
    registry,
    tools: registry.getTools(),
    diagnostics,
  };
}
