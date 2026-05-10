/**
 * Editor component — single-line text input for Phase 0.
 */

import type { Component } from '../tui.js';
import { visibleWidth, stripAnsi } from '../ansi.js';
import { Colors } from '../../utils/terminal.js';

export interface EditorOptions {
  /** Prompt prefix (e.g. "You › ") */
  prompt?: string;
  /** Callback fired when Enter is pressed */
  onSubmit?: (text: string) => void;
  /** Callback for tab autocompletion */
  onAutocomplete?: (text: string) => string | undefined;
}

export class Editor implements Component {
  private prompt: string;
  private value = '';
  private cursorOffset = 0;
  private onSubmit?: (text: string) => void;
  private onAutocomplete?: (text: string) => string | undefined;
  private suggestion = '';

  constructor(options: EditorOptions = {}) {
    this.prompt = options.prompt ?? `${Colors.BRIGHT_GREEN}You${Colors.RESET} › `;
    this.onSubmit = options.onSubmit;
    this.onAutocomplete = options.onAutocomplete;
  }

  handleInput(data: string): void {
    // Basic ANSI escape sequence detection
    if (data.startsWith('\x1b[')) {
      if (data === '\x1b[D') { // Left arrow
        this.cursorOffset = Math.max(0, this.cursorOffset - 1);
        this.invalidate();
      } else if (data === '\x1b[C') { // Right arrow
        this.cursorOffset = Math.min(this.value.length, this.cursorOffset + 1);
        this.invalidate();
      }
      return;
    }

    // Tab autocomplete
    if (data === '\t' || data === '\x09') {
      if (this.suggestion && this.cursorOffset === this.value.length) {
        this.value += this.suggestion;
        this.cursorOffset = this.value.length;
        this.suggestion = '';
        this.invalidate();
      }
      return;
    }

    // Backspace (127 or 8)
    if (data === '\x7f' || data === '\x08') {
      if (this.cursorOffset > 0) {
        this.value =
          this.value.slice(0, this.cursorOffset - 1) +
          this.value.slice(this.cursorOffset);
        this.cursorOffset--;
        this.updateSuggestion();
        this.invalidate();
      }
      return;
    }

    // Enter / Return
    if (data === '\r' || data === '\n') {
      const text = this.value.trim();
      this.value = '';
      this.cursorOffset = 0;
      this.suggestion = '';
      this.invalidate();
      if (text && this.onSubmit) {
        this.onSubmit(text);
      }
      return;
    }

    // Printable characters
    const printable = data.replace(/[\x00-\x1F]/g, '');
    if (printable) {
      this.value =
        this.value.slice(0, this.cursorOffset) +
        printable +
        this.value.slice(this.cursorOffset);
      this.cursorOffset += printable.length;
      this.updateSuggestion();
      this.invalidate();
    }
  }

  private updateSuggestion() {
    if (this.onAutocomplete && this.cursorOffset === this.value.length) {
      this.suggestion = this.onAutocomplete(this.value) || '';
    } else {
      this.suggestion = '';
    }
  }

  invalidate(): void {}

  render(width: number): string[] {
    const promptLen = stripAnsi(this.prompt).length;
    const lines: string[] = [];
    
    // We insert a special marker for the cursor
    const CURSOR_MARKER = '\x00CURSOR\x00';
    let textWithCursor = this.value.slice(0, this.cursorOffset) + CURSOR_MARKER + this.value.slice(this.cursorOffset);
    
    // Manual wrap
    let currentLine = '';
    let currentWidth = promptLen;
    let isFirstLine = true;
    
    let i = 0;
    while (i < textWithCursor.length) {
      if (textWithCursor.startsWith(CURSOR_MARKER, i)) {
        currentLine += CURSOR_MARKER;
        i += CURSOR_MARKER.length;
        continue;
      }
      
      const char = textWithCursor[i];
      if (char === '\n') {
        lines.push(isFirstLine ? `${this.prompt}${currentLine}` : currentLine);
        currentLine = '';
        currentWidth = 0;
        isFirstLine = false;
        i++;
        continue;
      }
      
      if (currentWidth >= width) {
        lines.push(isFirstLine ? `${this.prompt}${currentLine}` : currentLine);
        currentLine = '';
        currentWidth = 0;
        isFirstLine = false;
      }
      
      currentLine += char;
      currentWidth += 1;
      i++;
    }
    
    lines.push(isFirstLine ? `${this.prompt}${currentLine}` : currentLine);
    
    // Now apply ANSI inversion for the cursor and add suggestion
    return lines.map((line, index) => {
      const isLastLine = index === lines.length - 1;
      let finalLine = line;

      const cursorIndex = finalLine.indexOf(CURSOR_MARKER);
      if (cursorIndex !== -1) {
        const before = finalLine.slice(0, cursorIndex);
        let afterMarker = finalLine.slice(cursorIndex + CURSOR_MARKER.length);
        
        if (afterMarker.length === 0) {
          finalLine = `${before}\x1b[7m \x1b[27m`; // Cursor at end of line
        } else {
          const at = afterMarker[0];
          const after = afterMarker.slice(1);
          finalLine = `${before}\x1b[7m${at}\x1b[27m${after}`;
        }
      }

      if (isLastLine && this.suggestion) {
        // If cursor is at the end, the space was inverted, so we append AFTER the inverted space
        finalLine += `${Colors.DIM}${this.suggestion}${Colors.RESET}`;
      }

      return finalLine;
    });
  }
}
