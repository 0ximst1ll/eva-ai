/**
 * Terminal abstraction for TUI rendering.
 * Simplified from pi-mono's terminal.ts — no Kitty protocol, no image support.
 */

/**
 * Minimal terminal interface for TUI.
 * Implementations must manage raw mode, stdin/stdout, and cursor control.
 */
export interface Terminal {
  /** Start the terminal with input and resize handlers. */
  start(onInput: (data: string) => void, onResize: () => void): void;

  /** Stop the terminal and restore state. */
  stop(): void;

  /** Write output to terminal. */
  write(data: string): void;

  /** Terminal width in columns. */
  get columns(): number;

  /** Terminal height in rows. */
  get rows(): number;

  /** Move cursor up (negative) or down (positive) by N lines. */
  moveBy(lines: number): void;

  /** Hide the cursor. */
  hideCursor(): void;

  /** Show the cursor. */
  showCursor(): void;

  /** Clear current line from cursor to end. */
  clearLine(): void;

  /** Clear from cursor to end of screen. */
  clearFromCursor(): void;

  /** Clear entire screen and move cursor to (0,0). */
  clearScreen(): void;

  /** Set terminal window title. */
  setTitle(title: string): void;
}

/**
 * Real terminal using process.stdin/stdout.
 */
export class ProcessTerminal implements Terminal {
  private wasRaw = false;
  private inputHandler?: (data: string) => void;
  private resizeHandler?: () => void;
  private dataHandler?: (data: Buffer) => void;

  start(onInput: (data: string) => void, onResize: () => void): void {
    this.inputHandler = onInput;
    this.resizeHandler = onResize;

    // Save previous state and enable raw mode
    this.wasRaw = process.stdin.isRaw || false;
    if (process.stdin.setRawMode) {
      process.stdin.setRawMode(true);
    }
    process.stdin.setEncoding('utf8');
    process.stdin.resume();

    // Enable bracketed paste mode
    process.stdout.write('\x1b[?2004h');

    // Set up input handler
    this.dataHandler = (data: Buffer) => {
      if (this.inputHandler) {
        this.inputHandler(data.toString('utf8'));
      }
    };
    process.stdin.on('data', this.dataHandler);

    // Set up resize handler
    process.stdout.on('resize', this.resizeHandler);
  }

  stop(): void {
    // Disable bracketed paste mode
    process.stdout.write('\x1b[?2004l');

    // Remove event handlers
    if (this.dataHandler) {
      process.stdin.removeListener('data', this.dataHandler);
      this.dataHandler = undefined;
    }
    this.inputHandler = undefined;
    if (this.resizeHandler) {
      process.stdout.removeListener('resize', this.resizeHandler);
      this.resizeHandler = undefined;
    }

    // Pause stdin
    process.stdin.pause();

    // Restore raw mode state
    if (process.stdin.setRawMode) {
      process.stdin.setRawMode(this.wasRaw);
    }
  }

  write(data: string): void {
    process.stdout.write(data);
  }

  get columns(): number {
    return process.stdout.columns || 80;
  }

  get rows(): number {
    return process.stdout.rows || 24;
  }

  moveBy(lines: number): void {
    if (lines > 0) {
      process.stdout.write(`\x1b[${lines}B`);
    } else if (lines < 0) {
      process.stdout.write(`\x1b[${-lines}A`);
    }
  }

  hideCursor(): void {
    process.stdout.write('\x1b[?25l');
  }

  showCursor(): void {
    process.stdout.write('\x1b[?25h');
  }

  clearLine(): void {
    process.stdout.write('\x1b[K');
  }

  clearFromCursor(): void {
    process.stdout.write('\x1b[J');
  }

  clearScreen(): void {
    process.stdout.write('\x1b[2J\x1b[H');
  }

  setTitle(title: string): void {
    process.stdout.write(`\x1b]0;${title}\x07`);
  }
}
