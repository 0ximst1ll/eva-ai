import type { RuntimeHost } from '../core/runtime-host.js';
import { Colors } from '../utils/terminal.js';
import { createCliRenderer } from './cli-ui.js';

export interface PrintModeOptions {
  host: RuntimeHost;
  task: string;
}

export async function runPrintMode({ host, task }: PrintModeOptions): Promise<void> {
  const renderEvent = createCliRenderer({ tools: host.runtime.tools });
  console.log(
    `\n${Colors.BRIGHT_BLUE}Agent${Colors.RESET} ${Colors.DIM}›${Colors.RESET} ${Colors.DIM}Executing task...${Colors.RESET}\n`,
  );

  await host.session.addUserMessage(task);
  try {
    await host.session.run({ onEvent: renderEvent });
  } catch (e) {
    console.log(`\n${Colors.RED}❌ Error: ${e}${Colors.RESET}`);
  }
}
