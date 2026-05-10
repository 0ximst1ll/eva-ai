/**
 * Loader component — animated spinner.
 */

import type { Component } from '../tui.js';
import { Colors } from '../../utils/terminal.js';

export interface LoaderOptions {
  /** Optional text to display alongside the spinner */
  text?: string;
  /** Callback to trigger TUI re-render (since component animates itself) */
  onUpdate: () => void;
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SPINNER_INTERVAL_MS = 80;

export class Loader implements Component {
  private text: string;
  private onUpdate: () => void;
  private frameIndex = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private active = false;

  constructor(options: LoaderOptions) {
    this.text = options.text ?? 'Loading...';
    this.onUpdate = options.onUpdate;
  }

  setText(text: string): void {
    if (this.text === text) return;
    this.text = text;
    this.invalidate();
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    this.timer = setInterval(() => {
      this.frameIndex = (this.frameIndex + 1) % SPINNER_FRAMES.length;
      this.invalidate();
      this.onUpdate();
    }, SPINNER_INTERVAL_MS);
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  invalidate(): void {
    // Phase 1: simple enough, no heavy caching needed
  }

  render(width: number): string[] {
    if (!this.active) return [];
    const frame = SPINNER_FRAMES[this.frameIndex];
    // Truncate to width just in case
    const line = `${Colors.BRIGHT_CYAN}${frame}${Colors.RESET} ${Colors.DIM}${this.text}${Colors.RESET}`;
    return [line];
  }
}
