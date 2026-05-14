import { Marked, type Token, Tokenizer, type Tokens } from 'marked';
import type { Component } from '../component.js';
import { visibleWidth, wrapText } from '../utils.js';

// ── Marked setup ──────────────────────────────────────────────────────────────

// Strikethrough requires non-whitespace adjacent to ~~ (like GitHub)
const STRICT_STRIKETHROUGH_RE = /^(~~)(?=[^\s~])((?:\\.|[^\\])*?(?:\\.|[^\s~\\]))\1(?=[^~]|$)/;

class StrictStrikethroughTokenizer extends Tokenizer {
  override del(src: string): Tokens.Del | undefined {
    const m = STRICT_STRIKETHROUGH_RE.exec(src);
    if (!m) return undefined;
    return { type: 'del', raw: m[0], text: m[2]!, tokens: this.lexer.inlineTokens(m[2]!) };
  }
}

const parser = new Marked({ tokenizer: new StrictStrikethroughTokenizer() });

// ── Default theme ─────────────────────────────────────────────────────────────

const C = {
  reset:     '\x1b[0m',
  bold:      '\x1b[1m',
  dim:       '\x1b[2m',
  italic:    '\x1b[3m',
  underline: '\x1b[4m',
  strike:    '\x1b[9m',
  cyan:      '\x1b[36m',
  yellow:    '\x1b[33m',
  green:     '\x1b[32m',
  blue:      '\x1b[34m',
  magenta:   '\x1b[35m',
  brightCyan: '\x1b[96m',
  bgBlack:   '\x1b[40m',
  gray:      '\x1b[90m',
};

function wrap(open: string, close = C.reset) {
  return (s: string) => `${open}${s}${close}`;
}

export interface MarkdownTheme {
  heading:         (s: string) => string;
  bold:            (s: string) => string;
  italic:          (s: string) => string;
  strikethrough:   (s: string) => string;
  underline:       (s: string) => string;
  code:            (s: string) => string;     // inline code
  codeBlock:       (s: string) => string;     // code block body line
  codeBlockBorder: (s: string) => string;     // ``` fence
  codeBlockIndent: string;
  quote:           (s: string) => string;
  quoteBorder:     (s: string) => string;
  listBullet:      (s: string) => string;
  link:            (s: string) => string;
  linkUrl:         (s: string) => string;
  hr:              (s: string) => string;
}

export const DEFAULT_THEME: MarkdownTheme = {
  heading:         wrap(C.bold + C.brightCyan),
  bold:            wrap(C.bold),
  italic:          wrap(C.italic),
  strikethrough:   wrap(C.strike),
  underline:       wrap(C.underline),
  code:            wrap(C.bgBlack + C.cyan),
  codeBlock:       wrap(C.cyan),
  codeBlockBorder: wrap(C.dim),
  codeBlockIndent: '  ',
  quote:           wrap(C.italic + C.gray),
  quoteBorder:     wrap(C.dim),
  listBullet:      wrap(C.yellow),
  link:            wrap(C.underline + C.blue),
  linkUrl:         wrap(C.dim),
  hr:              wrap(C.dim),
};

// ── Component ─────────────────────────────────────────────────────────────────

export class Markdown implements Component {
  private _text: string;
  private theme: MarkdownTheme;
  private cache: { text: string; width: number; lines: string[] } | null = null;

  constructor(text = '', theme: MarkdownTheme = DEFAULT_THEME) {
    this._text = text;
    this.theme = theme;
  }

  get text(): string { return this._text; }

  setText(text: string): void {
    if (this._text !== text) { this._text = text; this.cache = null; }
  }

  append(chunk: string): void {
    this._text += chunk;
    this.cache = null;
  }

  invalidate(): void { this.cache = null; }

  render(width: number): string[] {
    if (this.cache && this.cache.text === this._text && this.cache.width === width) {
      return this.cache.lines;
    }
    const lines = this._render(width);
    this.cache = { text: this._text, width, lines };
    return lines;
  }

  private _render(width: number): string[] {
    if (!this._text.trim()) return [];

    const tokens = parser.lexer(this._text.replace(/\t/g, '   '));
    const raw: string[] = [];

    for (let i = 0; i < tokens.length; i++) {
      const next = tokens[i + 1];
      raw.push(...this.renderToken(tokens[i]!, width, next?.type));
    }

    // Word-wrap every non-empty line
    const out: string[] = [];
    for (const line of raw) {
      if (line === '') { out.push(''); continue; }
      const wrapped = wrapText(line, width);
      out.push(...wrapped);
    }

    return out;
  }

  // ── Block tokens ────────────────────────────────────────────────────────────

  private renderToken(token: Token, width: number, nextType?: string): string[] {
    const lines: string[] = [];
    const T = this.theme;

    switch (token.type) {

      case 'heading': {
        const prefix = '#'.repeat(token.depth) + ' ';
        const content = this.renderInline(token.tokens ?? []);
        const styled = T.heading(token.depth === 1 ? T.bold(T.underline(content)) : T.bold(content));
        lines.push(token.depth >= 3 ? T.heading(prefix) + styled : styled);
        if (nextType && nextType !== 'space') lines.push('');
        break;
      }

      case 'paragraph': {
        lines.push(this.renderInline(token.tokens ?? []));
        if (nextType && nextType !== 'list' && nextType !== 'space') lines.push('');
        break;
      }

      case 'text':
        lines.push(this.renderInline([token]));
        break;

      case 'code': {
        const indent = T.codeBlockIndent;
        lines.push(T.codeBlockBorder('```' + (token.lang ?? '')));
        for (const codeLine of token.text.split('\n')) {
          lines.push(indent + T.codeBlock(codeLine));
        }
        lines.push(T.codeBlockBorder('```'));
        if (nextType && nextType !== 'space') lines.push('');
        break;
      }

      case 'list':
        lines.push(...this.renderList(token as Tokens.List, 0, width));
        break;

      case 'blockquote': {
        const inner: string[] = [];
        const qt = token.tokens ?? [];
        for (let i = 0; i < qt.length; i++) {
          inner.push(...this.renderToken(qt[i]!, width - 2, qt[i + 1]?.type));
        }
        // Trim trailing empty line inside quote
        while (inner.length > 0 && inner[inner.length - 1] === '') inner.pop();
        for (const l of inner) {
          lines.push(T.quoteBorder('│ ') + T.quote(l));
        }
        if (nextType && nextType !== 'space') lines.push('');
        break;
      }

      case 'table':
        lines.push(...this.renderTable(token as Tokens.Table, width, nextType));
        break;

      case 'hr':
        lines.push(T.hr('─'.repeat(Math.min(width, 80))));
        if (nextType && nextType !== 'space') lines.push('');
        break;

      case 'space':
        lines.push('');
        break;

      default:
        if ('text' in token && typeof token.text === 'string') lines.push(token.text);
    }

    return lines;
  }

  // ── Inline tokens ────────────────────────────────────────────────────────────

  private renderInline(tokens: Token[]): string {
    const T = this.theme;
    let out = '';

    for (const token of tokens) {
      switch (token.type) {
        case 'text':
          if (token.tokens && token.tokens.length > 0) {
            out += this.renderInline(token.tokens);
          } else {
            out += token.text;
          }
          break;

        case 'paragraph':
          out += this.renderInline(token.tokens ?? []);
          break;

        case 'strong':
          out += T.bold(this.renderInline(token.tokens ?? []));
          break;

        case 'em':
          out += T.italic(this.renderInline(token.tokens ?? []));
          break;

        case 'del':
          out += T.strikethrough(this.renderInline(token.tokens ?? []));
          break;

        case 'codespan':
          out += T.code(token.text);
          break;

        case 'link': {
          const text = this.renderInline(token.tokens ?? []);
          const styledLink = T.link(text);
          const href = token.href;
          // No OSC8 hyperlink support for simplicity; show URL if different from text
          const hrefCmp = href.startsWith('mailto:') ? href.slice(7) : href;
          if (token.text === href || token.text === hrefCmp) {
            out += styledLink;
          } else {
            out += styledLink + T.linkUrl(` (${href})`);
          }
          break;
        }

        case 'br':
          out += '\n';
          break;

        default:
          if ('text' in token && typeof token.text === 'string') out += token.text;
      }
    }

    return out;
  }

  // ── List ─────────────────────────────────────────────────────────────────────

  private renderList(token: Tokens.List, depth: number, width: number): string[] {
    const lines: string[] = [];
    const T = this.theme;
    const indent = '    '.repeat(depth);
    const start = typeof token.start === 'number' ? token.start : 1;

    for (let i = 0; i < token.items.length; i++) {
      const item = token.items[i]!;
      const bullet = token.ordered ? `${start + i}. ` : '- ';
      const firstPfx = indent + T.listBullet(bullet);
      const contPfx  = indent + ' '.repeat(visibleWidth(bullet));
      const itemW = Math.max(1, width - visibleWidth(firstPfx));
      let rendered = false;

      for (const t of item.tokens) {
        if (t.type === 'list') {
          lines.push(...this.renderList(t as Tokens.List, depth + 1, width));
          rendered = true;
          continue;
        }
        for (const l of this.renderToken(t, itemW, undefined)) {
          for (const wl of wrapText(l, itemW)) {
            lines.push((rendered ? contPfx : firstPfx) + wl);
            rendered = true;
          }
        }
      }

      if (!rendered) lines.push(firstPfx);
    }

    return lines;
  }

  // ── Table ─────────────────────────────────────────────────────────────────────

  private renderTable(token: Tokens.Table, width: number, nextType?: string): string[] {
    const lines: string[] = [];
    const numCols = token.header.length;
    if (numCols === 0) return lines;

    // Measure natural column widths
    const natW = token.header.map((c) => visibleWidth(this.renderInline(c.tokens ?? [])));
    for (const row of token.rows) {
      for (let i = 0; i < row.length; i++) {
        natW[i] = Math.max(natW[i] ?? 0, visibleWidth(this.renderInline(row[i]!.tokens ?? [])));
      }
    }

    // Border overhead: "│ " + (n-1)*" │ " + " │" = 3n+1
    const overhead = 3 * numCols + 1;
    const available = width - overhead;
    if (available < numCols) {
      // Too narrow — render as plain text
      const fb = wrapText(token.raw ?? '', width);
      if (nextType && nextType !== 'space') fb.push('');
      return fb;
    }

    const totalNat = natW.reduce((a, b) => a + b, 0);
    let colW: number[];

    if (totalNat <= available) {
      colW = [...natW];
    } else {
      // Proportionally shrink columns
      const minW = 3;
      colW = natW.map(() => minW);
      let budget = available - numCols * minW;
      const weights = natW.map((w) => Math.max(0, w - minW));
      const totalW = weights.reduce((a, b) => a + b, 0);
      if (totalW > 0) {
        for (let i = 0; i < numCols; i++) {
          const extra = Math.floor((weights[i]! / totalW) * budget);
          colW[i]! += extra;
        }
      }
      // Distribute rounding remainder
      let used = colW.reduce((a, b) => a + b, 0);
      for (let i = 0; used < available && i < numCols; i++, used++) colW[i]!++;
    }

    const hr = (l: string, m: string, r: string) =>
      l + colW.map((w) => '─'.repeat(w + 2)).join(m) + r;

    const cellLine = (cells: string[][], rowIdx: number) => {
      const parts = cells.map((c, i) => {
        const t = c[rowIdx] ?? '';
        return t + ' '.repeat(Math.max(0, colW[i]! - visibleWidth(t)));
      });
      return `│ ${parts.join(' │ ')} │`;
    };

    // Header
    lines.push(hr('┌', '┬', '┐'));
    const hCells = token.header.map((c, i) => {
      const t = this.theme.bold(this.renderInline(c.tokens ?? []));
      return wrapText(t, colW[i]!);
    });
    const hRows = Math.max(...hCells.map((c) => c.length));
    for (let r = 0; r < hRows; r++) lines.push(cellLine(hCells, r));
    lines.push(hr('├', '┼', '┤'));

    // Body
    for (let ri = 0; ri < token.rows.length; ri++) {
      const row = token.rows[ri]!;
      const cells = row.map((c, i) => wrapText(this.renderInline(c.tokens ?? []), colW[i]!));
      const nRows = Math.max(...cells.map((c) => c.length));
      for (let r = 0; r < nRows; r++) lines.push(cellLine(cells, r));
      if (ri < token.rows.length - 1) lines.push(hr('├', '┼', '┤'));
    }

    lines.push(hr('└', '┴', '┘'));
    if (nextType && nextType !== 'space') lines.push('');
    return lines;
  }
}
