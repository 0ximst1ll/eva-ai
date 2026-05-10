/**
 * ToolExecution component — visualizing tool call and result.
 */

import type { Component } from '../tui.js';
import { Colors } from '../../utils/terminal.js';
import { stripAnsi, truncate } from '../ansi.js';
import { Loader } from './loader.js';
import { Container } from '../tui.js';
import { Text } from './text.js';

export interface ToolExecutionOptions {
  toolName: string;
  args: Record<string, unknown>;
  onUpdate: () => void;
}

export class ToolExecution implements Component {
  private container = new Container();
  private loader: Loader;
  private header: Text;
  
  private finished = false;
  private success = false;
  private resultText = '';

  constructor(options: ToolExecutionOptions) {
    const formattedArgs = options.args && Object.keys(options.args).length > 0
      ? `(${JSON.stringify(options.args).slice(0, 50)}${JSON.stringify(options.args).length > 50 ? '...' : ''})`
      : '()';

    this.header = new Text({
      content: `${Colors.BRIGHT_YELLOW}🔧 Tool Call:${Colors.RESET} ${Colors.CYAN}${options.toolName}${Colors.RESET} ${Colors.DIM}${formattedArgs}${Colors.RESET}`
    });

    this.loader = new Loader({
      text: 'Executing...',
      onUpdate: options.onUpdate
    });

    this.container.addChild(this.header);
    this.container.addChild(this.loader);
    this.loader.start();
  }

  finish(success: boolean, resultText: string): void {
    if (this.finished) return;
    this.finished = true;
    this.success = success;
    this.resultText = resultText;

    this.container.removeChild(this.loader);
    this.loader.stop();

    const icon = success ? `${Colors.BRIGHT_GREEN}✓${Colors.RESET}` : `${Colors.BRIGHT_RED}✗${Colors.RESET}`;
    let displayResult = this.resultText.split('\n')[0];
    if (this.resultText.length > 80 || this.resultText.includes('\n')) {
      displayResult = displayResult.slice(0, 80) + '...';
    }

    this.container.addChild(new Text({
      content: `${icon} ${Colors.DIM}Result:${Colors.RESET} ${displayResult}`
    }));
  }

  invalidate(): void {
    this.container.invalidate();
  }

  render(width: number): string[] {
    return this.container.render(width);
  }
}
