/** Held-key tracking with press order (for last-pressed-wins steering). */
export class KeyboardState {
  private readonly held = new Map<string, number>();
  private seq = 0;

  press(code: string): void {
    if (!this.held.has(code)) this.held.set(code, ++this.seq);
  }

  release(code: string): void {
    this.held.delete(code);
  }

  clear(): void {
    this.held.clear();
  }

  isDown(code: string): boolean {
    return this.held.has(code);
  }

  any(codes: readonly string[]): boolean {
    for (const c of codes) if (this.held.has(c)) return true;
    return false;
  }

  /** Most recent press order among the given codes (0 if none held). */
  order(codes: readonly string[]): number {
    let o = 0;
    for (const c of codes) {
      const v = this.held.get(c);
      if (v !== undefined && v > o) o = v;
    }
    return o;
  }
}

/** Some virtual keyboards report an empty `code`; map the common keys from `key`. */
export function codeOf(e: KeyboardEvent): string {
  if (e.code) return e.code;
  switch (e.key) {
    case 'ArrowUp': case 'ArrowDown': case 'ArrowLeft': case 'ArrowRight':
    case 'Enter': case 'Escape': case 'Backspace': case 'PageUp': case 'PageDown':
      return e.key;
    case ' ': return 'Space';
    case 'Esc': return 'Escape';
    default: {
      if (e.key.length === 1) {
        const ch = e.key.toUpperCase();
        if (ch >= 'A' && ch <= 'Z') return `Key${ch}`;
        if (ch >= '0' && ch <= '9') return `Digit${ch}`;
      }
      return e.key;
    }
  }
}

/** True when the event target is a text-entry control (menus must not steal typing). */
export function isTextField(t: EventTarget | null): boolean {
  if (!t || !(t instanceof HTMLElement)) return false;
  if (t.isContentEditable) return true;
  if (t instanceof HTMLTextAreaElement) return true;
  if (t instanceof HTMLInputElement) {
    const type = t.type;
    return type === 'text' || type === 'search' || type === 'email' || type === 'password' || type === 'url' || type === 'tel' || type === 'number';
  }
  return false;
}
