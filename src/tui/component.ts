export interface Component {
  render(width: number): string[];
  handleInput?(data: string): void;
  invalidate(): void;
}

/**
 * Components that display a hardware cursor implement this interface.
 * When `focused` is true the component should embed CURSOR_MARKER in its
 * render output so TUI can position the hardware cursor there.
 */
export interface Focusable {
  focused: boolean;
}

export function isFocusable(c: Component | null): c is Component & Focusable {
  return c !== null && 'focused' in c;
}

export class Container implements Component {
  children: Component[] = [];

  addChild(component: Component): void {
    this.children.push(component);
  }

  removeChild(component: Component): void {
    const index = this.children.indexOf(component);
    if (index !== -1) this.children.splice(index, 1);
  }

  clear(): void {
    this.children = [];
  }

  invalidate(): void {
    for (const child of this.children) child.invalidate();
  }

  render(width: number): string[] {
    const lines: string[] = [];
    for (const child of this.children) {
      for (const line of child.render(width)) lines.push(line);
    }
    return lines;
  }
}
