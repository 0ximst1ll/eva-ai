import type { Tool, ToolDefinition } from './base.js';
import { toolFromDefinition, createToolDefinition } from './base.js';

export function wrapToolDefinition<TInput extends Record<string, unknown>>(
  definition: ToolDefinition<TInput>,
): Tool<TInput> {
  return toolFromDefinition(definition);
}

export function createToolDefinitionFromTool<TInput extends Record<string, unknown>>(
  tool: Tool<TInput>,
): ToolDefinition<TInput> {
  if (!tool.metadata) {
    throw new Error(`Tool is missing metadata: ${tool.name}`);
  }
  return createToolDefinition(tool, tool.metadata);
}
