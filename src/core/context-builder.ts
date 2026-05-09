import { createDiagnostic, type RuntimeDiagnostic } from '../diagnostics.js';
import type { Message } from '../schema.js';
import type { ProjectContextResource } from './resource-loader.js';

export interface ContextBuilder {
  readonly projectContext: ProjectContextResource[];
  build(input: BuildContextInput): BuildContextResult;
}

export interface BuildContextInput {
  systemPrompt: string;
  messages: Message[];
}

export interface BuildContextResult {
  messages: Message[];
  diagnostics: RuntimeDiagnostic[];
}

export interface CreateContextBuilderOptions {
  projectContext?: ProjectContextResource[];
}

function formatProjectContext(resources: ProjectContextResource[]): string | null {
  const blocks = resources
    .filter((resource) => resource.content.trim().length > 0)
    .map((resource) => [
      `Contents of ${resource.name}:`,
      '',
      resource.content.trim(),
    ].join('\n'));

  if (blocks.length === 0) return null;
  return ['<project_context>', ...blocks, '</project_context>'].join('\n\n');
}

function withSystemMessage(messages: Message[], systemPrompt: string): Message[] {
  const [first, ...rest] = messages;
  if (first?.role === 'system') return [first, ...rest];
  return [{ role: 'system', content: systemPrompt }, ...messages];
}

function insertAfterSystemMessage(messages: Message[], projectContextMessage: Message, systemPrompt: string): Message[] {
  const [first, ...rest] = withSystemMessage(messages, systemPrompt);
  return [first, projectContextMessage, ...rest];
}

export function createContextBuilder({ projectContext = [] }: CreateContextBuilderOptions = {}): ContextBuilder {
  const resources = projectContext.slice();

  return {
    projectContext: resources,
    build({ systemPrompt, messages }: BuildContextInput): BuildContextResult {
      const content = formatProjectContext(resources);
      if (!content) {
        return {
          messages: withSystemMessage(messages, systemPrompt),
          diagnostics: [createDiagnostic({
            source: 'context',
            level: 'info',
            code: 'project_context_empty',
            message: 'No project context injected',
          })],
        };
      }

      return {
        messages: insertAfterSystemMessage(messages, { role: 'user', content }, systemPrompt),
        diagnostics: [createDiagnostic({
          source: 'context',
          level: 'info',
          code: 'project_context_injected',
          message: `Injected ${resources.length} project context resource(s)`,
          details: {
            count: resources.length,
            names: resources.map((resource) => resource.name),
            contentLength: content.length,
          },
        })],
      };
    },
  };
}
