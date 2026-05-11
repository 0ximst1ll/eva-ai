import type { Component, Focusable } from '../component.js';
import { CURSOR_MARKER } from '../tui.js';
import { matchesKey, isChar } from '../keys.js';
import { visibleWidth, wrapText } from '../utils.js';
import { KillRing } from '../kill-ring.js';
import { UndoStack } from '../undo-stack.js';

const MAX_HISTORY = 100;
const BRACKETED_PASTE_START = '\x1b[200~';
const BRACKETED_PASTE_END = '\x1b[201~';

interface InputState { lines: string[]; row: number; col: number; }

/**
 * Multi-line input component.
 * - Enter submits
 * - Shift+Enter / Ctrl+J inserts a newline
 * - Ctrl-Z undo, Ctrl-K/U kill to ring, Ctrl-Y yank
 * - Implements Focusable: only emits CURSOR_MARKER when focused
 */
export class MultilineInput implements Component, Focusable {
  focused = false;
  private lines: string[] = [''];
  private row = 0;
  private col = 0;

  private history: string[] = [];
  private historyIndex = -1;
  private savedValue = '';

  private killRing = new KillRing();
  private undoStack = new UndoStack<InputState>();
  private lastAction: 'kill' | 'yank' | null = null;

  private submitCbs: ((value: string) => void)[] = [];
  private changeCbs: ((value: string) => void)[] = [];
  private tui?: { requestRender: () => void };

  constructor(
    private placeholder = '',
    private prompt = '› ',
    private continuationPrompt = '… ',
  ) {}

  attachTui(tui: { requestRender: () => void }): void {
    this.tui = tui;
  }

  onSubmit(cb: (value: string) => void): void { this.submitCbs.push(cb); }
  onChange(cb: (value: string) => void): void { this.changeCbs.push(cb); }

  get value(): string { return this.lines.join('\n'); }

  setValue(val: string): void {
    this.lines = val.split('\n');
    if (this.lines.length === 0) this.lines = [''];
    this.row = this.lines.length - 1;
    this.col = this.lines[this.row].length;
    this.invalidate();
    this.tui?.requestRender();
  }

  clear(): void {
    this.lines = [''];
    this.row = 0;
    this.col = 0;
    this.historyIndex = -1;
    this.tui?.requestRender();
  }

  invalidate(): void {}

  handleInput(data: string): void {
    // Bracketed paste: insert entire content (may contain newlines)
    if (data.startsWith(BRACKETED_PASTE_START) && data.endsWith(BRACKETED_PASTE_END)) {
      const content = data.slice(BRACKETED_PASTE_START.length, data.length - BRACKETED_PASTE_END.length);
      for (const ch of content) {
        if (ch === '\n' || ch === '\r') {
          this.insertNewline();
        } else {
          this.insertChar(ch);
        }
      }
      this.fireChange();
      return;
    }

    // Submit on Enter (no modifier)
    if (data === '\r' || data === '\n') {
      const val = this.value;
      if (val.trim().length > 0) this.pushHistory(val);
      this.historyIndex = -1;
      for (const cb of this.submitCbs) cb(this.value);
      return;
    }

    // Newline insertion: Shift+Enter (\x1b[13;2u kitty), Ctrl+J (\x0a), or \x1b\r
    if (data === '\x0a' || data === '\x1b\r' || data === '\x1b[13;2u') {
      this.insertNewline();
      this.fireChange();
      return;
    }

    if (matchesKey(data, 'backspace')) {
      if (this.col > 0) {
        const line = this.lines[this.row];
        const before = [...line].slice(0, this.charIndex() - 1).join('');
        const after = line.slice(this.col);
        this.lines[this.row] = before + after;
        this.col = before.length;
      } else if (this.row > 0) {
        // Merge with previous line
        const prev = this.lines[this.row - 1];
        const curr = this.lines[this.row];
        this.lines.splice(this.row, 1);
        this.row--;
        this.col = prev.length;
        this.lines[this.row] = prev + curr;
      }
      this.fireChange();
      return;
    }

    if (matchesKey(data, 'delete')) {
      const line = this.lines[this.row];
      if (this.col < line.length) {
        const chars = [...line];
        const ci = this.charIndex();
        chars.splice(ci, 1);
        this.lines[this.row] = chars.join('');
      } else if (this.row < this.lines.length - 1) {
        // Merge next line
        this.lines[this.row] = line + this.lines[this.row + 1];
        this.lines.splice(this.row + 1, 1);
      }
      this.fireChange();
      return;
    }

    if (matchesKey(data, 'left') || matchesKey(data, 'ctrl-b')) {
      if (this.col > 0) this.col = this.prevCharBoundary();
      else if (this.row > 0) { this.row--; this.col = this.lines[this.row].length; }
      this.tui?.requestRender();
      return;
    }

    if (matchesKey(data, 'right') || matchesKey(data, 'ctrl-f')) {
      const line = this.lines[this.row];
      if (this.col < line.length) this.col = this.nextCharBoundary();
      else if (this.row < this.lines.length - 1) { this.row++; this.col = 0; }
      this.tui?.requestRender();
      return;
    }

    if (matchesKey(data, 'home') || matchesKey(data, 'ctrl-a')) {
      this.col = 0;
      this.tui?.requestRender();
      return;
    }

    if (matchesKey(data, 'end') || matchesKey(data, 'ctrl-e')) {
      this.col = this.lines[this.row].length;
      this.tui?.requestRender();
      return;
    }

    if (matchesKey(data, 'ctrl-k')) {
      const killed = this.lines[this.row].slice(this.col);
      this.killRing.push(killed, { accumulate: this.lastAction === 'kill' });
      this.lines[this.row] = this.lines[this.row].slice(0, this.col);
      this.lastAction = 'kill';
      this.saveUndo();
      this.fireChange();
      return;
    }

    if (matchesKey(data, 'ctrl-u')) {
      const killed = this.lines[this.row].slice(0, this.col);
      this.killRing.push(killed, { prepend: true, accumulate: this.lastAction === 'kill' });
      this.lines[this.row] = this.lines[this.row].slice(this.col);
      this.col = 0;
      this.lastAction = 'kill';
      this.saveUndo();
      this.fireChange();
      return;
    }

    if (matchesKey(data, 'ctrl-w')) {
      const before = this.lines[this.row].slice(0, this.col);
      const trimmed = before.replace(/\S+\s*$/, '');
      const killed = before.slice(trimmed.length);
      this.killRing.push(killed, { prepend: true, accumulate: this.lastAction === 'kill' });
      this.lines[this.row] = trimmed + this.lines[this.row].slice(this.col);
      this.col = trimmed.length;
      this.lastAction = 'kill';
      this.saveUndo();
      this.fireChange();
      return;
    }

    // Ctrl-Y: yank (paste from kill ring)
    if (data === '\x19') {
      const yanked = this.killRing.peek();
      if (yanked) {
        this.saveUndo();
        this.insertText(yanked);
        this.lastAction = 'yank';
        this.fireChange();
      }
      return;
    }

    // Ctrl-Z: undo
    if (data === '\x1a') {
      const prev = this.undoStack.pop();
      if (prev) {
        this.lines = prev.lines;
        this.row = prev.row;
        this.col = prev.col;
        this.lastAction = null;
        this.fireChange();
      }
      return;
    }

    if (matchesKey(data, 'up') || matchesKey(data, 'ctrl-p')) {
      if (this.row > 0) {
        this.row--;
        this.col = Math.min(this.col, this.lines[this.row].length);
        this.tui?.requestRender();
      } else {
        this.historyBack();
      }
      return;
    }

    if (matchesKey(data, 'down') || matchesKey(data, 'ctrl-n')) {
      if (this.row < this.lines.length - 1) {
        this.row++;
        this.col = Math.min(this.col, this.lines[this.row].length);
        this.tui?.requestRender();
      } else {
        this.historyForward();
      }
      return;
    }

    const ch = isChar(data);
    if (ch !== null) {
      this.lastAction = null;
      this.insertChar(ch);
      this.fireChange();
      return;
    }
  }

  private insertChar(ch: string): void {
    const line = this.lines[this.row];
    this.lines[this.row] = line.slice(0, this.col) + ch + line.slice(this.col);
    this.col += ch.length;
  }

  private insertText(text: string): void {
    for (const ch of text) {
      if (ch === '\n') this.insertNewline();
      else this.insertChar(ch);
    }
  }

  private saveUndo(): void {
    this.undoStack.push({ lines: [...this.lines], row: this.row, col: this.col });
  }

  render(width: number): string[] {
    const isEmpty = this.lines.length === 1 && this.lines[0].length === 0;
    const promptW = visibleWidth(this.prompt);
    const contW = visibleWidth(this.continuationPrompt);
    const result: string[] = [];

    for (let r = 0; r < this.lines.length; r++) {
      const pfx = r === 0 ? this.prompt : this.continuationPrompt;
      const pfxW = r === 0 ? promptW : contW;
      const innerW = Math.max(1, width - pfxW);
      const lineText = (isEmpty && r === 0)
        ? `\x1b[2m${this.placeholder}\x1b[0m`
        : this.lines[r];

      // Insert CURSOR_MARKER only when focused.
      // When empty: marker goes at column 0 (before placeholder) so the
      // hardware cursor sits at the start of the input, not after the hint text.
      let displayText: string;
      if (this.focused && r === this.row) {
        const before = this.lines[r].slice(0, this.col);
        const after = this.lines[r].slice(this.col);
        displayText = (isEmpty && r === 0)
          ? `${CURSOR_MARKER}\x1b[2m${this.placeholder}\x1b[0m`
          : `${before}${CURSOR_MARKER}${after}`;
      } else {
        displayText = lineText;
      }

      if (r === this.row) {
        result.push(`${pfx}${displayText}`);
      } else {
        const wrapped = wrapText(lineText, innerW);
        result.push(`${pfx}${wrapped[0] ?? ''}`);
        for (let i = 1; i < wrapped.length; i++) {
          result.push(`${' '.repeat(pfxW)}${wrapped[i]}`);
        }
      }
    }

    return result;
  }

  private insertNewline(): void {
    const line = this.lines[this.row];
    const before = line.slice(0, this.col);
    const after = line.slice(this.col);
    this.lines[this.row] = before;
    this.lines.splice(this.row + 1, 0, after);
    this.row++;
    this.col = 0;
    this.tui?.requestRender();
  }

  private fireChange(): void {
    this.historyIndex = -1;
    for (const cb of this.changeCbs) cb(this.value);
    this.tui?.requestRender();
  }

  private pushHistory(val: string): void {
    if (this.history.length > 0 && this.history[this.history.length - 1] === val) return;
    this.history.push(val);
    if (this.history.length > MAX_HISTORY) this.history.shift();
  }

  private historyBack(): void {
    if (this.history.length === 0) return;
    if (this.historyIndex === -1) {
      this.savedValue = this.value;
      this.historyIndex = this.history.length - 1;
    } else if (this.historyIndex > 0) {
      this.historyIndex--;
    } else return;
    this.setValue(this.history[this.historyIndex]);
    this.tui?.requestRender();
  }

  private historyForward(): void {
    if (this.historyIndex === -1) return;
    if (this.historyIndex < this.history.length - 1) {
      this.historyIndex++;
      this.setValue(this.history[this.historyIndex]);
    } else {
      this.historyIndex = -1;
      this.setValue(this.savedValue);
    }
    this.tui?.requestRender();
  }

  private charIndex(): number {
    return [...this.lines[this.row].slice(0, this.col)].length;
  }

  private prevCharBoundary(): number {
    const chars = [...this.lines[this.row].slice(0, this.col)];
    if (chars.length === 0) return 0;
    chars.pop();
    return chars.join('').length;
  }

  private nextCharBoundary(): number {
    const after = this.lines[this.row].slice(this.col);
    const chars = [...after];
    if (chars.length === 0) return this.lines[this.row].length;
    return this.col + chars[0].length;
  }
}
