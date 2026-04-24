import * as fs from 'node:fs';
import * as path from 'node:path';
import { encode } from 'gpt-tokenizer';
import { Colors, calculateDisplayWidth } from './utils/terminal.js';
import type { LLMClient } from './llm/llm-client.js';
import type { Message, ToolCall } from './schema.js';
import type { Tool } from './tools/base.js';
// import { AgentLogger } from './logger.js';
import { RetryExhaustedError } from './retry.js';

const BOX_WIDTH = 58;

function buildSystemPrompt(base: string, workspaceDir: string): string {
    if (base.includes('Current Workspace')) return base;
    return (
        base +
        `\n\n## Current Workspace\nYou are currently working in: \`${workspaceDir}\`\nAll relative paths will be resolved relative to this directory.`
    );
}

export class Agent {
    private readonly llm: LLMClient;
    //surpported tools
    private readonly tools: Map<string, Tool>;
    private readonly maxSteps: number;
    private readonly tokenLimit: number;
    readonly workspaceDir: string;
    readonly systemPrompt: string;
    messages: Message[];

    apiTotalTokens = 0;
    private _skipNextTokenCheck = false;


    constructor({
        llmClient,
        systemPrompt,
        tools,
        maxSteps = 50,
        workspaceDir = './workspace',
        tokenLimit = 80000,
    }: {
        llmClient: LLMClient;
        systemPrompt: string;
        tools: Tool[];
        maxSteps?: number;
        workspaceDir?: string;
        tokenLimit?: number;
    }) {
        this.llm = llmClient;
        this.maxSteps = maxSteps;
        this.tokenLimit = tokenLimit;
        this.workspaceDir = path.resolve(workspaceDir);
        this.tools = new Map(tools.map((t) => [t.name, t]));
        // this.logger = new AgentLogger();

        fs.mkdirSync(this.workspaceDir, { recursive: true });

        this.systemPrompt = buildSystemPrompt(systemPrompt, this.workspaceDir);
        this.messages = [{ role: 'system', content: this.systemPrompt }];
    }


    addUserMessage(content: string): void {
        this.messages.push({ role: 'user', content });
    }

    private _estimateTokens(): number {
        let total = 0;
        for (const msg of this.messages) {
            total += encode(msg.content).length;
            if (msg.role === 'assistant') {
                if (msg.thinking) total += encode(msg.thinking).length;
                if (msg.tool_calls) total += encode(JSON.stringify(msg.tool_calls)).length;
            }
            total += 4; // per-message overhead
        }
        return total;
    }

    private _isCancelled(signal?: AbortSignal): boolean {
        return signal?.aborted ?? false;
    }

    async run(signal?: AbortSignal): Promise<string> {
        // this.logger.startNewRun();
        // console.log(`${Colors.DIM}📝 Log file: ${this.logger.getLogFilePath()}${Colors.RESET}`);

        const runStart = Date.now();

        for (let step = 0; step < this.maxSteps; step++) {
            if (this._isCancelled(signal)) {
                // this._cleanupIncompleteMessages();
                const msg = 'Task cancelled by user.';
                console.log(`\n${Colors.BRIGHT_YELLOW}⚠️  ${msg}${Colors.RESET}`);
                return msg;
            }

            const stepStart = Date.now();
            // await this._summarizeMessages();

            // Step header box
            const stepText = `${Colors.BOLD}${Colors.BRIGHT_CYAN}💭 Step ${step + 1}/${this.maxSteps}${Colors.RESET}`;
            const stepWidth = calculateDisplayWidth(stepText);
            const padding = Math.max(0, BOX_WIDTH - 1 - stepWidth);
            console.log(`\n${Colors.DIM}╭${'─'.repeat(BOX_WIDTH)}╮${Colors.RESET}`);
            console.log(`${Colors.DIM}│${Colors.RESET} ${stepText}${' '.repeat(padding)}${Colors.DIM}│${Colors.RESET}`);
            console.log(`${Colors.DIM}╰${'─'.repeat(BOX_WIDTH)}╯${Colors.RESET}`);

            const toolList = [...this.tools.values()];
            // this.logger.logRequest(this.messages, toolList);

            let response;
            try {
                response = await this.llm.generate(this.messages, toolList);
            } catch (e) {
                let errorMsg: string;
                if (e instanceof RetryExhaustedError) {
                    errorMsg = `LLM call failed after ${e.attempts} retries\nLast error: ${e.lastException.message}`;
                    console.log(`\n${Colors.BRIGHT_RED}❌ Retry failed:${Colors.RESET} ${errorMsg}`);
                } else {
                    errorMsg = `LLM call failed: ${String(e)}`;
                    console.log(`\n${Colors.BRIGHT_RED}❌ Error:${Colors.RESET} ${errorMsg}`);
                }
                return errorMsg;
            }

            if (response.usage) {
                this.apiTotalTokens = response.usage.total_tokens;
            }

            // this.logger.logResponse(
            //     response.content,
            //     response.thinking,
            //     response.tool_calls,
            //     response.finish_reason,
            // );

            // Append assistant message
            this.messages.push({
                role: 'assistant',
                content: response.content,
                thinking: response.thinking,
                tool_calls: response.tool_calls,
            });

            if (response.thinking) {
                console.log(`\n${Colors.BOLD}${Colors.MAGENTA}🧠 Thinking:${Colors.RESET}`);
                console.log(`${Colors.DIM}${response.thinking}${Colors.RESET}`);
            }

            if (response.content) {
                console.log(`\n${Colors.BOLD}${Colors.BRIGHT_BLUE}🤖 Assistant:${Colors.RESET}`);
                console.log(response.content);
            }

            // No tool calls → task complete
            if (!response.tool_calls?.length) {
                const stepElapsed = ((Date.now() - stepStart) / 1000).toFixed(2);
                const totalElapsed = ((Date.now() - runStart) / 1000).toFixed(2);
                console.log(
                    `\n${Colors.DIM}⏱️  Step ${step + 1} completed in ${stepElapsed}s (total: ${totalElapsed}s)${Colors.RESET}`,
                );
                return response.content;
            }

            if (this._isCancelled(signal)) {
                // this._cleanupIncompleteMessages();
                const msg = 'Task cancelled by user.';
                console.log(`\n${Colors.BRIGHT_YELLOW}⚠️  ${msg}${Colors.RESET}`);
                return msg;
            }

            // Execute tool calls
            for (const toolCall of response.tool_calls) {
                const { id: toolCallId, function: fn } = toolCall;
                const { name: functionName, arguments: args } = fn;

                console.log(
                    `\n${Colors.BRIGHT_YELLOW}🔧 Tool Call:${Colors.RESET} ${Colors.BOLD}${Colors.CYAN}${functionName}${Colors.RESET}`,
                );
                console.log(`${Colors.DIM}   Arguments:${Colors.RESET}`);

                // Truncate long argument values for display
                const truncated: Record<string, unknown> = {};
                for (const [k, v] of Object.entries(args)) {
                    const s = String(v);
                    truncated[k] = s.length > 200 ? s.slice(0, 200) + '...' : v;
                }
                for (const line of JSON.stringify(truncated, null, 2).split('\n')) {
                    console.log(`   ${Colors.DIM}${line}${Colors.RESET}`);
                }

                // Execute
                const tool = this.tools.get(functionName);
                let result;
                if (!tool) {
                    result = { success: false, content: '', error: `Unknown tool: ${functionName}` };
                } else {
                    try {
                        result = await tool.execute(args);
                    } catch (e) {
                        const err = e instanceof Error ? e : new Error(String(e));
                        result = {
                            success: false,
                            content: '',
                            error: `Tool execution failed: ${err.message}\n\nStack:\n${err.stack ?? ''}`,
                        };
                    }
                }

                // this.logger.logToolResult(
                //     functionName,
                //     args,
                //     result.success,
                //     result.success ? result.content : undefined,
                //     result.success ? undefined : result.error,
                // );

                if (result.success) {
                    let text = result.content;
                    if (text.length > 300) text = text.slice(0, 300) + `${Colors.DIM}...${Colors.RESET}`;
                    console.log(`${Colors.BRIGHT_GREEN}✓ Result:${Colors.RESET} ${text}`);
                } else {
                    console.log(
                        `${Colors.BRIGHT_RED}✗ Error:${Colors.RESET} ${Colors.RED}${result.error}${Colors.RESET}`,
                    );
                }

                this.messages.push({
                    role: 'tool',
                    content: result.success ? result.content : `Error: ${result.error ?? 'Unknown error'}`,
                    tool_call_id: toolCallId,
                    name: functionName,
                });

                if (this._isCancelled(signal)) {
                    // this._cleanupIncompleteMessages();
                    const msg = 'Task cancelled by user.';
                    console.log(`\n${Colors.BRIGHT_YELLOW}⚠️  ${msg}${Colors.RESET}`);
                    return msg;
                }
            }

            const stepElapsed = ((Date.now() - stepStart) / 1000).toFixed(2);
            const totalElapsed = ((Date.now() - runStart) / 1000).toFixed(2);
            console.log(
                `\n${Colors.DIM}⏱️  Step ${step + 1} completed in ${stepElapsed}s (total: ${totalElapsed}s)${Colors.RESET}`,
            );
        }

        const errorMsg = `Task couldn't be completed after ${this.maxSteps} steps.`;
        console.log(`\n${Colors.BRIGHT_YELLOW}⚠️  ${errorMsg}${Colors.RESET}`);
        return errorMsg;
    }

    getHistory(): Message[] {
    return [...this.messages];
  }


}
