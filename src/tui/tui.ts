/**
 * TUI engine with differential rendering.
 * Inspired by pi-mono's tui.ts — simplified for Eva AI Phase 0.
 *
 * Core design:
 *   Component.render(width) → string[]
 *   Container stacks children vertically
 *   TUI extends Container, adds differential rendering + input routing
 */

import { performance } from 'node:perf_hooks';
import type { Terminal } from './terminal.js';

/**
 * Component interface — all TUI components must implement this.
 */
export interface Component {
  /**
   * Render the component to lines for the given viewport width.
   * @param width - Current viewport width
   * @returns Array of strings, each representing a rendered line
   */
  render(width: number): string[];

  /** Optional handler for keyboard input when component has focus. */
  handleInput?(data: string): void;

  /** Invalidate any cached rendering state. */
  invalidate(): void;
}

/**
 * Container — a component that stacks children vertically.
 */
export class Container implements Component {
  children: Component[] = [];

  addChild(component: Component): void {
    this.children.push(component);
  }

  removeChild(component: Component): void {
    const index = this.children.indexOf(component);
    if (index !== -1) {
      this.children.splice(index, 1);
    }
  }

  clear(): void {
    this.children = [];
  }

  invalidate(): void {
    for (const child of this.children) {
      child.invalidate();
    }
  }

  render(width: number): string[] {
    const lines: string[] = [];
    for (const child of this.children) {
      const childLines = child.render(width);
      for (const line of childLines) {
        lines.push(line);
      }
    }
    return lines;
  }
}

/**
 * TUI — Main class for terminal UI with differential rendering.
 *
 * Extends Container to hold base content. Manages:
 * - Differential rendering (only update changed lines)
 * - 16ms render throttling
 * - Input routing to focused component
 * - Viewport scrolling (content taller than terminal)
 */
export class TUI extends Container {
  public terminal: Terminal;

  private previousLines: string[] = [];
  private previousWidth = 0;
  private focusedComponent: Component | null = null;

  private renderRequested = false;
  private renderTimer: ReturnType<typeof setTimeout> | undefined;
  private lastRenderAt = 0;
  private static readonly MIN_RENDER_INTERVAL_MS = 16;

  private cursorRow = 0;
  private stopped = false;

  constructor(terminal: Terminal) {
    super();
    this.terminal = terminal;
  }

  /** Set which component receives keyboard input. */
  setFocus(component: Component | null): void {
    this.focusedComponent = component;
  }

  /** Start the TUI — enter raw mode, begin rendering. */
  start(): void {
    this.stopped = false;
    this.terminal.start(
      (data) => this.handleInput(data),
      () => this.requestRender(),
    );
    this.terminal.hideCursor();
    this.requestRender();
  }

  /** Stop the TUI — exit raw mode, restore terminal. */
  stop(): void {
    this.stopped = true;
    if (this.renderTimer) {
      clearTimeout(this.renderTimer);
      this.renderTimer = undefined;
    }
    // Move cursor past rendered content
    if (this.previousLines.length > 0) {
      const targetRow = this.previousLines.length;
      const diff = targetRow - this.cursorRow;
      if (diff > 0) {
        this.terminal.moveBy(diff);
      }
      this.terminal.write('\r\n');
    }
    this.terminal.showCursor();
    this.terminal.stop();
  }

  /** Request a render on the next frame. */
  requestRender(): void {
    if (this.renderRequested) return;
    this.renderRequested = true;
    process.nextTick(() => this.scheduleRender());
  }

  private scheduleRender(): void {
    if (this.stopped || this.renderTimer || !this.renderRequested) {
      return;
    }
    const elapsed = performance.now() - this.lastRenderAt;
    const delay = Math.max(0, TUI.MIN_RENDER_INTERVAL_MS - elapsed);
    this.renderTimer = setTimeout(() => {
      this.renderTimer = undefined;
      if (this.stopped || !this.renderRequested) {
        return;
      }
      this.renderRequested = false;
      this.lastRenderAt = performance.now();
      this.doRender();
      if (this.renderRequested) {
        this.scheduleRender();
      }
    }, delay);
  }

  private handleInput(data: string): void {
    // Ctrl+C — exit
    if (data === '\x03') {
      this.stop();
      process.exit(0);
    }

    // Forward to focused component
    if (this.focusedComponent?.handleInput) {
      this.focusedComponent.handleInput(data);
      this.requestRender();
    }
  }

  /**
   * Core differential rendering.
   *
   * Strategy:
   * 1. Render all components → string[]
   * 2. Keep only the bottom `termHeight` lines as viewport
   * 3. Compare each visible line with previousLines
   * 4. Only write changed lines using cursor movement
   */
  private previousViewportTop = 0;
  private maxLinesRendered = 0;

  private doRender(): void {
    if (this.stopped) return;

    const width = this.terminal.columns;
    const height = this.terminal.rows;
    const widthChanged = this.previousWidth !== 0 && this.previousWidth !== width;

    let newLines = this.render(width);

    // Initial render or width change
    if (this.previousLines.length === 0 || widthChanged) {
      let output = '\x1b[?2026h';
      if (widthChanged) output += '\x1b[2J\x1b[H';
      for (let i = 0; i < newLines.length; i++) {
        if (i > 0) output += '\r\n';
        output += newLines[i];
      }
      output += '\x1b[?2026l';
      this.terminal.write(output);
      this.cursorRow = Math.max(0, newLines.length - 1);
      this.previousLines = newLines;
      this.previousWidth = width;
      this.maxLinesRendered = newLines.length;
      this.previousViewportTop = Math.max(0, newLines.length - height);
      return;
    }

    // Find first and last changed
    let firstChanged = -1;
    let lastChanged = -1;
    const maxLines = Math.max(newLines.length, this.previousLines.length);
    for (let i = 0; i < maxLines; i++) {
      const oldLine = i < this.previousLines.length ? this.previousLines[i] : '';
      const newLine = i < newLines.length ? newLines[i] : '';
      if (oldLine !== newLine) {
        if (firstChanged === -1) firstChanged = i;
        lastChanged = i;
      }
    }

    if (firstChanged === -1) return;

    // Full redraw if changed line is off-screen
    if (firstChanged < this.previousViewportTop) {
      let output = '\x1b[?2026h\x1b[2J\x1b[H';
      for (let i = 0; i < newLines.length; i++) {
        if (i > 0) output += '\r\n';
        output += newLines[i];
      }
      output += '\x1b[?2026l';
      this.terminal.write(output);
      this.cursorRow = Math.max(0, newLines.length - 1);
      this.previousLines = newLines;
      this.previousWidth = width;
      this.previousViewportTop = Math.max(0, newLines.length - height);
      return;
    }

    let output = '\x1b[?2026h';
    let hardwareCursorRow = this.cursorRow;

    for (let i = firstChanged; i <= lastChanged; i++) {
      const targetScreenRow = i - this.previousViewportTop;
      const currentScreenRow = hardwareCursorRow - this.previousViewportTop;
      const rowDiff = targetScreenRow - currentScreenRow;

      if (rowDiff > 0) {
        if (i >= this.previousLines.length) {
          // New lines added at the bottom, trigger natural terminal scroll
          output += '\r\n'.repeat(rowDiff);
          this.previousViewportTop += Math.max(0, i - (this.previousViewportTop + height - 1));
        } else {
          output += `\x1b[${rowDiff}B`;
        }
      } else if (rowDiff < 0) {
        output += `\x1b[${-rowDiff}A`;
      }
      
      const line = i < newLines.length ? newLines[i] : '';
      output += `\r\x1b[K${line}\x1b[0m`;
      hardwareCursorRow = i;
    }

    // Clear extra lines if newLines is shorter
    if (newLines.length < this.previousLines.length) {
      for (let i = newLines.length; i < this.previousLines.length; i++) {
        const rowDiff = (i - this.previousViewportTop) - (hardwareCursorRow - this.previousViewportTop);
        if (rowDiff > 0) output += `\x1b[${rowDiff}B`;
        else if (rowDiff < 0) output += `\x1b[${-rowDiff}A`;
        output += '\r\x1b[K';
        hardwareCursorRow = i;
      }
      // Move cursor back
      const targetRow = Math.max(0, newLines.length - 1);
      const backDiff = targetRow - hardwareCursorRow;
      if (backDiff < 0) output += `\x1b[${-backDiff}A`;
      else if (backDiff > 0) output += `\x1b[${backDiff}B`;
      hardwareCursorRow = targetRow;
    }

    output += '\x1b[?2026l';
    this.terminal.write(output);
    this.cursorRow = hardwareCursorRow;
    this.previousLines = newLines;
    this.previousWidth = width;
  }
}
