/**
 * Text component — renders styled text lines.
 */

import type { Component } from '../tui.js';
import { wrapText } from '../ansi.js';

export interface TextOptions {
  /** Text content (may contain newlines). */
  content: string;
  /** Optional ANSI style prefix applied to each line. */
  style?: string;
}

/**
 * Simple text display component.
 * Wraps content to viewport width and applies optional ANSI styling.
 */
export class Text implements Component {
  private content: string;
  private style: string;
  private cachedLines: string[] | null = null;
  private cachedWidth = 0;

  constructor(options: TextOptions) {
    this.content = options.content;
    this.style = options.style ?? '';
  }

  /** Update text content and trigger re-render. */
  setContent(content: string): void {
    if (this.content === content) return;
    this.content = content;
    this.invalidate();
  }

  /** Update style and trigger re-render. */
  setStyle(style: string): void {
    if (this.style === style) return;
    this.style = style;
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

    const wrapped = wrapText(this.content, width);
    const reset = '\x1b[0m';

    if (this.style) {
      this.cachedLines = wrapped.map((line) => `${this.style}${line}${reset}`);
    } else {
      this.cachedLines = wrapped;
    }

    this.cachedWidth = width;
    return this.cachedLines;
  }
}
