import type { LLMResponse, LLMStreamEvent, Message } from "../schema.js";
import type {Tool} from "../tools/base.js";
import { RetryConfig } from "../retry.js";


export abstract class LLMClientBase {
    readonly apiKey: string;
    readonly apiBase: string;
    readonly model: string;
    readonly retryConfig: RetryConfig;

    retryCallback: ((error: Error, attempt: number) => void) | null= null;

    constructor(
        apiKey: string,
        apiBase: string,
        model: string,
        retryConfig?: RetryConfig,
    ) {
        this.apiKey = apiKey;
        this.apiBase = apiBase;
        this.model = model;
        this.retryConfig = retryConfig || new RetryConfig() ;
    }

    abstract generate(messages: Message[], tool?: Tool[] | null): Promise<LLMResponse>;

    async *generateStream(
        messages: Message[],
        tool?: Tool[] | null,
    ): AsyncGenerator<LLMStreamEvent, LLMResponse, void> {
        const response = await this.generate(messages, tool);

        if (response.thinking) {
            yield { type: 'thinking_delta', text: response.thinking };
        }
        if (response.content) {
            yield { type: 'content_delta', text: response.content };
        }
        if (response.tool_calls?.length) {
            for (const tc of response.tool_calls) {
                yield { type: 'tool_call', tool_call: tc };
            }
        }
        if (response.usage) {
            yield { type: 'usage', usage: response.usage };
        }

        yield { type: 'done', response };
        return response;
    }

    protected abstract _prepareRequest(messages: Message[], tool?: Tool[] | null): Record<string, unknown>;

    protected abstract _convertMessages(
        messages: Message[],
    ): [string | null, Record<string, unknown>[]];
}
