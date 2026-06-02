export type ProviderErrorCategory =
  | 'context_overflow'
  | 'rate_limited'
  | 'unavailable'
  | 'timeout'
  | 'transient'
  | 'unknown';

export interface FormattedProviderError {
  message: string;
  raw: string;
  category: ProviderErrorCategory;
  retryable: boolean;
  statusCode?: number;
  retryAfterMs?: number;
}

const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

export function formatProviderError(error: unknown): FormattedProviderError {
  const raw = formatRawError(error);
  const statusCode = extractStatusCode(raw);
  const searchable = `${raw}\n${extractNestedMessages(raw).join('\n')}`;
  const category = classifyProviderError(searchable, statusCode);
  const retryAfterMs = extractRetryAfterMs(searchable);

  return {
    raw,
    category,
    statusCode,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    retryable: isRetryableCategory(category) || (statusCode !== undefined && RETRYABLE_STATUS_CODES.has(statusCode)),
    message: createUserFacingMessage(category, searchable, statusCode),
  };
}

function formatRawError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ? `${error.name}: ${error.message}\n${error.stack}` : `${error.name}: ${error.message}`;
  }
  return String(error);
}

function classifyProviderError(text: string, statusCode?: number): ProviderErrorCategory {
  if (isContextOverflow(text)) return 'context_overflow';
  if (isRateLimited(text, statusCode)) return 'rate_limited';
  if (isUnavailable(text, statusCode)) return 'unavailable';
  if (isTimeout(text)) return 'timeout';
  if (statusCode !== undefined && RETRYABLE_STATUS_CODES.has(statusCode)) return 'transient';
  return 'unknown';
}

function isRetryableCategory(category: ProviderErrorCategory): boolean {
  return ['rate_limited', 'unavailable', 'timeout', 'transient'].includes(category);
}

function createUserFacingMessage(
  category: ProviderErrorCategory,
  text: string,
  statusCode?: number,
): string {
  if (category === 'context_overflow') {
    return 'Prompt is too long for the model context window. Compact the session or reduce the request size.';
  }

  if (category === 'rate_limited') {
    return 'Provider rate limited the request. Please retry later.';
  }

  if (category === 'unavailable') {
    return 'Provider unavailable: the model is currently overloaded or experiencing high demand. Please retry later.';
  }

  if (category === 'timeout') {
    return 'Provider request timed out. Please retry later.';
  }

  if (category === 'transient') {
    const suffix = statusCode ? ` (${statusCode})` : '';
    return `Provider request failed with a transient error${suffix}. Please retry later.`;
  }

  return `Provider request failed: ${extractShortMessage(text)}`;
}

function isContextOverflow(text: string): boolean {
  return [
    /context_length_exceeded/i,
    /context window/i,
    /context length/i,
    /maximum context/i,
    /prompt(?:\s+\S+){0,4}\s+too long/i,
    /input(?:\s+\S+){0,8}\s+(?:too long|exceed)/i,
    /token(?:\s+\S+){0,8}\s+exceed/i,
    /exceed(?:s|ed|ing)?(?:\s+\S+){0,8}\s+(?:context|tokens?|maximum input)/i,
    /too many tokens/i,
    /request too large/i,
  ].some((pattern) => pattern.test(text));
}

function isRateLimited(text: string, statusCode?: number): boolean {
  return statusCode === 429 || /rate.?limit|quota|too many requests/i.test(text);
}

function isUnavailable(text: string, statusCode?: number): boolean {
  return statusCode === 503
    || /unavailable|service unavailable|overloaded|high demand|try again later/i.test(text);
}

function isTimeout(text: string): boolean {
  return /timeout|timed out|deadline exceeded|etimedout/i.test(text);
}

function extractStatusCode(text: string): number | undefined {
  const codeMatch = text.match(/(?:status|code|statusCode)["'\s:=-]+(\d{3})/i)
    ?? text.match(/\b(429|500|502|503|504)\b/);
  const code = codeMatch?.[1] ? Number(codeMatch[1]) : undefined;
  return code && Number.isFinite(code) ? code : undefined;
}

function extractRetryAfterMs(text: string): number | undefined {
  for (const parsed of parseJsonCandidates(text)) {
    const retryAfter = findRetryAfterValue(parsed);
    const retryAfterMs = normalizeRetryAfterMs(retryAfter);
    if (retryAfterMs !== undefined) return retryAfterMs;
  }

  const retryAfterMatch = text.match(/retry[-_]?after["'\s:=]+["']?([^"',\n\r}]+)/i);
  return normalizeRetryAfterMs(retryAfterMatch?.[1]);
}

function findRetryAfterValue(value: unknown): unknown {
  if (!value || typeof value !== 'object') return undefined;

  if (Array.isArray(value)) {
    for (const item of value) {
      const retryAfter = findRetryAfterValue(item);
      if (retryAfter !== undefined) return retryAfter;
    }
    return undefined;
  }

  const record = value as Record<string, unknown>;
  for (const [key, nestedValue] of Object.entries(record)) {
    if (isRetryAfterKey(key)) return nestedValue;
  }

  for (const nestedValue of Object.values(record)) {
    const retryAfter = findRetryAfterValue(nestedValue);
    if (retryAfter !== undefined) return retryAfter;
  }

  return undefined;
}

function isRetryAfterKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[_-]/g, '');
  return normalized === 'retryafter';
}

function normalizeRetryAfterMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.round(value * 1000);
  }

  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  if (!normalized) return undefined;

  const seconds = Number(normalized);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }

  const dateMs = Date.parse(normalized);
  if (!Number.isFinite(dateMs)) return undefined;
  return Math.max(0, dateMs - Date.now());
}

function extractShortMessage(text: string): string {
  const nestedMessages = extractNestedMessages(text)
    .map((message) => message.trim())
    .filter(Boolean);
  const candidate = nestedMessages.at(-1) ?? text.split('\n')[0] ?? text;
  return candidate.length > 300 ? `${candidate.slice(0, 300)}...` : candidate;
}

function extractNestedMessages(text: string): string[] {
  const messages: string[] = [];
  for (const parsed of parseJsonCandidates(text)) {
    collectMessages(parsed, messages);
  }
  return messages;
}

function parseJsonCandidates(text: string): unknown[] {
  const candidates: unknown[] = [];
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    try {
      candidates.push(JSON.parse(text.slice(firstBrace, lastBrace + 1)));
    } catch {
      // Keep the original text as the fallback message.
    }
  }
  return candidates;
}

function collectMessages(value: unknown, messages: string[]): void {
  if (!value || typeof value !== 'object') return;

  if (Array.isArray(value)) {
    for (const item of value) collectMessages(item, messages);
    return;
  }

  const record = value as Record<string, unknown>;
  if (typeof record['message'] === 'string') {
    const message = record['message'] as string;
    messages.push(message);
    for (const nested of parseJsonCandidates(message)) {
      collectMessages(nested, messages);
    }
  }

  for (const item of Object.values(record)) {
    collectMessages(item, messages);
  }
}
