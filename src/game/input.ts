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

export class InputHandler {
  private callback: InputCallback;

  constructor(callback: InputCallback) {
    this.callback = callback;
    document.addEventListener("keydown", (e) => this.onKey(e));
  }

  private onKey(e: KeyboardEvent): void {
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
