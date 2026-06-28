/**
 * Keyboard input handler.
 */

export type Direction = { dx: number; dy: number };

const keyMap: Record<string, Direction> = {
  // Arrow keys.
  "ArrowUp":    { dx: 0,  dy: -1 },
  "ArrowDown":  { dx: 0,  dy: 1 },
  "ArrowLeft":  { dx: -1, dy: 0 },
  "ArrowRight": { dx: 1,  dy: 0 },
  // WASD.
  "w": { dx: 0,  dy: -1 },
  "s": { dx: 0,  dy: 1 },
  "a": { dx: -1, dy: 0 },
  "d": { dx: 1,  dy: 0 },
  // Diagonals (numpad style).
  "q": { dx: -1, dy: -1 },
  "e": { dx: 1,  dy: -1 },
  "z": { dx: -1, dy: 1 },
  "c": { dx: 1,  dy: 1 },
};

export type InputCallback = (action: string, dir?: Direction) => void;

/**
 * True when the keydown target is something the user is typing into:
 * an input, textarea, select, or contenteditable element.  Used to
 * skip game-key interception so form fields work normally.
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return target.isContentEditable;
}

export class InputHandler {
  private callback: InputCallback;

  constructor(callback: InputCallback) {
    this.callback = callback;
    document.addEventListener("keydown", (e) => this.onKey(e));
  }

  private onKey(e: KeyboardEvent): void {
    // Don't intercept keystrokes while the user is typing into a form
    // control or contenteditable element — they need those keys for
    // actual text input.  Without this, a/w/s/d/q/e/z/c/g/p/Enter/Space
    // get swallowed by preventDefault() and never reach the input.
    if (isEditableTarget(e.target)) return;

    // Movement.
    const dir = keyMap[e.key];
    if (dir) {
      e.preventDefault();
      this.callback("move", dir);
      return;
    }

    // Other actions.
    switch (e.key) {
      case "g":
      case "G":
        e.preventDefault();
        this.callback("pickup");
        break;
      case " ":
        e.preventDefault();
        this.callback("wait");
        break;
      case "Enter":
        e.preventDefault();
        this.callback("gate");
        break;
      case "p":
      case "P":
        e.preventDefault();
        this.callback("use_potion");
        break;
    }
  }
}
