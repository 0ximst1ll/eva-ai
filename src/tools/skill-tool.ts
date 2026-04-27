// Skill tool — mirrors eva_ai/tools/skill_tool.py

import type { Tool, ToolResult } from './base.js';
import { SkillLoader, skillToPrompt } from './skill-loader.js';

interface GetSkillInput extends Record<string, unknown> {
  skill_name: string;
}

export class GetSkillTool implements Tool<GetSkillInput> {
  readonly name = 'get_skill';
  readonly description =
    'Get complete content and guidance for a specified skill, used for executing specific types of tasks';
  readonly parameters = {
    type: 'object',
    properties: {
      skill_name: {
        type: 'string',
        description: 'Name of the skill to retrieve (use list_skills to view available skills)',
      },
    },
    required: ['skill_name'],
  };

  constructor(private readonly skillLoader: SkillLoader) {}

  async execute({ skill_name }: GetSkillInput): Promise<ToolResult> {
    const skill = this.skillLoader.getSkill(skill_name);

    if (!skill) {
      const available = this.skillLoader.listSkills().join(', ');
      return {
        success: false,
        content: '',
        error: `Skill '${skill_name}' does not exist. Available skills: ${available}`,
      };
    }

    return { success: true, content: skillToPrompt(skill) };
  }
}

export function createSkillTools(skillsDir: string = './skills'): {
  tools: Tool[];
  loader: SkillLoader;
} {
  const loader = new SkillLoader(skillsDir);
  const skills = loader.discoverSkills();
  console.log(`✅ Discovered ${skills.length} Claude Skills`);

  return { tools: [new GetSkillTool(loader)], loader };
}
