import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { Config, type ConfigData } from '../config.js';
import { createDiagnostic, type RuntimeDiagnostic } from '../diagnostics.js';

export interface ProjectContextResource {
  type: 'project_context';
  name: string;
  path: string;
  content: string;
}

export interface SkillResource {
  type: 'skill';
  name: string;
  description: string;
  path: string;
  baseDir: string;
  content: string;
  disableModelInvocation: boolean;
}

export interface ResourceLoader {
  workspaceDir: string;
  systemPrompt: string;
  systemPromptPath: string | null;
  projectContext: ProjectContextResource[];
  skills: SkillResource[];
  diagnostics: RuntimeDiagnostic[];
}

export interface CreateResourceLoaderOptions {
  workspaceDir: string;
  config: ConfigData;
}

const DEFAULT_SYSTEM_PROMPT = 'You are Eva AI, an intelligent assistant that can help users complete various tasks.';

interface ParsedSkillFrontmatter {
  name?: string;
  description?: string;
  disableModelInvocation?: boolean;
}

function resolveResourcePath(workspaceDir: string, configuredPath: string): string {
  if (path.isAbsolute(configuredPath)) return configuredPath;
  return path.resolve(workspaceDir, configuredPath);
}

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

function parseSkillFile(filePath: string): {
  frontmatter: ParsedSkillFrontmatter;
  content: string;
} {
  const content = fs.readFileSync(filePath, 'utf-8');
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
  if (!match) return { frontmatter: {}, content };

  const parsed = parseYaml(match[1] ?? '') as Record<string, unknown> | null;
  const frontmatter: ParsedSkillFrontmatter = {};

  if (parsed && typeof parsed.name === 'string') {
    frontmatter.name = parsed.name.trim();
  }
  if (parsed && typeof parsed.description === 'string') {
    frontmatter.description = parsed.description.trim();
  }

  const disableModelInvocation = parsed?.['disable-model-invocation'] ?? parsed?.disableModelInvocation;
  if (typeof disableModelInvocation === 'boolean') {
    frontmatter.disableModelInvocation = disableModelInvocation;
  }

  return { frontmatter, content };
}

function loadSkillFile(filePath: string, baseDir: string): {
  skill: SkillResource | null;
  diagnostics: RuntimeDiagnostic[];
} {
  const diagnostics: RuntimeDiagnostic[] = [];

  try {
    const parsed = parseSkillFile(filePath);
    const name = parsed.frontmatter.name;
    const description = parsed.frontmatter.description;

    if (!name) {
      diagnostics.push(createDiagnostic({
        source: 'resource',
        level: 'warning',
        code: 'skill_missing_name',
        message: `Skill is missing required frontmatter: ${filePath}`,
        details: { path: filePath, field: 'name' },
      }));
      return { skill: null, diagnostics };
    }

    if (!description) {
      diagnostics.push(createDiagnostic({
        source: 'resource',
        level: 'warning',
        code: 'skill_missing_description',
        message: `Skill is missing required frontmatter: ${filePath}`,
        details: { path: filePath, name, field: 'description' },
      }));
      return { skill: null, diagnostics };
    }

    return {
      skill: {
        type: 'skill',
        name,
        description,
        path: filePath,
        baseDir,
        content: parsed.content,
        disableModelInvocation: parsed.frontmatter.disableModelInvocation ?? false,
      },
      diagnostics,
    };
  } catch (error) {
    diagnostics.push(createDiagnostic({
      source: 'resource',
      level: 'warning',
      code: 'skill_read_failed',
      message: `Failed to read skill: ${filePath}`,
      details: {
        path: filePath,
        error: error instanceof Error ? error.message : String(error),
      },
    }));
    return { skill: null, diagnostics };
  }
}

function collectSkillFiles(dir: string, isRoot = true): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));
  const skillMd = entries.find((entry) => entry.isFile() && entry.name === 'SKILL.md');

  if (skillMd) {
    return [path.join(dir, skillMd.name)];
  }

  const files: string[] = [];
  if (isRoot) {
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.md')) {
        files.push(path.join(dir, entry.name));
      }
    }
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      files.push(...collectSkillFiles(path.join(dir, entry.name), false));
    }
  }

  return files;
}

function loadSkills(workspaceDir: string, config: ConfigData): {
  skills: SkillResource[];
  diagnostics: RuntimeDiagnostic[];
} {
  const diagnostics: RuntimeDiagnostic[] = [];
  const skills: SkillResource[] = [];

  if (!config.tools.enableSkills) {
    diagnostics.push(createDiagnostic({
      source: 'resource',
      level: 'info',
      code: 'skills_disabled',
      message: 'Skills loading is disabled',
      details: { enableSkills: false },
    }));
    return { skills, diagnostics };
  }

  const skillsDir = resolveResourcePath(workspaceDir, config.tools.skillsDir);
  if (!fs.existsSync(skillsDir)) {
    diagnostics.push(createDiagnostic({
      source: 'resource',
      level: 'warning',
      code: 'skills_dir_missing',
      message: `Skills directory not found: ${skillsDir}`,
      details: { skillsDir, configuredPath: config.tools.skillsDir },
    }));
    return { skills, diagnostics };
  }

  const stat = fs.statSync(skillsDir);
  if (!stat.isDirectory()) {
    diagnostics.push(createDiagnostic({
      source: 'resource',
      level: 'warning',
      code: 'skills_dir_not_directory',
      message: `Configured skills path is not a directory: ${skillsDir}`,
      details: { skillsDir, configuredPath: config.tools.skillsDir },
    }));
    return { skills, diagnostics };
  }

  const seenNames = new Set<string>();
  for (const filePath of collectSkillFiles(skillsDir)) {
    const result = loadSkillFile(filePath, path.dirname(filePath));
    diagnostics.push(...result.diagnostics);
    if (!result.skill) continue;

    if (seenNames.has(result.skill.name)) {
      diagnostics.push(createDiagnostic({
        source: 'resource',
        level: 'warning',
        code: 'skill_duplicate_name',
        message: `Duplicate skill ignored: ${result.skill.name}`,
        details: { name: result.skill.name, path: result.skill.path },
      }));
      continue;
    }

    seenNames.add(result.skill.name);
    skills.push(result.skill);
  }

  diagnostics.push(createDiagnostic({
    source: 'resource',
    level: 'info',
    code: 'skills_loaded',
    message: `Loaded ${skills.length} skill resource(s)`,
    details: {
      skillsDir,
      count: skills.length,
      skills: skills.map((skill) => ({
        name: skill.name,
        path: skill.path,
        disableModelInvocation: skill.disableModelInvocation,
      })),
    },
  }));

  return { skills, diagnostics };
}

function collectUnimplementedResourceDiagnostics(config: ConfigData): RuntimeDiagnostic[] {
  const diagnostics: RuntimeDiagnostic[] = [];

  if (config.tools.enableMcp) {
    diagnostics.push(createDiagnostic({
      source: 'resource',
      level: 'warning',
      code: 'mcp_requires_extension',
      message: 'MCP is configured but MCP support is reserved for a future extension boundary',
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
  const skillsResult = loadSkills(resolvedWorkspaceDir, config);
  diagnostics.push(...skillsResult.diagnostics);
  diagnostics.push(...collectUnimplementedResourceDiagnostics(config));

  return {
    workspaceDir: resolvedWorkspaceDir,
    systemPrompt: systemPromptResult.systemPrompt,
    systemPromptPath: systemPromptResult.systemPromptPath,
    projectContext: projectContextResult.projectContext,
    skills: skillsResult.skills,
    diagnostics,
  };
}
