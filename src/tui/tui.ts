import { Container, isFocusable, type Component } from './component.js';
import { ProcessTerminal } from './terminal.js';
import { visibleWidth } from './utils.js';

const MIN_RENDER_INTERVAL_MS = 16;

// APC sequence: terminals ignore it visually. Components embed this at the
// cursor position when focused; TUI strips it and moves hardware cursor there.
export const CURSOR_MARKER = '\x1b_eva:c\x07';

// Appended to every rendered line to reset all SGR attributes and close any
// open OSC8 hyperlink. Prevents ANSI color/style from bleeding into the next line.
const LINE_RESET = '\x1b[0m\x1b]8;;\x07';

export class TUI extends Container {
  private terminal: ProcessTerminal;
  private previousLines: string[] = [];
  private previousWidth = 0;
  private previousHeight = 0;
  private renderRequested = false;
  private renderTimer: NodeJS.Timeout | undefined;
  private lastRenderAt = 0;
  private focusedComponent: Component | null = null;
  private cleanupFns: (() => void)[] = [];
  private stopped = false;
  // cursorRow: logical end-of-content row (buffer index).
  private cursorRow = 0;
  // hardwareCursorRow: actual terminal cursor row (buffer index).
  private hardwareCursorRow = 0;
  // maxLinesRendered: high-water mark for clearing orphaned rows on shrink.
  private maxLinesRendered = 0;
  // clearOnShrink: when content shrinks, issue a full redraw to erase empty rows.
  private clearOnShrink = true;

  constructor(terminal: ProcessTerminal) {
    super();
    this.terminal = terminal;
    const offData = terminal.onData((data) => this.handleInput(data));
    const offResize = terminal.onResize(() => this.handleResize());
    this.cleanupFns.push(offData, offResize);
  }

  setClearOnShrink(enabled: boolean): void {
    this.clearOnShrink = enabled;
  }

  setFocus(component: Component | null): void {
    if (isFocusable(this.focusedComponent)) this.focusedComponent.focused = false;
    this.focusedComponent = component;
    if (isFocusable(component)) component.focused = true;
    this.requestRender();
  }

  getFocus(): Component | null {
    return this.focusedComponent;
  }

  requestRender(force = false): void {
    if (this.stopped) return;
    if (force) {
      this.cancelRenderTimer();
      this.doRender();
      return;
    }
    if (this.renderRequested) return;
    this.renderRequested = true;
    const delay = Math.max(0, MIN_RENDER_INTERVAL_MS - (Date.now() - this.lastRenderAt));
    this.renderTimer = setTimeout(() => {
      this.renderTimer = undefined;
      this.renderRequested = false;
      this.doRender();
    }, delay);
  }

  private cancelRenderTimer(): void {
    if (this.renderTimer !== undefined) {
      clearTimeout(this.renderTimer);
      this.renderTimer = undefined;
      this.renderRequested = false;
    }
  }

  private handleInput(data: string): void {
    if (this.stopped) return;
    this.focusedComponent?.handleInput?.(data);
  }

  private handleResize(): void {
    this.previousWidth = 0;
    this.previousHeight = 0;
    this.requestRender(true);
  }

  private doRender(): void {
    if (this.stopped) return;
    this.lastRenderAt = Date.now();

    const { columns: width, rows: height } = this.terminal.getSize();
    const widthChanged = this.previousWidth !== 0 && this.previousWidth !== width;
    const heightChanged = this.previousHeight !== 0 && this.previousHeight !== height;

    // Render → extract cursor position → apply line resets
    let newLines = this.render(width);
    const cursorPos = this.extractCursorPosition(newLines);
    newLines = applyLineResets(newLines);

    // ── Full render ────────────────────────────────────────────────────────
    const fullRender = (clear: boolean): void => {
      let buf = '\x1b[?2026h';
      if (clear) buf += '\x1b[2J\x1b[H\x1b[3J';
      for (let i = 0; i < newLines.length; i++) {
        if (i > 0) buf += '\r\n';
        buf += newLines[i];
      }
      buf += '\x1b[?2026l';
      this.terminal.write(buf);
      this.cursorRow = Math.max(0, newLines.length - 1);
      this.hardwareCursorRow = this.cursorRow;
      this.maxLinesRendered = clear ? newLines.length : Math.max(this.maxLinesRendered, newLines.length);
      this.previousLines = newLines;
      this.previousWidth = width;
      this.previousHeight = height;
      this.positionHardwareCursor(cursorPos, newLines.length);
    };

    // First render: write in-place without clearing (cursor is at current shell position)
    if (this.previousLines.length === 0 && !widthChanged && !heightChanged) {
      fullRender(false);
      return;
    }

    if (widthChanged) { fullRender(true); return; }
    if (heightChanged) { fullRender(true); return; }

    // Content shrank below the previous high-water mark — clear orphaned rows
    if (this.clearOnShrink && newLines.length < this.maxLinesRendered) {
      fullRender(true);
      return;
    }

    // ── Differential render ────────────────────────────────────────────────
    let firstChanged = -1;
    let lastChanged = -1;
    const maxLen = Math.max(newLines.length, this.previousLines.length);
    for (let i = 0; i < maxLen; i++) {
      const oldLine = this.previousLines[i] ?? '';
      const newLine = newLines[i] ?? '';
      if (oldLine !== newLine) {
        if (firstChanged === -1) firstChanged = i;
        lastChanged = i;
      }
    }
    if (newLines.length > this.previousLines.length) {
      if (firstChanged === -1) firstChanged = this.previousLines.length;
      lastChanged = newLines.length - 1;
    }

    // Nothing changed
    if (firstChanged === -1) {
      this.positionHardwareCursor(cursorPos, newLines.length);
      return;
    }

    // firstChanged is above the current viewport — full redraw required
    const viewportTop = Math.max(0, this.cursorRow - height + 1);
    if (firstChanged < viewportTop) {
      fullRender(true);
      return;
    }

    // ── Build differential buffer ──────────────────────────────────────────
    let buf = '\x1b[?2026h';

    const rowDelta = firstChanged - this.hardwareCursorRow;
    if (rowDelta > 0) buf += `\x1b[${rowDelta}B`;
    else if (rowDelta < 0) buf += `\x1b[${-rowDelta}A`;
    buf += '\r';

    const renderEnd = Math.min(lastChanged, newLines.length - 1);
    for (let i = firstChanged; i <= renderEnd; i++) {
      if (i > firstChanged) buf += '\r\n';
      buf += `\x1b[2K${newLines[i]}`;
    }
    let finalCursorRow = renderEnd;

    // Clear orphaned lines if buffer shrank
    if (this.previousLines.length > newLines.length) {
      if (renderEnd < newLines.length - 1) {
        buf += `\x1b[${newLines.length - 1 - renderEnd}B`;
        finalCursorRow = newLines.length - 1;
      }
      const extra = this.previousLines.length - newLines.length;
      for (let i = 0; i < extra; i++) buf += '\r\n\x1b[2K';
      buf += `\x1b[${extra}A`;
    }

    buf += '\x1b[?2026l';
    this.terminal.write(buf);

    this.cursorRow = Math.max(0, newLines.length - 1);
    this.hardwareCursorRow = finalCursorRow;
    this.maxLinesRendered = Math.max(this.maxLinesRendered, newLines.length);
    this.previousLines = newLines;
    this.previousWidth = width;
    this.previousHeight = height;

    this.positionHardwareCursor(cursorPos, newLines.length);
  }

  private extractCursorPosition(lines: string[]): { row: number; col: number } | null {
    for (let row = 0; row < lines.length; row++) {
      const idx = lines[row].indexOf(CURSOR_MARKER);
      if (idx === -1) continue;
      const col = visibleWidth(lines[row].slice(0, idx));
      return { row, col };
    }
    return null;
  }

  private positionHardwareCursor(
    cursorPos: { row: number; col: number } | null,
    totalLines: number,
  ): void {
    if (!cursorPos || totalLines === 0) {
      this.terminal.hideCursor();
      return;
    }
    const targetRow = Math.max(0, Math.min(cursorPos.row, totalLines - 1));
    const rowDelta = targetRow - this.hardwareCursorRow;
    let buf = '';
    if (rowDelta > 0) buf += `\x1b[${rowDelta}B`;
    else if (rowDelta < 0) buf += `\x1b[${-rowDelta}A`;
    buf += `\x1b[${cursorPos.col + 1}G`; // absolute column (1-indexed)
    if (buf) this.terminal.write(buf);
    this.hardwareCursorRow = targetRow;
    this.terminal.showCursor();
  }

  start(): void {
    this.terminal.enableRawMode();
    this.terminal.hideCursor();
    this.requestRender();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.cancelRenderTimer();
    this.terminal.showCursor();
    this.terminal.disableRawMode();
    this.terminal.write('\r\n');
    for (const fn of this.cleanupFns) fn();
    this.terminal.destroy();
  }
}

// Strip CURSOR_MARKER and append LINE_RESET to every rendered line.
function applyLineResets(lines: string[]): string[] {
  return lines.map((line) => line.replaceAll(CURSOR_MARKER, '') + LINE_RESET);
}
