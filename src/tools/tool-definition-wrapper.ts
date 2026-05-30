import type { Tool, ToolDefinition, ToolResultDetails } from './base.js';
import { toolFromDefinition, createToolDefinition } from './base.js';

export function wrapToolDefinition<
  TInput extends Record<string, unknown>,
  TDetails extends ToolResultDetails = ToolResultDetails,
>(
  definition: ToolDefinition<TInput, TDetails>,
): Tool<TInput, TDetails> {
  return toolFromDefinition(definition);
}

export function createToolDefinitionFromTool<
  TInput extends Record<string, unknown>,
  TDetails extends ToolResultDetails = ToolResultDetails,
>(
  tool: Tool<TInput, TDetails>,
): ToolDefinition<TInput, TDetails> {
  if (!tool.metadata) {
    throw new Error(`Tool is missing metadata: ${tool.name}`);
  }
  return createToolDefinition(tool, tool.metadata);
}
