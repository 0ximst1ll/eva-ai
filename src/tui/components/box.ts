import type { Component } from '../component.js';
import { visibleWidth } from '../utils.js';

type BgFn = (text: string) => string;

interface Cache {
  childLines: string[];
  width: number;
  bgSample: string | undefined;
  lines: string[];
}

/**
 * Box — a container that applies optional padding and background to children.
 * Children render at (width - paddingX*2); output is padded to full width.
 */
export class Box implements Component {
  children: Component[] = [];
  private paddingX: number;
  private paddingY: number;
  private bgFn?: BgFn;
  private cache?: Cache;

  constructor(paddingX = 0, paddingY = 0, bgFn?: BgFn) {
    this.paddingX = paddingX;
    this.paddingY = paddingY;
    this.bgFn = bgFn;
  }

  addChild(c: Component): void { this.children.push(c); this.invalidate(); }

  removeChild(c: Component): void {
    const i = this.children.indexOf(c);
    if (i !== -1) { this.children.splice(i, 1); this.invalidate(); }
  }

  clear(): void { this.children = []; this.invalidate(); }

  setBgFn(fn?: BgFn): void { this.bgFn = fn; this.invalidate(); }

  invalidate(): void {
    this.cache = undefined;
    for (const c of this.children) c.invalidate();
  }

  render(width: number): string[] {
    if (this.children.length === 0) return [];

    const contentWidth = Math.max(1, width - this.paddingX * 2);
    const leftPad = ' '.repeat(this.paddingX);

    // Render children
    const childLines: string[] = [];
    for (const c of this.children) {
      for (const l of c.render(contentWidth)) {
        childLines.push(leftPad + l);
      }
    }
    if (childLines.length === 0) return [];

    const bgSample = this.bgFn?.('x');

    // Check cache
    if (
      this.cache &&
      this.cache.width === width &&
      this.cache.bgSample === bgSample &&
      this.cache.childLines.length === childLines.length &&
      this.cache.childLines.every((l, i) => l === childLines[i])
    ) {
      return this.cache.lines;
    }

    const emptyLine = this.applyBg(' '.repeat(width), width);
    const topBottom = Array.from({ length: this.paddingY }, () => emptyLine);

    const result = [
      ...topBottom,
      ...childLines.map((l) => this.applyBg(l, width)),
      ...topBottom,
    ];

    this.cache = { childLines, width, bgSample, lines: result };
    return result;
  }

  private applyBg(line: string, width: number): string {
    const pad = Math.max(0, width - visibleWidth(line));
    const padded = line + ' '.repeat(pad);
    return this.bgFn ? this.bgFn(padded) : padded;
  }
}
