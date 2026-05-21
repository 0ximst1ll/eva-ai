import type { Component } from '../component.js';

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const INTERVAL_MS = 80;

export class Spinner implements Component {
  private frame = 0;
  private timer: NodeJS.Timeout | undefined;
  private tui?: { requestRender: () => void };
  private _label: string;

  constructor(label = '') {
    this._label = label;
  }

  get label(): string { return this._label; }
  set label(v: string) { this._label = v; }

  attachTui(tui: { requestRender: () => void }): void {
    this.tui = tui;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.frame = (this.frame + 1) % FRAMES.length;
      this.tui?.requestRender();
    }, INTERVAL_MS);
    // Allow process to exit even while spinner is running
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  invalidate(): void {}

  render(_width: number): string[] {
    const icon = FRAMES[this.frame];
    return [`\x1b[33m${icon}\x1b[0m ${this._label}`];
  }
}
