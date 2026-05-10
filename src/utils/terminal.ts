// Terminal display utilities — mirrors eva_ai/utils/terminal_utils.py

const ANSI_ESCAPE_RE = /\x1b\[[0-9;]*m/g;
const EMOJI_START = 0x1f300;
const EMOJI_END = 0x1faff;

export function calculateDisplayWidth(text: string): number {
  const clean = text.replace(ANSI_ESCAPE_RE, '');
  let width = 0;

  for (const char of clean) {
    const cp = char.codePointAt(0) ?? 0;

    // Emoji range (2 columns)
    if (cp >= EMOJI_START && cp <= EMOJI_END) {
      width += 2;
      continue;
    }

    // East Asian Wide / Fullwidth (2 columns).
    // Node.js doesn't ship with Intl.Segmenter EAW data, so we approximate
    // with the most common CJK unified ideograph ranges.
    if (
      (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
      (cp >= 0x2e80 && cp <= 0x9fff) || // CJK radicals + unified ideographs
      (cp >= 0xac00 && cp <= 0xd7af) || // Hangul syllables
      (cp >= 0xf900 && cp <= 0xfaff) || // CJK compatibility
      (cp >= 0xfe10 && cp <= 0xfe6f) || // CJK compatibility forms
      (cp >= 0xff00 && cp <= 0xff60) || // Fullwidth forms
      (cp >= 0xffe0 && cp <= 0xffe6) || // Fullwidth signs
      (cp >= 0x1f004 && cp <= 0x1f0cf) // Playing cards / mahjong
    ) {
      width += 2;
      continue;
    }

    width += 1;
  }

  return width;
}

// ANSI color constants — mirrors eva_ai/agent.py Colors class
export const Colors = {
  RESET: '\x1b[0m',
  BOLD: '\x1b[1m',
  DIM: '\x1b[2m',
  RED: '\x1b[31m',
  GREEN: '\x1b[32m',
  YELLOW: '\x1b[33m',
  BLUE: '\x1b[34m',
  MAGENTA: '\x1b[35m',
  CYAN: '\x1b[36m',
  BRIGHT_BLACK: '\x1b[90m',
  BRIGHT_RED: '\x1b[91m',
  BRIGHT_GREEN: '\x1b[92m',
  BRIGHT_YELLOW: '\x1b[93m',
  BRIGHT_BLUE: '\x1b[94m',
  BRIGHT_MAGENTA: '\x1b[95m',
  BRIGHT_CYAN: '\x1b[96m',
  BRIGHT_WHITE: '\x1b[97m',
  BG_RED: '\x1b[41m',
  BG_GREEN: '\x1b[42m',
  BG_YELLOW: '\x1b[43m',
  BG_BLUE: '\x1b[44m',
  BG_WHITE: '\x1b[47m',
  BLACK: '\x1b[30m',
} as const;
