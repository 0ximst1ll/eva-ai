/**
 * Markdown component — renders markdown using marked AST + ANSI.
 */

import { marked } from 'marked';
import type { Component } from '../tui.js';
import { wrapText, stripAnsi } from '../ansi.js';
import { Colors } from '../../utils/terminal.js';

export interface MarkdownOptions {
  content: string;
}

export class Markdown implements Component {
  private content: string;
  private cachedLines: string[] | null = null;
  private cachedWidth = 0;

  constructor(options: MarkdownOptions) {
    this.content = options.content;
  }

  setContent(content: string): void {
    if (this.content === content) return;
    this.content = content;
    this.invalidate();
  }

  invalidate(): void {
    this.cachedLines = null;
    this.cachedWidth = 0;
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const tokens = marked.lexer(this.content);
    const lines: string[] = [];

    const renderInline = (tokens?: any[]): string => {
      if (!tokens) return '';
      let out = '';
      for (const token of tokens) {
        if (token.type === 'strong') {
          out += `${Colors.BOLD}${renderInline((token as any).tokens)}${Colors.RESET}`;
        } else if (token.type === 'em') {
          out += `${Colors.DIM}${renderInline((token as any).tokens)}${Colors.RESET}`;
        } else if (token.type === 'codespan') {
          out += `${Colors.BG_BLUE}${Colors.BRIGHT_WHITE} ${token.text} ${Colors.RESET}`;
        } else if (token.type === 'text' || token.type === 'escape') {
          out += token.text;
        } else if (token.type === 'link') {
          out += `${Colors.CYAN}${renderInline((token as any).tokens)}${Colors.RESET}`;
        } else if ((token as any).tokens) {
          out += renderInline((token as any).tokens);
        } else {
          out += token.raw;
        }
      }
      return out;
    };

    const pushWrapped = (text: string, prefix = '', indent = 0) => {
      const availableWidth = Math.max(10, width - indent - stripAnsi(prefix).length);
      const wrapped = wrapText(text, availableWidth);
      const indentStr = ' '.repeat(indent);
      for (let i = 0; i < wrapped.length; i++) {
        if (i === 0) {
          lines.push(`${indentStr}${prefix}${wrapped[i]}`);
        } else {
          const padding = ' '.repeat(stripAnsi(prefix).length);
          lines.push(`${indentStr}${padding}${wrapped[i]}`);
        }
      }
    };

    for (const token of tokens) {
      if (token.type === 'space') {
        lines.push('');
      } else if (token.type === 'heading') {
        const text = renderInline(token.tokens);
        pushWrapped(`${Colors.BOLD}${Colors.BRIGHT_WHITE}${text}${Colors.RESET}`);
        lines.push('');
      } else if (token.type === 'paragraph') {
        const text = renderInline(token.tokens);
        pushWrapped(text);
        lines.push('');
      } else if (token.type === 'list') {
        for (let i = 0; i < token.items.length; i++) {
          const item = token.items[i];
          const prefix = token.ordered ? `${i + 1}. ` : '• ';
          const text = renderInline(item.tokens);
          pushWrapped(text, prefix, 2);
        }
        lines.push('');
      } else if (token.type === 'code') {
        const lang = token.lang || 'text';
        lines.push(`${Colors.DIM}╭─ ${lang} ${'─'.repeat(Math.max(0, width - lang.length - 4))}${Colors.RESET}`);
        const codeLines = token.text.split('\n');
        for (const codeLine of codeLines) {
          // Just simple truncation for code blocks in Phase 1
          const truncated = codeLine.length > width - 4 ? codeLine.slice(0, width - 4) + '...' : codeLine;
          lines.push(`${Colors.DIM}│${Colors.RESET} ${truncated}`);
        }
        lines.push(`${Colors.DIM}╰${'─'.repeat(Math.max(0, width - 1))}${Colors.RESET}`);
        lines.push('');
      } else {
        // Fallback
        pushWrapped(token.raw);
      }
    }

    // Remove trailing empty line if it exists
    if (lines.length > 0 && lines[lines.length - 1] === '') {
      lines.pop();
    }

    this.cachedLines = lines;
    this.cachedWidth = width;
    return lines;
  }
}
