import { StdinBuffer } from './stdin-buffer.js';

export interface TerminalSize {
  columns: number;
  rows: number;
}

export class ProcessTerminal {
  private stdinBuffer = new StdinBuffer();
  private dataListeners: ((data: string) => void)[] = [];
  private resizeListeners: (() => void)[] = [];
  private rawModeEnabled = false;

  constructor() {
    process.stdin.on('data', (chunk: Buffer) => {
      this.stdinBuffer.push(chunk.toString('utf8'));
    });

    this.stdinBuffer.on('data', (seq: string) => {
      for (const fn of this.dataListeners) fn(seq);
    });

    process.stdout.on('resize', () => {
      for (const fn of this.resizeListeners) fn();
    });
  }

  enableRawMode(): void {
    if (this.rawModeEnabled) return;
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      process.stdin.resume();
    }
    // Enable bracketed paste: terminal wraps pastes in \x1b[200~ ... \x1b[201~
    process.stdout.write('\x1b[?2004h');
    this.rawModeEnabled = true;
  }

  disableRawMode(): void {
    if (!this.rawModeEnabled) return;
    process.stdout.write('\x1b[?2004l');
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    this.rawModeEnabled = false;
  }

  hideCursor(): void {
    process.stdout.write('\x1b[?25l');
  }

  showCursor(): void {
    process.stdout.write('\x1b[?25h');
  }

  write(data: string): void {
    process.stdout.write(data);
  }

  getSize(): TerminalSize {
    return {
      columns: process.stdout.columns || 80,
      rows: process.stdout.rows || 24,
    };
  }

  onData(cb: (data: string) => void): () => void {
    this.dataListeners.push(cb);
    return () => {
      this.dataListeners = this.dataListeners.filter((fn) => fn !== cb);
    };
  }

  onResize(cb: () => void): () => void {
    this.resizeListeners.push(cb);
    return () => {
      this.resizeListeners = this.resizeListeners.filter((fn) => fn !== cb);
    };
  }

  destroy(): void {
    this.showCursor();
    this.disableRawMode();
    this.stdinBuffer.destroy();
    this.dataListeners = [];
    this.resizeListeners = [];
  }
}
