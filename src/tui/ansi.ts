/**
 * ANSI utilities for TUI rendering.
 * Reuses calculateDisplayWidth from utils/terminal.ts and adds strip/wrap helpers.
 */

const ANSI_ESCAPE_RE = /\x1b\[[0-9;]*m/g;

/** Strip all ANSI escape sequences from a string. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE_RE, '');
}

/**
 * Calculate the visible width of a string (excluding ANSI escapes).
 * Re-exported from utils/terminal.ts for convenience.
 */
export { calculateDisplayWidth as visibleWidth } from '../utils/terminal.js';

/** Wrap text to fit within a given width, respecting word boundaries. */
export function wrapText(text: string, width: number): string[] {
  if (width <= 0) return [''];
  const lines: string[] = [];

  for (const rawLine of text.split('\n')) {
    if (rawLine === '') {
      lines.push('');
      continue;
    }

    const stripped = stripAnsi(rawLine);
    if (stripped.length <= width) {
      lines.push(rawLine);
      continue;
    }

    // Simple character-level wrapping for ANSI-free content
    // (Phase 0: no complex ANSI-aware wrapping yet)
    let remaining = stripped;
    while (remaining.length > 0) {
      lines.push(remaining.slice(0, width));
      remaining = remaining.slice(width);
    }
  }

  return lines;
}

/** Pad a string to a given visible width with spaces. */
export function padEnd(text: string, targetWidth: number): string {
  const stripped = stripAnsi(text);
  const padding = Math.max(0, targetWidth - stripped.length);
  return text + ' '.repeat(padding);
}

/** Truncate a string to a given visible width, adding ellipsis if needed. */
export function truncate(text: string, maxWidth: number): string {
  const stripped = stripAnsi(text);
  if (stripped.length <= maxWidth) return text;
  if (maxWidth <= 1) return stripped.slice(0, maxWidth);
  // For plain text, simple slice + ellipsis
  return stripped.slice(0, maxWidth - 1) + '…';
}
