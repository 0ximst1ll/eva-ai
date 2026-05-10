/**
 * AssistantMessage component — composite component for streaming agent responses.
 */

import type { Component } from '../tui.js';
import { Container } from '../tui.js';
import { Text } from './text.js';
import { Markdown } from './markdown.js';
import { Loader } from './loader.js';
import { Colors } from '../../utils/terminal.js';

export interface AssistantMessageOptions {
  onUpdate: () => void;
}

export class AssistantMessage implements Component {
  private container = new Container();
  
  private thinkingActive = false;
  private thinkingContent = '';
  private thinkingMarkdown: Markdown;
  
  private contentActive = false;
  private contentText = '';
  private contentMarkdown: Markdown;

  private loader: Loader;

  constructor(options: AssistantMessageOptions) {
    this.thinkingMarkdown = new Markdown({ content: '' });
    this.contentMarkdown = new Markdown({ content: '' });
    this.loader = new Loader({ text: 'Agent is thinking...', onUpdate: options.onUpdate });
    
    // Initial state: just the loader
    this.container.addChild(this.loader);
    this.loader.start();
  }

  addThinkingDelta(delta: string): void {
    if (!this.thinkingActive) {
      this.thinkingActive = true;
      this.container.removeChild(this.loader); // Remove from bottom
      this.container.addChild(new Text({ content: `\n${Colors.BOLD}${Colors.MAGENTA}🧠 Thinking:${Colors.RESET}` }));
      this.container.addChild(this.thinkingMarkdown);
      this.container.addChild(this.loader); // Re-add at bottom
    }
    
    this.thinkingContent += delta;
    this.thinkingMarkdown.setContent(this.thinkingContent);
  }

  addContentDelta(delta: string): void {
    if (!this.contentActive) {
      this.contentActive = true;
      this.container.removeChild(this.loader); // Remove from bottom
      this.loader.setText('Agent is typing...');
      this.container.addChild(new Text({ content: `\n${Colors.BOLD}${Colors.BRIGHT_BLUE}🤖 Assistant:${Colors.RESET}` }));
      this.container.addChild(this.contentMarkdown);
      this.container.addChild(this.loader); // Re-add at bottom
    }

    this.contentText += delta;
    this.contentMarkdown.setContent(this.contentText);
  }

  finish(elapsedMs: number): void {
    this.container.removeChild(this.loader);
    this.loader.stop();
    this.container.addChild(new Text({ content: `\n${Colors.DIM}⏱️  Completed in ${(elapsedMs / 1000).toFixed(2)}s${Colors.RESET}` }));
  }

  invalidate(): void {
    this.container.invalidate();
  }

  render(width: number): string[] {
    return this.container.render(width);
  }
}
