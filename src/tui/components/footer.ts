/**
 * Footer component — status bar at the bottom.
 */

import type { Component } from '../tui.js';
import { Colors } from '../../utils/terminal.js';
import { truncate, visibleWidth } from '../ansi.js';

export interface FooterStatus {
  model: string;
  tokens: number;
  session: string;
  step: number;
  maxSteps?: number | null;
}

export class Footer implements Component {
  private status: FooterStatus = {
    model: 'unknown',
    tokens: 0,
    session: '',
    step: 0,
  };

  setStatus(status: Partial<FooterStatus>) {
    this.status = { ...this.status, ...status };
  }

  handleInput(): void {}
  invalidate(): void {}

  render(width: number): string[] {
    const { model, tokens, session, step, maxSteps } = this.status;
    const tokensDisplay = tokens > 0 ? `${(tokens / 1000).toFixed(1)}k` : '0';
    
    let stepDisplay = `${step}`;
    if (maxSteps) stepDisplay += `/${maxSteps}`;

    // Sleek pi-mono/claude-code style footer: DIM text, dot separators, no background
    const content = `🤖 ${model}  •  🪙  ${tokensDisplay} tokens  •  🔄 Step ${stepDisplay}  •  🔑 ${session.slice(0, 8)}`;
    
    // Calculate visible length and right-align it
    const contentWidth = visibleWidth(content);
    const padding = Math.max(0, width - contentWidth);
    const line = `${Colors.DIM}${' '.repeat(padding)}${content}${Colors.RESET}`;

    return [
      '', // blank line spacer
      line
    ];
  }
}
