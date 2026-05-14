import type { Component } from '../component.js';
import { visibleWidth, truncateToWidth } from '../utils.js';

export interface FooterData {
  model?: string;
  provider?: string;
  tokens?: number;
  sessionId?: string;
  status?: string; // e.g. 'running' | 'idle'
}

const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';

export class Footer implements Component {
  private data: FooterData = {};
  private cache: { key: string; width: number; lines: string[] } | null = null;

  update(data: Partial<FooterData>): void {
    Object.assign(this.data, data);
    this.cache = null;
  }

  invalidate(): void {
    this.cache = null;
  }

  render(width: number): string[] {
    const key = JSON.stringify(this.data);
    if (this.cache && this.cache.key === key && this.cache.width === width) {
      return this.cache.lines;
    }

    const line = this.buildLine(width);
    const lines = [line];
    this.cache = { key, width, lines };
    return lines;
  }

  private buildLine(width: number): string {
    // Build segments in priority order (high priority = kept when narrow)
    // Each: [text, visibleWidth]
    const segments = this.buildSegments();

    // Try to fit all segments separated by spaces
    const separator = `  `;
    const sepWidth = visibleWidth(separator);

    // Measure total width
    let totalWidth = 0;
    for (let i = 0; i < segments.length; i++) {
      totalWidth += segments[i][1];
      if (i < segments.length - 1) totalWidth += sepWidth;
    }

    let result = segments.map((s) => s[0]).join(separator);

    if (totalWidth > width) {
      // Drop lowest-priority segments from the right until it fits
      const kept: [string, number][] = [...segments];
      while (kept.length > 1) {
        kept.pop();
        let w = 0;
        for (let i = 0; i < kept.length; i++) {
          w += kept[i][1];
          if (i < kept.length - 1) w += sepWidth;
        }
        if (w <= width) break;
      }
      result = kept.map((s) => s[0]).join(separator);
      totalWidth = kept.reduce((acc, s, i) => acc + s[1] + (i < kept.length - 1 ? sepWidth : 0), 0);
    }

    // Truncate model name if still too wide
    if (totalWidth > width) {
      result = truncateToWidth(result, width);
    }

    // Pad with dim background to full width
    const pad = Math.max(0, width - visibleWidth(result));
    return `${DIM}${result}${'─'.repeat(pad)}${RESET}`;
  }

  private buildSegments(): [string, number][] {
    const segs: [string, number][] = [];

    const { model, provider, tokens, sessionId, status } = this.data;

    // Status indicator (highest priority)
    if (status === 'running') {
      const s = `${YELLOW}● running${RESET}`;
      segs.push([s, visibleWidth(stripAnsi(s))]);
    } else {
      const s = `${GREEN}● ready${RESET}`;
      segs.push([s, visibleWidth(stripAnsi(s))]);
    }

    // Model name
    if (model) {
      const s = `${CYAN}${model}${RESET}`;
      segs.push([s, visibleWidth(model)]);
    }

    // Token count
    if (tokens !== undefined && tokens > 0) {
      const label = formatTokens(tokens);
      const s = `${DIM}tokens: ${RESET}${label}`;
      segs.push([s, visibleWidth(`tokens: ${label}`)]);
    }

    // Provider
    if (provider) {
      const s = `${DIM}${provider}${RESET}`;
      segs.push([s, visibleWidth(provider)]);
    }

    // Session id (lowest priority)
    if (sessionId) {
      const short = sessionId.slice(0, 8);
      const s = `${DIM}[${short}]${RESET}`;
      segs.push([s, visibleWidth(`[${short}]`)]);
    }

    return segs;
  }
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
}
