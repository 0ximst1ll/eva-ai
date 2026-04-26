// Skill loader — mirrors mini_agent/tools/skill_loader.py
// Python uses dataclass + re + yaml; TypeScript uses a plain class + regex + yaml package.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';

interface SkillFrontmatter {
  name: string;
  description: string;
  license?: string;
  'allowed-tools'?: string[];
  metadata?: Record<string, string>;
}

export interface Skill {
  name: string;
  description: string;
  content: string;
  license?: string;
  allowedTools?: string[];
  metadata?: Record<string, string>;
  skillPath: string;
}

export function skillToPrompt(skill: Skill): string {
  const skillRoot = path.dirname(skill.skillPath);
  return `
# Skill: ${skill.name}

${skill.description}

**Skill Root Directory:** \`${skillRoot}\`

All files and references in this skill are relative to this directory.

---

${skill.content}
`;
}

// ============ Path processing ============
// Mirrors SkillLoader._process_skill_paths

function processSkillPaths(content: string, skillDir: string): string {
  // Pattern 1: scripts/ / references/ / assets/ paths
  content = content.replace(
    /(python\s+|`)((?:scripts|references|assets)\/[^\s`\)]+)/g,
    (match, prefix: string, relPath: string) => {
      const abs = path.join(skillDir, relPath);
      return fs.existsSync(abs) ? `${prefix}${abs}` : match;
    },
  );

  // Pattern 2: "see/read reference.md" style
  content = content.replace(
    /(see|read|refer to|check)\s+([a-zA-Z0-9_-]+\.(?:md|txt|json|yaml))([.,;\s])/gi,
    (match, prefix: string, filename: string, suffix: string) => {
      const abs = path.join(skillDir, filename);
      return fs.existsSync(abs)
        ? `${prefix}\`${abs}\` (use read_file to access)${suffix}`
        : match;
    },
  );

  // Pattern 3: Markdown links [text](path)
  content = content.replace(
    /(?:(Read|See|Check|Refer to|Load|View)\s+)?\[(`?[^`\]]+`?)\]\(((?:\.\/)?[^)]+\.(?:md|txt|json|yaml|js|py|html))\)/gi,
    (match, prefix: string | undefined, linkText: string, filepath: string) => {
      const cleanPath = filepath.startsWith('./') ? filepath.slice(2) : filepath;
      const abs = path.join(skillDir, cleanPath);
      if (!fs.existsSync(abs)) return match;
      const p = prefix ? `${prefix} ` : '';
      return `${p}[${linkText}](\`${abs}\`) (use read_file to access)`;
    },
  );

  return content;
}

// ============ SkillLoader ============

export class SkillLoader {
  private readonly skillsDir: string;
  readonly loadedSkills: Map<string, Skill> = new Map();

  constructor(skillsDir: string = './skills') {
    this.skillsDir = skillsDir;
  }

  loadSkill(skillPath: string): Skill | null {
    try {
      const raw = fs.readFileSync(skillPath, 'utf-8');

      // Parse YAML frontmatter
      const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw);
      if (!match) {
        console.log(`⚠️  ${skillPath} missing YAML frontmatter`);
        return null;
      }

      let frontmatter: SkillFrontmatter;
      try {
        frontmatter = parseYaml(match[1]) as SkillFrontmatter;
      } catch (e) {
        console.log(`❌ Failed to parse YAML frontmatter: ${e}`);
        return null;
      }

      if (!frontmatter.name || !frontmatter.description) {
        console.log(`⚠️  ${skillPath} missing required fields (name or description)`);
        return null;
      }

      const skillDir = path.dirname(skillPath);
      const processedContent = processSkillPaths(match[2].trim(), skillDir);

      return {
        name: frontmatter.name,
        description: frontmatter.description,
        content: processedContent,
        license: frontmatter.license,
        allowedTools: frontmatter['allowed-tools'],
        metadata: frontmatter.metadata,
        skillPath,
      };
    } catch (e) {
      console.log(`❌ Failed to load skill (${skillPath}): ${e}`);
      return null;
    }
  }

  discoverSkills(): Skill[] {
    const skills: Skill[] = [];

    if (!fs.existsSync(this.skillsDir)) {
      console.log(`⚠️  Skills directory does not exist: ${this.skillsDir}`);
      return skills;
    }

    // Recursively find all SKILL.md files
    const findSkillFiles = (dir: string): string[] => {
      const results: string[] = [];
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          results.push(...findSkillFiles(full));
        } else if (entry.name === 'SKILL.md') {
          results.push(full);
        }
      }
      return results;
    };

    for (const skillFile of findSkillFiles(this.skillsDir)) {
      const skill = this.loadSkill(skillFile);
      if (skill) {
        skills.push(skill);
        this.loadedSkills.set(skill.name, skill);
      }
    }

    return skills;
  }

  getSkill(name: string): Skill | undefined {
    return this.loadedSkills.get(name);
  }

  listSkills(): string[] {
    return [...this.loadedSkills.keys()];
  }

  getSkillsMetadataPrompt(): string {
    if (!this.loadedSkills.size) return '';

    const lines = [
      '## Available Skills\n',
      'You have access to specialized skills. Each skill provides expert guidance for specific tasks.\n',
      'Load a skill\'s full content using the appropriate skill tool when needed.\n',
    ];

    for (const skill of this.loadedSkills.values()) {
      lines.push(`- \`${skill.name}\`: ${skill.description}`);
    }

    return lines.join('\n');
  }
}
