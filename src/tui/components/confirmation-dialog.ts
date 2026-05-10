/**
 * ConfirmationDialog component — interactive dialog for tool confirmation.
 */

import type { Component } from '../tui.js';
import { Colors } from '../../utils/terminal.js';
import { wrapText } from '../ansi.js';
import { Container } from '../tui.js';
import { Text } from './text.js';

export interface ConfirmationDialogOptions {
  toolName: string;
  category: string;
  riskLevel: string;
  args: Record<string, unknown>;
  onResolve: (approved: boolean) => void;
  onUpdate: () => void;
}

export class ConfirmationDialog implements Component {
  private container = new Container();
  private onResolve: (approved: boolean) => void;
  private onUpdate: () => void;
  private resolved = false;

  constructor(options: ConfirmationDialogOptions) {
    this.onResolve = options.onResolve;
    this.onUpdate = options.onUpdate;

    // Header
    this.container.addChild(new Text({
      content: `\n${Colors.BG_YELLOW}${Colors.BRIGHT_BLACK} ⚠️ TOOL REQUIRES CONFIRMATION ${Colors.RESET}\n`
    }));

    // Details
    this.container.addChild(new Text({
      content: `${Colors.BOLD}${Colors.CYAN}${options.toolName}${Colors.RESET}`
    }));
    this.container.addChild(new Text({
      content: `${Colors.DIM}Category: ${options.category} | Risk: ${options.riskLevel}${Colors.RESET}`
    }));

    // Arguments
    let argsDisplay = options.args ? JSON.stringify(options.args, null, 2) : '()';
    if (argsDisplay.length > 300) {
      argsDisplay = argsDisplay.slice(0, 300) + '...';
    }
    this.container.addChild(new Text({
      content: `${Colors.DIM}${argsDisplay}${Colors.RESET}\n`
    }));

    // Prompt
    this.container.addChild(new Text({
      content: `${Colors.BRIGHT_YELLOW}Allow this tool call? [y/N]${Colors.RESET}`
    }));
  }

  handleInput(data: string): void {
    if (this.resolved) return;

    const lower = data.toLowerCase().trim();
    if (lower === 'y' || lower === 'yes') {
      this.resolved = true;
      this.onResolve(true);
    } else if (lower === 'n' || lower === 'no' || data === '\r' || data === '\n') {
      // Default to No on Enter
      this.resolved = true;
      this.onResolve(false);
    } else if (data === '\x03') { // Ctrl+C
      this.resolved = true;
      this.onResolve(false);
    }
    
    // We don't echo invalid characters, just wait for y/n/enter
    this.onUpdate();
  }

  invalidate(): void {
    this.container.invalidate();
  }

  render(width: number): string[] {
    return this.container.render(width);
  }
}
