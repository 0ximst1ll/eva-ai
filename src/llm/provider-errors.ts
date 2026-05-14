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
}

const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

export function formatProviderError(error: unknown): FormattedProviderError {
  const raw = formatRawError(error);
  const statusCode = extractStatusCode(raw);
  const searchable = `${raw}\n${extractNestedMessages(raw).join('\n')}`;
  const category = classifyProviderError(searchable, statusCode);

  return {
    raw,
    category,
    statusCode,
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
