/**
 * Non-blocking progress overlay — shown while an on-chain action is
 * being submitted + mined + reflected by the GSP poll.  Lighter weight
 * than the modal (no dismissable button) since the lifecycle is driven
 * by the caller via show()/hide().
 */

let overlayEl: HTMLElement | null = null;
let messageEl: HTMLElement | null = null;

export function showOverlay(message: string): void {
  if (!overlayEl) {
    overlayEl = document.createElement("div");
    overlayEl.id = "processing-overlay";
    overlayEl.className = "processing-overlay";

    const box = document.createElement("div");
    box.className = "processing-box";

    const spinner = document.createElement("div");
    spinner.className = "processing-spinner";
    box.appendChild(spinner);

    messageEl = document.createElement("div");
    messageEl.className = "processing-message";
    box.appendChild(messageEl);

    overlayEl.appendChild(box);
    document.body.appendChild(overlayEl);
  }
  if (messageEl) messageEl.textContent = message;
}

export function updateOverlay(message: string): void {
  if (messageEl) messageEl.textContent = message;
}

export function hideOverlay(): void {
  if (overlayEl) {
    overlayEl.remove();
    overlayEl = null;
    messageEl = null;
  }
}
