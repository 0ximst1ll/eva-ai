/**
 * Header component — full width title bar.
 */

import type { Component } from '../tui.js';
import { Colors } from '../../utils/terminal.js';
import { stripAnsi, truncate } from '../ansi.js';

export class Header implements Component {
  private title: string;

  constructor(title: string) {
    this.title = title;
  }

  handleInput(): void {}
  invalidate(): void {}

  render(width: number): string[] {
    const rawTitle = stripAnsi(this.title);
    const paddingLength = Math.max(0, width - rawTitle.length);
    const leftPad = Math.floor(paddingLength / 2);
    const rightPad = paddingLength - leftPad;

    const line = `${Colors.BG_BLUE}${Colors.BRIGHT_WHITE}${' '.repeat(leftPad)}${this.title}${' '.repeat(rightPad)}${Colors.RESET}`;
    
    return [
      truncate(line, width),
      '' // blank line below header
    ];
  }
}
