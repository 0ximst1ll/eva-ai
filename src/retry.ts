export class RetryConfig {
    readonly enabled: boolean;
    readonly maxRetries: number;
    readonly initalDelay: number;
    readonly maxDelay: number;
    readonly exponentialBase: number;

    constructor({
            enabled = true, // JS: 解构，字段缺失时用 = 后的默认值
            maxRetries = 3,
            initialDelay = 1.0,
            maxDelay = 60.0,
            exponentialBase = 2.0,
        }: Partial<{ //TS: 冒号标注整个参数的类型
            enabled?: boolean;
            maxRetries?: number;
            initialDelay?: number;
            maxDelay?: number;
            exponentialBase?: number;
        }> = {}) { //JS: 整个参数缺失时用 = 后的默认对象
            this.enabled = enabled;
            this.maxRetries = maxRetries;
            this.initalDelay = initialDelay;
            this.maxDelay = maxDelay;
            this.exponentialBase = exponentialBase;

    }

    calculateDelay(attempt: number): number {
        const delay = this.initalDelay * Math.pow(this.exponentialBase, attempt);
        return Math.min(delay, this.maxDelay);
    }

}

export class RetryExhaustedError extends Error {
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

//输入一个异步函数，返回同签名的异步函数(内部有重试能力)
export function withRetry<TArgs extends unknown[], TReturn> ( //泛型约束TArgs必须是数组类型
    fn: (...args: TArgs) => Promise<TReturn>, //类型中的 =>，表示返回值类型。
    config: RetryConfig,
    onRetry?: OnRetryCallback,
): (...args: TArgs) => Promise<TReturn> { //(参数列表) => 返回值类型 函数类型
   return async (...args: TArgs): Promise<TReturn> => { //这里定义一个箭头函数
        let lastError: Error = new Error('Unknown error');

        for (let attempt = 0; attempt < config.maxRetries; attempt++) {
            try {
                return await fn(...args);
            } catch (err) {
                lastError = err instanceof Error ? err : new Error(String(err));

                if(attempt < config.maxRetries) {
                    throw new RetryExhaustedError(lastError, attempt + 1);
                }

                const delay = config.calculateDelay(attempt);

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











    
