import * as fs from 'node:fs';
import * as path from 'node:path';
import { Config, type ConfigData } from '../config.js';
import { createDiagnostic, type RuntimeDiagnostic } from '../diagnostics.js';

export interface ProjectContextResource {
  type: 'project_context';
  name: string;
  path: string;
  content: string;
}

export interface ResourceLoader {
  workspaceDir: string;
  systemPrompt: string;
  systemPromptPath: string | null;
  projectContext: ProjectContextResource[];
  diagnostics: RuntimeDiagnostic[];
}

export interface CreateResourceLoaderOptions {
  workspaceDir: string;
  config: ConfigData;
}

const DEFAULT_SYSTEM_PROMPT = 'You are Eva AI, an intelligent assistant that can help users complete various tasks.';

function loadSystemPrompt(config: ConfigData): {
  systemPrompt: string;
  systemPromptPath: string | null;
  diagnostic: RuntimeDiagnostic;
} {
  const systemPromptPath = Config.findConfigFile(config.agent.systemPromptPath);
  if (systemPromptPath && fs.existsSync(systemPromptPath)) {
    return {
      systemPrompt: fs.readFileSync(systemPromptPath, 'utf-8'),
      systemPromptPath,
      diagnostic: createDiagnostic({
        source: 'resource',
        level: 'info',
        code: 'system_prompt_loaded',
        message: `Loaded system prompt (from: ${systemPromptPath})`,
        details: { systemPromptPath },
      }),
    };
  }

  return {
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    systemPromptPath: null,
    diagnostic: createDiagnostic({
      source: 'resource',
      level: 'warning',
      code: 'system_prompt_missing',
      message: 'System prompt not found, using default',
      details: { configuredPath: config.agent.systemPromptPath },
    }),
  };
}

function loadProjectContext(workspaceDir: string): {
  projectContext: ProjectContextResource[];
  diagnostics: RuntimeDiagnostic[];
} {
  const projectContext: ProjectContextResource[] = [];
  const diagnostics: RuntimeDiagnostic[] = [];
  const agentsPath = path.join(workspaceDir, 'AGENTS.md');

  if (!fs.existsSync(agentsPath)) {
    return { projectContext, diagnostics };
  }

  try {
    projectContext.push({
      type: 'project_context',
      name: 'AGENTS.md',
      path: agentsPath,
      content: fs.readFileSync(agentsPath, 'utf-8'),
    });
    diagnostics.push(createDiagnostic({
      source: 'resource',
      level: 'info',
      code: 'project_context_loaded',
      message: `Loaded project context: ${agentsPath}`,
      details: { path: agentsPath, name: 'AGENTS.md' },
    }));
  } catch (error) {
    diagnostics.push(createDiagnostic({
      source: 'resource',
      level: 'warning',
      code: 'project_context_read_failed',
      message: `Failed to read project context: ${agentsPath}`,
      details: {
        path: agentsPath,
        error: error instanceof Error ? error.message : String(error),
      },
    }));
  }

  return { projectContext, diagnostics };
}

function collectUnimplementedResourceDiagnostics(config: ConfigData): RuntimeDiagnostic[] {
  const diagnostics: RuntimeDiagnostic[] = [];

  if (config.tools.enableSkills) {
    diagnostics.push(createDiagnostic({
      source: 'resource',
      level: 'warning',
      code: 'skills_resource_not_loaded',
      message: 'Skills are configured but the skills loader is not implemented yet',
      details: { enableSkills: config.tools.enableSkills, skillsDir: config.tools.skillsDir },
    }));
  }

  if (config.tools.enableMcp) {
    diagnostics.push(createDiagnostic({
      source: 'resource',
      level: 'warning',
      code: 'mcp_resource_not_loaded',
      message: 'MCP is configured but the MCP loader is not implemented yet',
      details: { enableMcp: config.tools.enableMcp, mcpConfigPath: config.tools.mcpConfigPath },
    }));
  }

  return diagnostics;
}

export function createResourceLoader({ workspaceDir, config }: CreateResourceLoaderOptions): ResourceLoader {
  const resolvedWorkspaceDir = path.resolve(workspaceDir);
  const diagnostics: RuntimeDiagnostic[] = [];
  const systemPromptResult = loadSystemPrompt(config);
  diagnostics.push(systemPromptResult.diagnostic);

  const projectContextResult = loadProjectContext(resolvedWorkspaceDir);
  diagnostics.push(...projectContextResult.diagnostics);
  diagnostics.push(...collectUnimplementedResourceDiagnostics(config));

  return {
    workspaceDir: resolvedWorkspaceDir,
    systemPrompt: systemPromptResult.systemPrompt,
    systemPromptPath: systemPromptResult.systemPromptPath,
    projectContext: projectContextResult.projectContext,
    diagnostics,
  };
}
