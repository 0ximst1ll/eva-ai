import { EventEmitter } from 'node:events';

const FLUSH_TIMEOUT_MS = 10;
const BRACKETED_PASTE_START = '\x1b[200~';
const BRACKETED_PASTE_END = '\x1b[201~';

/**
 * Buffers raw stdin bytes and emits complete terminal input sequences.
 *
 * Emits:
 *   'data'  — one complete sequence per emission (key, CSI, paste content as single string, etc.)
 *
 * Bracketed paste is assembled into a single 'data' event wrapping the content
 * in \x1b[200~ ... \x1b[201~ so consumers can detect and handle it atomically.
 */
export class StdinBuffer extends EventEmitter {
  private buf = '';
  private flushTimer: NodeJS.Timeout | undefined;
  private inPaste = false;
  private pasteBuf = '';

  push(data: string): void {
    this.buf += data;
    this.cancelTimer();
    this.drain();
  }

  private drain(): void {
    while (this.buf.length > 0) {
      // ── Bracketed paste handling ─────────────────────────────────────────
      if (this.inPaste) {
        const endIdx = this.buf.indexOf(BRACKETED_PASTE_END);
        if (endIdx === -1) {
          // End marker not yet received — accumulate and wait
          this.pasteBuf += this.buf;
          this.buf = '';
          return;
        }
        this.pasteBuf += this.buf.slice(0, endIdx);
        this.buf = this.buf.slice(endIdx + BRACKETED_PASTE_END.length);
        this.inPaste = false;
        // Emit the entire paste as a single bracketed sequence so consumers
        // can handle multi-line pastes atomically without spurious submits.
        this.emit('data', BRACKETED_PASTE_START + this.pasteBuf + BRACKETED_PASTE_END);
        this.pasteBuf = '';
        continue;
      }

      // ── Check for bracketed paste start ──────────────────────────────────
      const pasteStartIdx = this.buf.indexOf(BRACKETED_PASTE_START);
      if (pasteStartIdx === 0) {
        this.buf = this.buf.slice(BRACKETED_PASTE_START.length);
        this.inPaste = true;
        this.pasteBuf = '';
        continue;
      }

      // ── Non-escape chars ─────────────────────────────────────────────────
      if (!this.buf.startsWith('\x1b')) {
        const escIdx = this.buf.indexOf('\x1b');
        const chunk = escIdx === -1 ? this.buf : this.buf.slice(0, escIdx);
        for (const ch of chunk) this.emit('data', ch);
        this.buf = escIdx === -1 ? '' : this.buf.slice(escIdx);
        continue;
      }

      // ── ESC sequences ────────────────────────────────────────────────────
      const result = this.tryParseEscape(this.buf);
      if (result === null) {
        this.scheduleFlush();
        return;
      }
      if (result === 0) {
        this.emit('data', '\x1b');
        this.buf = this.buf.slice(1);
        continue;
      }
      this.emit('data', this.buf.slice(0, result));
      this.buf = this.buf.slice(result);
    }
  }

  /**
   * Returns:
   *   number > 0  — length of complete sequence
   *   null        — incomplete, need more bytes
   *   0           — unrecognised, emit bare ESC
   */
  private tryParseEscape(s: string): number | null {
    if (s.length < 2) return null;
    const second = s[1];

    // CSI: \x1b[ ... final-byte (0x40–0x7e)
    if (second === '[') {
      if (s.length < 3) return null;
      for (let i = 2; i < s.length; i++) {
        const cp = s.charCodeAt(i);
        if (cp >= 0x40 && cp <= 0x7e) return i + 1;
        if (cp < 0x20 || cp > 0x7e) return 0;
      }
      return null;
    }

    // SS3: \x1bO <char>
    if (second === 'O') {
      if (s.length < 3) return null;
      return 3;
    }

    // APC: \x1b_ ... ST or BEL
    if (second === '_') {
      const st = s.indexOf('\x1b\\', 2);
      if (st !== -1) return st + 2;
      const bel = s.indexOf('\x07', 2);
      if (bel !== -1) return bel + 1;
      return null;
    }

    // OSC: \x1b] ... ST or BEL
    if (second === ']') {
      const st = s.indexOf('\x1b\\', 2);
      if (st !== -1) return st + 2;
      const bel = s.indexOf('\x07', 2);
      if (bel !== -1) return bel + 1;
      return null;
    }

    // DCS: \x1bP ... ST
    if (second === 'P') {
      const st = s.indexOf('\x1b\\', 2);
      if (st !== -1) return st + 2;
      return null;
    }

    // Fe two-byte: \x1b + 0x40–0x5f
    const cp = second.charCodeAt(0);
    if (cp >= 0x40 && cp <= 0x5f) return 2;

    return 0;
  }

  private scheduleFlush(): void {
    this.flushTimer = setTimeout(() => {
      if (this.buf.length > 0) {
        this.emit('data', '\x1b');
        this.buf = this.buf.slice(1);
        this.drain();
      }
    }, FLUSH_TIMEOUT_MS);
  }

  private cancelTimer(): void {
    if (this.flushTimer !== undefined) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
  }

  destroy(): void {
    this.cancelTimer();
    this.removeAllListeners();
  }
}
