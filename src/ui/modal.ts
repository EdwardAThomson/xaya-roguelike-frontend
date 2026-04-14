/**
 * Blocking modal dialog for errors and other hard-to-miss notifications.
 *
 * The game logs less-important messages to the message panel in the
 * sidebar — that panel scrolls and can be missed.  Modals are reserved
 * for things the player needs to acknowledge before continuing:
 * rejected moves, lost HP, etc.
 */

export interface ModalOptions {
  title: string;
  message: string;
  /** "error" (default) | "info" — changes border colour and title tint. */
  variant?: "error" | "info";
  /** Label for the primary button. Default: "Dismiss". */
  dismissLabel?: string;
  /** Called when the modal is dismissed (button, backdrop, or Esc). */
  onDismiss?: () => void;
}

function escapeHtml(s: string): string {
  const map: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  };
  return s.replace(/[&<>"']/g, (c) => map[c]!);
}

export function showModal(opts: ModalOptions): void {
  // Only one modal at a time — replace any existing one.
  document.getElementById("modal-root")?.remove();

  const variant = opts.variant ?? "error";

  const root = document.createElement("div");
  root.id = "modal-root";
  root.className = "modal-overlay";
  root.innerHTML = `
    <div class="modal modal-${variant}" role="alertdialog" aria-modal="true">
      <div class="modal-title">${escapeHtml(opts.title)}</div>
      <div class="modal-body">${escapeHtml(opts.message)}</div>
      <div class="modal-actions">
        <button class="modal-dismiss">${escapeHtml(opts.dismissLabel ?? "Dismiss")}</button>
      </div>
    </div>
  `;

  const dismiss = () => {
    root.remove();
    document.removeEventListener("keydown", onKey);
    opts.onDismiss?.();
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" || e.key === "Enter") {
      e.preventDefault();
      dismiss();
    }
  };

  // Backdrop click dismisses.
  root.addEventListener("click", (e) => {
    if (e.target === root) dismiss();
  });
  root.querySelector(".modal-dismiss")!.addEventListener("click", dismiss);
  document.addEventListener("keydown", onKey);

  document.body.appendChild(root);

  // Focus the button so Enter/Space dismisses it immediately.
  (root.querySelector(".modal-dismiss") as HTMLButtonElement).focus();
}

/** Convenience shorthand for error modals. */
export function showErrorModal(title: string, message: string): void {
  showModal({ title, message, variant: "error" });
}

/** Convenience shorthand for info modals. */
export function showInfoModal(title: string, message: string): void {
  showModal({ title, message, variant: "info" });
}
