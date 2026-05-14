import type { Component } from '../component.js';
import { visibleWidth, truncateToWidth } from '../utils.js';
import { matchesKey } from '../keys.js';

export interface SelectItem {
  value: string;
  label: string;
  description?: string;
}

export interface SelectListTheme {
  selectedPrefix: (s: string) => string;
  selectedText:   (s: string) => string;
  normalText:     (s: string) => string;
  description:    (s: string) => string;
  scrollInfo:     (s: string) => string;
  noMatch:        (s: string) => string;
}

const DEFAULT_THEME: SelectListTheme = {
  selectedPrefix: (s) => `\x1b[32m${s}\x1b[0m`,
  selectedText:   (s) => `\x1b[1m${s}\x1b[0m`,
  normalText:     (s) => s,
  description:    (s) => `\x1b[2m${s}\x1b[0m`,
  scrollInfo:     (s) => `\x1b[2m${s}\x1b[0m`,
  noMatch:        (s) => `\x1b[2m${s}\x1b[0m`,
};

const PRIMARY_COL_DEFAULT = 32;
const PRIMARY_COL_GAP = 2;
const MIN_DESC_WIDTH = 10;

function clamp(v: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, v)); }
function singleLine(s: string) { return s.replace(/[\r\n]+/g, ' ').trim(); }

export class SelectList implements Component {
  private items: SelectItem[];
  private filtered: SelectItem[];
  private selectedIdx = 0;
  private maxVisible: number;
  private theme: SelectListTheme;
  private tui?: { requestRender: () => void };

  onSelect?: (item: SelectItem) => void;
  onCancel?: () => void;
  onSelectionChange?: (item: SelectItem) => void;

  constructor(
    items: SelectItem[],
    maxVisible = 8,
    theme: SelectListTheme = DEFAULT_THEME,
  ) {
    this.items = items;
    this.filtered = items;
    this.maxVisible = maxVisible;
    this.theme = theme;
  }

  attachTui(tui: { requestRender: () => void }): void { this.tui = tui; }

  setItems(items: SelectItem[]): void {
    this.items = items;
    this.filtered = items;
    this.selectedIdx = 0;
  }

  setFilter(filter: string): void {
    const q = filter.toLowerCase();
    this.filtered = q
      ? this.items.filter(
          (i) => i.label.toLowerCase().includes(q) || i.value.toLowerCase().includes(q),
        )
      : this.items;
    this.selectedIdx = 0;
  }

  getSelected(): SelectItem | null {
    return this.filtered[this.selectedIdx] ?? null;
  }

  invalidate(): void {}

  handleInput(data: string): void {
    const n = this.filtered.length;
    if (n === 0) {
      if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl-c')) this.onCancel?.();
      return;
    }

    if (matchesKey(data, 'up') || matchesKey(data, 'ctrl-p')) {
      this.selectedIdx = this.selectedIdx === 0 ? n - 1 : this.selectedIdx - 1;
      this.onSelectionChange?.(this.filtered[this.selectedIdx]!);
      this.tui?.requestRender();
      return;
    }
    if (matchesKey(data, 'down') || matchesKey(data, 'ctrl-n')) {
      this.selectedIdx = this.selectedIdx === n - 1 ? 0 : this.selectedIdx + 1;
      this.onSelectionChange?.(this.filtered[this.selectedIdx]!);
      this.tui?.requestRender();
      return;
    }
    if (matchesKey(data, 'return')) {
      const item = this.filtered[this.selectedIdx];
      if (item) this.onSelect?.(item);
      return;
    }
    if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl-c')) {
      this.onCancel?.();
      return;
    }
  }

  render(width: number): string[] {
    const T = this.theme;
    if (this.filtered.length === 0) {
      return [T.noMatch('  No items')];
    }

    const primaryColW = this.calcPrimaryColW();
    const n = this.filtered.length;
    const half = Math.floor(this.maxVisible / 2);
    const startIdx = clamp(this.selectedIdx - half, 0, Math.max(0, n - this.maxVisible));
    const endIdx = Math.min(startIdx + this.maxVisible, n);

    const lines: string[] = [];
    for (let i = startIdx; i < endIdx; i++) {
      lines.push(this.renderItem(this.filtered[i]!, i === this.selectedIdx, width, primaryColW));
    }

    if (startIdx > 0 || endIdx < n) {
      lines.push(T.scrollInfo(`  (${this.selectedIdx + 1}/${n})`));
    }

    return lines;
  }

  private renderItem(item: SelectItem, selected: boolean, width: number, primaryColW: number): string {
    const T = this.theme;
    const prefix = selected ? '→ ' : '  ';
    const prefixW = 2;
    const desc = item.description ? singleLine(item.description) : undefined;

    if (desc && width > 40) {
      const effPrimW = Math.max(1, Math.min(primaryColW, width - prefixW - 4));
      const maxPrimW = Math.max(1, effPrimW - PRIMARY_COL_GAP);
      const label = truncateToWidth(item.label || item.value, maxPrimW);
      const labelW = visibleWidth(label);
      const spacing = ' '.repeat(Math.max(1, effPrimW - labelW));
      const descW = width - prefixW - labelW - spacing.length - 2;
      if (descW > MIN_DESC_WIDTH) {
        const descText = truncateToWidth(desc, descW);
        if (selected) return T.selectedText(`${prefix}${label}${spacing}${descText}`);
        return `${prefix}${T.normalText(label)}${T.description(spacing + descText)}`;
      }
    }

    const maxW = width - prefixW - 2;
    const label = truncateToWidth(item.label || item.value, maxW);
    if (selected) return T.selectedText(`${prefix}${label}`);
    return `${prefix}${T.normalText(label)}`;
  }

  private calcPrimaryColW(): number {
    const widest = this.filtered.reduce(
      (w, i) => Math.max(w, visibleWidth(i.label || i.value) + PRIMARY_COL_GAP),
      0,
    );
    return clamp(widest, 8, PRIMARY_COL_DEFAULT);
  }
}
