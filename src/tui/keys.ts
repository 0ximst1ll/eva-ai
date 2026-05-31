// Minimal key identifier set for Eva TUI
export type KeyId =
  | 'return'
  | 'backspace'
  | 'delete'
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'home'
  | 'end'
  | 'escape'
  | 'tab'
  | 'ctrl-a'
  | 'ctrl-b'
  | 'ctrl-c'
  | 'ctrl-d'
  | 'ctrl-e'
  | 'ctrl-f'
  | 'ctrl-k'
  | 'ctrl-l'
  | 'ctrl-n'
  | 'ctrl-p'
  | 'ctrl-t'
  | 'ctrl-u'
  | 'ctrl-w'
  | `char:${string}`;

// Raw byte sequences -> KeyId mapping
const SEQUENCES: [string, KeyId][] = [
  ['\r', 'return'],
  ['\n', 'return'],
  ['\x7f', 'backspace'],
  ['\x08', 'backspace'],
  ['\x1b[3~', 'delete'],
  ['\x1b[A', 'up'],
  ['\x1bOA', 'up'],
  ['\x1b[B', 'down'],
  ['\x1bOB', 'down'],
  ['\x1b[C', 'right'],
  ['\x1bOC', 'right'],
  ['\x1b[D', 'left'],
  ['\x1bOD', 'left'],
  ['\x1b[H', 'home'],
  ['\x1bOH', 'home'],
  ['\x1b[1~', 'home'],
  ['\x1b[F', 'end'],
  ['\x1bOF', 'end'],
  ['\x1b[4~', 'end'],
  ['\x1b', 'escape'],
  ['\t', 'tab'],
  ['\x01', 'ctrl-a'],
  ['\x02', 'ctrl-b'],
  ['\x03', 'ctrl-c'],
  ['\x04', 'ctrl-d'],
  ['\x05', 'ctrl-e'],
  ['\x06', 'ctrl-f'],
  ['\x0b', 'ctrl-k'],
  ['\x0c', 'ctrl-l'],
  ['\x0e', 'ctrl-n'],
  ['\x10', 'ctrl-p'],
  ['\x14', 'ctrl-t'],
  ['\x15', 'ctrl-u'],
  ['\x17', 'ctrl-w'],
];

const SEQ_MAP = new Map<string, KeyId>(SEQUENCES);

export function parseKey(data: string): KeyId | null {
  const mapped = SEQ_MAP.get(data);
  if (mapped) return mapped;

  // Printable character (not a control sequence)
  if (data.length === 1 && data.codePointAt(0)! >= 0x20) {
    return `char:${data}`;
  }

  // Multi-byte printable (e.g. emoji, CJK)
  if (!data.startsWith('\x1b') && [...data].every((c) => (c.codePointAt(0) ?? 0) >= 0x20)) {
    return `char:${data}`;
  }

  return null;
}

export function matchesKey(data: string, keyId: KeyId): boolean {
  return parseKey(data) === keyId;
}

export function isChar(data: string): string | null {
  const k = parseKey(data);
  if (k?.startsWith('char:')) return k.slice(5);
  return null;
}
