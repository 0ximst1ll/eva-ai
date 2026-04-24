import type { LLMResponse, Message } from "../schema.js";  
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

    protected abstract _prepareRequest(messages: Message[], tool?: Tool[] | null): Record<string, unknown>;

    protected abstract _convertMessages(
        messages: Message[],
    ): [string | null, Record<string, unknown>[]];
}