// Strip all ANSI escape sequences from a string
const ANSI_RE = /\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

export function stripAnsi(str: string): string {
  return str.replace(ANSI_RE, '');
}

// Calculate visible terminal column width of a string (strips ANSI, accounts for wide chars)
export function visibleWidth(str: string): number {
  const clean = stripAnsi(str);
  let width = 0;
  for (const char of clean) {
    const cp = char.codePointAt(0) ?? 0;
    if (isWide(cp)) {
      width += 2;
    } else if (cp >= 0x20) {
      width += 1;
    }
    // control chars (< 0x20) contribute 0
  }
  return width;
}

function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x9fff) ||
    (cp >= 0xac00 && cp <= 0xd7af) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f000 && cp <= 0x1faff)
  );
}

// Wrap text to fit within `width` columns, preserving ANSI codes across line breaks.
// Returns array of lines (no trailing newlines). Each line's visible width <= width.
export function wrapText(text: string, width: number): string[] {
  if (width <= 0) return [text];

  // Split into segments: [ansiCode | word | whitespace]
  const SEGMENT_RE = /(\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])|[^\S\n]+|\S+|\n)/g;
  const lines: string[] = [];
  let currentLine = '';
  let currentWidth = 0;
  // Track active ANSI codes to prepend on continuation lines
  let activeAnsi = '';

  const flushLine = () => {
    lines.push(currentLine);
    currentLine = activeAnsi;
    currentWidth = 0;
  };

  let match: RegExpExecArray | null;
  while ((match = SEGMENT_RE.exec(text)) !== null) {
    const seg = match[1];

    // Hard newline
    if (seg === '\n') {
      flushLine();
      continue;
    }

    // ANSI escape — zero width, carry forward
    if (seg.startsWith('\x1b')) {
      currentLine += seg;
      // Track reset vs other codes
      if (seg === '\x1b[0m' || seg === '\x1b[m') {
        activeAnsi = '';
      } else {
        activeAnsi += seg;
      }
      continue;
    }

    const segWidth = visibleWidth(seg);

    // If segment alone exceeds width, hard-break it char by char
    if (segWidth > width) {
      for (const char of seg) {
        const cw = visibleWidth(char);
        if (currentWidth + cw > width) flushLine();
        currentLine += char;
        currentWidth += cw;
      }
      continue;
    }

    // Whitespace: only emit if not at start of new line
    if (/^\s+$/.test(seg)) {
      if (currentWidth === 0) continue; // leading space on new line — skip
      if (currentWidth + segWidth > width) {
        flushLine();
      } else {
        currentLine += seg;
        currentWidth += segWidth;
      }
      continue;
    }

    // Word
    if (currentWidth + segWidth > width) {
      flushLine();
    }
    currentLine += seg;
    currentWidth += segWidth;
  }

  if (stripAnsi(currentLine).length > 0 || lines.length === 0) {
    lines.push(currentLine);
  }

  return lines;
}

// Truncate string to at most `maxWidth` visible columns, appending ellipsis if truncated.
export function truncateToWidth(str: string, maxWidth: number, ellipsis = '…'): string {
  const ellipsisWidth = visibleWidth(ellipsis);
  if (maxWidth <= 0) return '';
  if (visibleWidth(str) <= maxWidth) return str;

  const budget = maxWidth - ellipsisWidth;
  if (budget <= 0) return ellipsis.slice(0, maxWidth);

  // Re-build string up to budget columns, preserving ANSI
  const SEGMENT_RE = /(\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])|[\s\S])/g;
  let result = '';
  let width = 0;
  let match: RegExpExecArray | null;
  while ((match = SEGMENT_RE.exec(str)) !== null) {
    const seg = match[1];
    if (seg.startsWith('\x1b')) {
      result += seg;
      continue;
    }
    const cw = visibleWidth(seg);
    if (width + cw > budget) break;
    result += seg;
    width += cw;
  }

  return result + ellipsis;
}

// Pad a string (with ANSI) to exactly `targetWidth` visible columns using spaces.
export function padToWidth(str: string, targetWidth: number): string {
  const w = visibleWidth(str);
  if (w >= targetWidth) return str;
  return str + ' '.repeat(targetWidth - w);
}
