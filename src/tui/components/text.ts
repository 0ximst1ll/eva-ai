import type { Component } from '../component.js';
import { wrapText, padToWidth } from '../utils.js';

export interface TextOptions {
  wrap?: boolean;
  dim?: boolean;
  color?: string;   // ANSI prefix (e.g. '\x1b[32m')
  paddingX?: number;
  bold?: boolean;
}

export class Text implements Component {
  private cache: { text: string; width: number; lines: string[] } | null = null;

  constructor(
    private _text: string,
    private options: TextOptions = {},
  ) {}

  get text(): string {
    return this._text;
  }

  set text(value: string) {
    if (this._text !== value) {
      this._text = value;
      this.invalidate();
    }
  }

  append(chunk: string): void {
    this._text += chunk;
    this.invalidate();
  }

  invalidate(): void {
    this.cache = null;
  }

  render(width: number): string[] {
    if (this.cache && this.cache.text === this._text && this.cache.width === width) {
      return this.cache.lines;
    }

    const px = this.options.paddingX ?? 0;
    const innerWidth = Math.max(1, width - px * 2);
    const pad = ' '.repeat(px);

    let content = this._text;

    // Apply color/bold prefix
    let prefix = '';
    let suffix = '';
    if (this.options.bold) prefix += '\x1b[1m', suffix = '\x1b[0m';
    if (this.options.dim) prefix += '\x1b[2m', suffix = '\x1b[0m';
    if (this.options.color) prefix += this.options.color, suffix = '\x1b[0m';

    const wrapped = (this.options.wrap !== false)
      ? wrapText(content, innerWidth)
      : [content];

    const lines = wrapped.map((line) => {
      const rendered = prefix ? `${prefix}${line}${suffix}` : line;
      return px > 0 ? `${pad}${rendered}${pad}` : rendered;
    });

    this.cache = { text: this._text, width, lines };
    return lines;
  }
}

// Convenience: a horizontal separator line
export class Separator implements Component {
  constructor(private char = '─', private color = '\x1b[2m') {}

  invalidate(): void {}

  render(width: number): string[] {
    return [`${this.color}${this.char.repeat(width)}\x1b[0m`];
  }
}

// Convenience: blank spacer of N lines
export class Spacer implements Component {
  constructor(private lines = 1) {}

  invalidate(): void {}

  render(_width: number): string[] {
    return Array(this.lines).fill('');
  }
}
