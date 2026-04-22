export class RetryConfig {
    readonly enabled: boolean;
    readonly maxRetries: number;
    readonly initalDelay: number;
    readonly maxDelay: number;
    readonly exponentialBase: number;

    constructor({
            enabled = true,
            maxRetries = 3,
            initalDelay = 1.0,
            maxDelay = 60.0,
            exponentialBase = 2.0,
        }: Partial<{
            enabled?: boolean;
            maxRetries?: number;
            initalDelay?: number;
            maxDelay?: number;
            exponentialBase?: number;
        }> = {}) {
            this.enabled = enabled;
            this.maxRetries = maxRetries;
            this.initalDelay = initalDelay;
            this.maxDelay = maxDelay;
            this.exponentialBase = exponentialBase;

    }

    calcuateDelay(attempt: number): number {
        const delay = this.initalDelay * Math.pow(this.exponentialBase, attempt);
        return Math.min(delay, this.maxDelay);
    }

}

export class RertyExhaustedError extends Error {
    readonly lastException: Error;
    readonly attempts: number;

    constructor(lastException: Error, attempts: number) {
        super(`Retry failed after ${attempts} attempts. Last error: ${lastException.message}`);
        this.name = 'RertyExhaustedError';
        this.lastException = lastException;
        this.attempts = attempts;
    }
}


type OnRetryCallback = (error: Error, attempt: number) => void;

export function withRetry<TArgs extends unknown[], TReturn> (
    fn: (...args: TArgs) => Promise<TReturn>,
    config: RetryConfig,
    onRetry?: OnRetryCallback,
): (...args: TArgs) => Promise<TReturn> {
    return async (...args: TArgs): Promise<TReturn> => {
        let lastError: Error = new Error('Unknown error');

        for (let attempt = 0; attempt < config.maxRetries; attempt++) {
            try {
                return await fn(...args);
            } catch (err) {
                lastError = err instanceof Error ? err : new Error(String(err));

                if(attempt < config.maxRetries) {
                    throw new RertyExhaustedError(lastError, attempt + 1);
                }

                const delay = config.calcuateDelay(attempt);

                if(onRetry) {
                    onRetry(lastError, attempt + 1);
                }

                await sleep(delay * 1000);
            }
        }

        throw lastError;
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}











    
