import type { Component, Focusable } from '../component.js';
import { CURSOR_MARKER } from '../tui.js';
import { matchesKey, isChar } from '../keys.js';
import { visibleWidth, truncateToWidth } from '../utils.js';

const MAX_HISTORY = 100;
const BRACKETED_PASTE_START = '\x1b[200~';
const BRACKETED_PASTE_END = '\x1b[201~';

export class Input implements Component, Focusable {
  focused = false;
  private _value = '';
  private cursor = 0; // byte offset into _value
  private history: string[] = [];
  private historyIndex = -1;
  private savedValue = '';

  private submitCallbacks: ((value: string) => void)[] = [];
  private changeCallbacks: ((value: string) => void)[] = [];
  private tui?: { requestRender: () => void };

  constructor(
    private placeholder = '',
    private prompt = '› ',
  ) {}

  /** Attach the TUI instance so input changes trigger re-renders */
  attachTui(tui: { requestRender: () => void }): void {
    this.tui = tui;
  }

  onSubmit(cb: (value: string) => void): void {
    this.submitCallbacks.push(cb);
  }

  onChange(cb: (value: string) => void): void {
    this.changeCallbacks.push(cb);
  }

  get value(): string {
    return this._value;
  }

  setValue(val: string): void {
    this._value = val;
    this.cursor = val.length;
    this.invalidate();
    this.tui?.requestRender();
  }

  clear(): void {
    this._value = '';
    this.cursor = 0;
    this.historyIndex = -1;
    this.invalidate();
    this.tui?.requestRender();
  }

  invalidate(): void {}

  handleInput(data: string): void {
    // Bracketed paste: insert content (strip newlines for single-line input)
    if (data.startsWith(BRACKETED_PASTE_START) && data.endsWith(BRACKETED_PASTE_END)) {
      const content = data
        .slice(BRACKETED_PASTE_START.length, data.length - BRACKETED_PASTE_END.length)
        .replace(/[\r\n]+/g, ' ');
      const before = this._value.slice(0, this.cursor);
      const after = this._value.slice(this.cursor);
      this._value = before + content + after;
      this.cursor += content.length;
      this.fireChange();
      return;
    }

    if (matchesKey(data, 'return')) {
      const val = this._value.trim();
      if (val.length > 0) {
        this.pushHistory(val);
      }
      this.historyIndex = -1;
      for (const cb of this.submitCallbacks) cb(this._value);
      return;
    }

    if (matchesKey(data, 'backspace')) {
      if (this.cursor > 0) {
        // Remove char before cursor (handle multi-byte)
        const before = [...this._value].slice(0, this.charIndexAt(this.cursor - 1));
        const after = this._value.slice(this.cursor);
        this._value = before.join('') + after;
        this.cursor = before.join('').length;
        this.fireChange();
      }
      return;
    }

    if (matchesKey(data, 'delete')) {
      if (this.cursor < this._value.length) {
        const chars = [...this._value];
        const ci = this.byteToCharIndex(this.cursor);
        chars.splice(ci, 1);
        this._value = chars.join('');
        this.fireChange();
      }
      return;
    }

    if (matchesKey(data, 'left')) {
      if (this.cursor > 0) {
        this.cursor = this.prevCharBoundary(this.cursor);
        this.tui?.requestRender();
      }
      return;
    }

    if (matchesKey(data, 'right')) {
      if (this.cursor < this._value.length) {
        this.cursor = this.nextCharBoundary(this.cursor);
        this.tui?.requestRender();
      }
      return;
    }

    if (matchesKey(data, 'home') || matchesKey(data, 'ctrl-a')) {
      this.cursor = 0;
      this.tui?.requestRender();
      return;
    }

    if (matchesKey(data, 'end') || matchesKey(data, 'ctrl-e')) {
      this.cursor = this._value.length;
      this.tui?.requestRender();
      return;
    }

    if (matchesKey(data, 'ctrl-k')) {
      // Kill to end of line
      this._value = this._value.slice(0, this.cursor);
      this.fireChange();
      return;
    }

    if (matchesKey(data, 'ctrl-u')) {
      // Kill to start of line
      this._value = this._value.slice(this.cursor);
      this.cursor = 0;
      this.fireChange();
      return;
    }

    if (matchesKey(data, 'ctrl-w')) {
      // Kill word before cursor
      const before = this._value.slice(0, this.cursor);
      const trimmed = before.replace(/\S+\s*$/, '');
      this._value = trimmed + this._value.slice(this.cursor);
      this.cursor = trimmed.length;
      this.fireChange();
      return;
    }

    if (matchesKey(data, 'ctrl-b')) {
      if (this.cursor > 0) {
        this.cursor = this.prevCharBoundary(this.cursor);
        this.tui?.requestRender();
      }
      return;
    }

    if (matchesKey(data, 'ctrl-f')) {
      if (this.cursor < this._value.length) {
        this.cursor = this.nextCharBoundary(this.cursor);
        this.tui?.requestRender();
      }
      return;
    }

    // History navigation
    if (matchesKey(data, 'up') || matchesKey(data, 'ctrl-p')) {
      this.historyBack();
      return;
    }

    if (matchesKey(data, 'down') || matchesKey(data, 'ctrl-n')) {
      this.historyForward();
      return;
    }

    // Printable character insertion
    const ch = isChar(data);
    if (ch !== null) {
      const before = this._value.slice(0, this.cursor);
      const after = this._value.slice(this.cursor);
      this._value = before + ch + after;
      this.cursor += ch.length;
      this.fireChange();
      return;
    }
  }

  render(width: number): string[] {
    const promptWidth = visibleWidth(this.prompt);
    const available = Math.max(1, width - promptWidth);
    const value = this._value || '';

    if (!this.focused) {
      // Not focused: render without cursor marker
      const showPlaceholder = value.length === 0;
      const display = showPlaceholder
        ? `\x1b[2m${truncateToWidth(this.placeholder, available)}\x1b[0m`
        : value;
      return [`${this.prompt}${display}`];
    }

    const beforeCursor = value.slice(0, this.cursor);
    const afterCursor = value.slice(this.cursor);
    const valueWidth = visibleWidth(value);
    let display: string;

    if (valueWidth <= available) {
      display = beforeCursor + CURSOR_MARKER + afterCursor;
    } else {
      const cursorCol = visibleWidth(beforeCursor);
      const scrollOffset = Math.max(0, cursorCol - available + 1);
      const visibleBefore = sliceByColumns(beforeCursor, scrollOffset, scrollOffset + available);
      display =
        visibleBefore +
        CURSOR_MARKER +
        sliceByColumns(afterCursor, 0, available - visibleWidth(visibleBefore));
    }

    const showPlaceholder = value.length === 0;
    const line = showPlaceholder
      ? `${this.prompt}\x1b[2m${truncateToWidth(this.placeholder, available)}\x1b[0m${CURSOR_MARKER}`
      : `${this.prompt}${display}`;

    return [line];
  }

  private fireChange(): void {
    this.historyIndex = -1;
    for (const cb of this.changeCallbacks) cb(this._value);
    this.tui?.requestRender();
  }

  private pushHistory(val: string): void {
    // Avoid duplicates at top
    if (this.history.length > 0 && this.history[this.history.length - 1] === val) return;
    this.history.push(val);
    if (this.history.length > MAX_HISTORY) this.history.shift();
  }

  private historyBack(): void {
    if (this.history.length === 0) return;
    if (this.historyIndex === -1) {
      this.savedValue = this._value;
      this.historyIndex = this.history.length - 1;
    } else if (this.historyIndex > 0) {
      this.historyIndex--;
    } else {
      return;
    }
    this._value = this.history[this.historyIndex];
    this.cursor = this._value.length;
    for (const cb of this.changeCallbacks) cb(this._value);
    this.tui?.requestRender();
  }

  private historyForward(): void {
    if (this.historyIndex === -1) return;
    if (this.historyIndex < this.history.length - 1) {
      this.historyIndex++;
      this._value = this.history[this.historyIndex];
    } else {
      this.historyIndex = -1;
      this._value = this.savedValue;
    }
    this.cursor = this._value.length;
    for (const cb of this.changeCallbacks) cb(this._value);
    this.tui?.requestRender();
  }

  // Convert byte offset to char index in the value string
  private byteToCharIndex(byteOffset: number): number {
    return [...this._value.slice(0, byteOffset)].length;
  }

  private charIndexAt(charIndex: number): number {
    return [...this._value].slice(0, charIndex).join('').length;
  }

  private prevCharBoundary(byteOffset: number): number {
    // Step back one Unicode scalar
    const before = this._value.slice(0, byteOffset);
    const chars = [...before];
    if (chars.length === 0) return 0;
    chars.pop();
    return chars.join('').length;
  }

  private nextCharBoundary(byteOffset: number): number {
    const after = this._value.slice(byteOffset);
    const chars = [...after];
    if (chars.length === 0) return this._value.length;
    return byteOffset + chars[0].length;
  }
}

// Slice a string (with ANSI) to [startCol, endCol) visible columns
function sliceByColumns(str: string, startCol: number, endCol: number): string {
  const SEGMENT_RE = /(\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])|[\s\S])/g;
  let result = '';
  let col = 0;
  let activeAnsi = '';
  let match: RegExpExecArray | null;

  while ((match = SEGMENT_RE.exec(str)) !== null) {
    const seg = match[1];
    if (seg.startsWith('\x1b')) {
      if (col >= startCol && col < endCol) result += seg;
      if (seg === '\x1b[0m' || seg === '\x1b[m') activeAnsi = '';
      else activeAnsi += seg;
      continue;
    }
    const w = visibleWidth(seg);
    if (col + w > startCol && col < endCol) {
      if (col < startCol && result.length === 0) result = activeAnsi;
      result += seg;
    }
    col += w;
    if (col >= endCol) break;
  }

  return result;
}
