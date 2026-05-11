// Configuration management — mirrors eva_ai/config.py
// Python uses Pydantic BaseModel; TypeScript uses plain interfaces + a Config class.

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { parse as parseYaml } from 'yaml';

export interface RetryConfigData {
  enabled: boolean;
  maxRetries: number;
  initialDelay: number;
  maxDelay: number;
  exponentialBase: number;
}

export interface LLMConfigData {
  apiKey: string;
  apiBase: string;
  model: string;
  provider: string;
  retry: RetryConfigData;
}

export interface MCPConfigData {
  connectTimeout: number;
  executeTimeout: number;
  sseReadTimeout: number;
}

export interface ToolsConfigData {
  enableFileTools: boolean;
  enableBash: boolean;
  enableSkills: boolean;
  skillsDir: string;
  enableMcp: boolean;
  mcpConfigPath: string;
  enabledTools: string[];
  disabledTools: string[];
  disabledCategories: string[];
  requireConfirmation: boolean;
  confirmRiskLevels: string[];
  mcp: MCPConfigData;
}

export interface AgentConfigData {
  maxSteps: number | null;
  workspaceDir: string;
  systemPromptPath: string;
  projectContextMaxChars: number;
  contextWindowTokens: number | null;
  compaction: CompactionConfigData;
}

export interface CompactionConfigData {
  enabled: boolean;
  reserveTokens: number;
}

export interface ConfigData {
  llm: LLMConfigData;
  agent: AgentConfigData;
  tools: ToolsConfigData;
}

// Raw YAML shape (snake_case from file)
interface RawYaml {
  api_key?: string;
  api_base?: string;
  model?: string;
  provider?: string;
  max_steps?: number;
  workspace_dir?: string;
  system_prompt_path?: string;
  project_context_max_chars?: number;
  context_window_tokens?: number;
  compaction?: {
    enabled?: boolean;
    reserve_tokens?: number;
  };
  retry?: {
    enabled?: boolean;
    max_retries?: number;
    initial_delay?: number;
    max_delay?: number;
    exponential_base?: number;
  };
  tools?: {
    enable_file_tools?: boolean;
    enable_bash?: boolean;
    enable_skills?: boolean;
    skills_dir?: string;
    enable_mcp?: boolean;
    mcp_config_path?: string;
    enabled_tools?: string[];
    disabled_tools?: string[];
    disabled_categories?: string[];
    require_confirmation?: boolean;
    confirm_risk_levels?: string[];
    mcp?: {
      connect_timeout?: number;
      execute_timeout?: number;
      sse_read_timeout?: number;
    };
  };
}

export class Config {
  static getPackageDir(): string {
    // __dirname equivalent in ESM: use import.meta.url
    // We resolve relative to this file's location
    return path.dirname(new URL(import.meta.url).pathname);
  }

  static findConfigFile(filename: string): string | null {
    // Priority 1: ./eva_ai/config/<filename> (development)
    const devConfig = path.join(process.cwd(), 'eva_ai', 'config', filename);
    if (fs.existsSync(devConfig)) return devConfig;

    // Priority 2: ~/.eva-ai/config/<filename> (user)
    const userConfig = path.join(os.homedir(), '.eva-ai', 'config', filename);
    if (fs.existsSync(userConfig)) return userConfig;

    // Priority 3: <package>/config/<filename>
    const pkgConfig = path.join(Config.getPackageDir(), '..', 'config', filename);
    if (fs.existsSync(pkgConfig)) return pkgConfig;

    return null;
  }

  static getDefaultConfigPath(): string {
    const found = Config.findConfigFile('config.yaml');
    if (found) return found;
    return path.join(os.homedir(), '.eva-ai', 'config', 'config.yaml');
  }

  static fromYaml(configPath: string): ConfigData {
    if (!fs.existsSync(configPath)) {
      throw new Error(`Configuration file does not exist: ${configPath}`);
    }

    const raw = parseYaml(fs.readFileSync(configPath, 'utf-8')) as RawYaml;

    if (!raw) throw new Error('Configuration file is empty');
    if (!raw.api_key) throw new Error('Configuration file missing required field: api_key');
    if (raw.api_key === 'YOUR_API_KEY_HERE') throw new Error('Please configure a valid API Key');

    const retry = raw.retry ?? {};
    const tools = raw.tools ?? {};
    const mcp = tools.mcp ?? {};

    return {
      llm: {
        apiKey: raw.api_key,
        apiBase: raw.api_base ?? 'https://api.minimax.io',
        model: raw.model ?? 'MiniMax-M2.5',
        provider: raw.provider ?? 'anthropic',
        retry: {
          enabled: retry.enabled ?? true,
          maxRetries: retry.max_retries ?? 3,
          initialDelay: retry.initial_delay ?? 1.0,
          maxDelay: retry.max_delay ?? 60.0,
          exponentialBase: retry.exponential_base ?? 2.0,
        },
      },
      agent: {
        maxSteps: raw.max_steps ?? null,
        workspaceDir: raw.workspace_dir ?? './workspace',
        systemPromptPath: raw.system_prompt_path ?? 'system_prompt.md',
        projectContextMaxChars: raw.project_context_max_chars ?? 20000,
        contextWindowTokens: normalizeOptionalPositiveInteger(raw.context_window_tokens),
        compaction: {
          enabled: raw.compaction?.enabled ?? false,
          reserveTokens: normalizePositiveInteger(raw.compaction?.reserve_tokens, 16384),
        },
      },
      tools: {
        enableFileTools: tools.enable_file_tools ?? true,
        enableBash: tools.enable_bash ?? true,
        enableSkills: tools.enable_skills ?? true,
        skillsDir: tools.skills_dir ?? './skills',
        enableMcp: tools.enable_mcp ?? true,
        mcpConfigPath: tools.mcp_config_path ?? 'mcp.json',
        enabledTools: Array.isArray(tools.enabled_tools) ? tools.enabled_tools : [],
        disabledTools: Array.isArray(tools.disabled_tools) ? tools.disabled_tools : [],
        disabledCategories: Array.isArray(tools.disabled_categories) ? tools.disabled_categories : [],
        requireConfirmation: tools.require_confirmation ?? true,
        confirmRiskLevels: Array.isArray(tools.confirm_risk_levels) ? tools.confirm_risk_levels : ['high'],
        mcp: {
          connectTimeout: mcp.connect_timeout ?? 10.0,
          executeTimeout: mcp.execute_timeout ?? 60.0,
          sseReadTimeout: mcp.sse_read_timeout ?? 120.0,
        },
      },
    };
  }

  static load(): ConfigData {
    const configPath = Config.getDefaultConfigPath();
    if (!fs.existsSync(configPath)) {
      throw new Error(
        'Configuration file not found. Place config.yaml in ~/.eva-ai/config/',
      );
    }
    return Config.fromYaml(configPath);
  }
}

function normalizeOptionalPositiveInteger(value: number | undefined): number | null {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return null;
  return Math.floor(value);
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}
