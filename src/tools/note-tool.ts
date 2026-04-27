// Session note tool — mirrors eva_ai/tools/note_tool.py

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Tool, ToolResult } from './base.js';

interface NoteEntry {
  timestamp: string;
  category: string;
  content: string;
}

// ============ SessionNoteTool (record_note) ============

interface RecordNoteInput extends Record<string, unknown> {
  content: string;
  category?: string;
}

export class SessionNoteTool implements Tool<RecordNoteInput> {
  readonly name = 'record_note';
  readonly description =
    'Record important information as session notes for future reference. ' +
    'Use this to record key facts, user preferences, decisions, or context ' +
    'that should be recalled later in the agent execution chain. Each note is timestamped.';
  readonly parameters = {
    type: 'object',
    properties: {
      content: {
        type: 'string',
        description: 'The information to record as a note. Be concise but specific.',
      },
      category: {
        type: 'string',
        description: "Optional category/tag for this note (e.g., 'user_preference', 'project_info', 'decision')",
      },
    },
    required: ['content'],
  };

  constructor(private readonly memoryFile: string = './workspace/.agent_memory.json') {}

  private loadFromFile(): NoteEntry[] {
    if (!fs.existsSync(this.memoryFile)) return [];
    try {
      return JSON.parse(fs.readFileSync(this.memoryFile, 'utf-8')) as NoteEntry[];
    } catch {
      return [];
    }
  }

  private saveToFile(notes: NoteEntry[]): void {
    fs.mkdirSync(path.dirname(this.memoryFile), { recursive: true });
    fs.writeFileSync(this.memoryFile, JSON.stringify(notes, null, 2), 'utf-8');
  }

  async execute({ content, category = 'general' }: RecordNoteInput): Promise<ToolResult> {
    try {
      const notes = this.loadFromFile();
      notes.push({ timestamp: new Date().toISOString(), category, content });
      this.saveToFile(notes);
      return { success: true, content: `Recorded note: ${content} (category: ${category})` };
    } catch (err) {
      return { success: false, content: '', error: `Failed to record note: ${String(err)}` };
    }
  }
}

// ============ RecallNoteTool (recall_notes) ============

interface RecallNotesInput extends Record<string, unknown> {
  category?: string;
}

export class RecallNoteTool implements Tool<RecallNotesInput> {
  readonly name = 'recall_notes';
  readonly description =
    'Recall all previously recorded session notes. ' +
    'Use this to retrieve important information, context, or decisions ' +
    'from earlier in the session or previous agent execution chains.';
  readonly parameters = {
    type: 'object',
    properties: {
      category: { type: 'string', description: 'Optional: filter notes by category' },
    },
  };

  constructor(private readonly memoryFile: string = './workspace/.agent_memory.json') {}

  async execute({ category }: RecallNotesInput): Promise<ToolResult> {
    try {
      if (!fs.existsSync(this.memoryFile)) {
        return { success: true, content: 'No notes recorded yet.' };
      }

      let notes = JSON.parse(fs.readFileSync(this.memoryFile, 'utf-8')) as NoteEntry[];

      if (!notes.length) return { success: true, content: 'No notes recorded yet.' };

      if (category) {
        notes = notes.filter((n) => n.category === category);
        if (!notes.length) {
          return { success: true, content: `No notes found in category: ${category}` };
        }
      }

      const formatted = notes.map((note, idx) =>
        `${idx + 1}. [${note.category}] ${note.content}\n   (recorded at ${note.timestamp})`,
      );

      return { success: true, content: 'Recorded Notes:\n' + formatted.join('\n') };
    } catch (err) {
      return { success: false, content: '', error: `Failed to recall notes: ${String(err)}` };
    }
  }
}
