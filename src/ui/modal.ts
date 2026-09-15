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

export interface ConfirmModalOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel?: () => void;
  /**
   * If false, Esc and backdrop click do NOT dismiss the modal — the
   * user must click one of the two buttons explicitly.  Useful when
   * both choices have consequences (e.g. reconnect prompt: Continue
   * vs Forfeit) and a stray Esc could fire the wrong one.  Defaults
   * to true (standard confirm behaviour).
   */
  dismissibleByEscape?: boolean;
}

/**
 * Two-button confirmation modal.  Confirm is focused by default so the
 * user can press Enter to accept (or Esc / Cancel button to back out).
 */
export function showConfirmModal(opts: ConfirmModalOptions): void {
  document.getElementById("modal-root")?.remove();

  const root = document.createElement("div");
  root.id = "modal-root";
  root.className = "modal-overlay";
  root.innerHTML = `
    <div class="modal modal-info" role="alertdialog" aria-modal="true">
      <div class="modal-title">${escapeHtml(opts.title)}</div>
      <div class="modal-body">${escapeHtml(opts.message)}</div>
      <div class="modal-actions">
        <button class="modal-cancel">${escapeHtml(opts.cancelLabel ?? "Cancel")}</button>
        <button class="modal-dismiss modal-confirm">${escapeHtml(opts.confirmLabel ?? "Confirm")}</button>
      </div>
    </div>
  `;

  const close = (accept: boolean) => {
    root.remove();
    document.removeEventListener("keydown", onKey);
    if (accept) opts.onConfirm();
    else opts.onCancel?.();
  };

  const escDismissible = opts.dismissibleByEscape ?? true;
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" && escDismissible) {
      e.preventDefault();
      close(false);
    } else if (e.key === "Enter") {
      e.preventDefault();
      close(true);
    }
  };

  root.addEventListener("click", (e) => {
    if (e.target === root && escDismissible) close(false);
  });
  root.querySelector(".modal-cancel")!.addEventListener("click", () => close(false));
  root.querySelector(".modal-confirm")!.addEventListener("click", () => close(true));
  document.addEventListener("keydown", onKey);

  document.body.appendChild(root);
  (root.querySelector(".modal-confirm") as HTMLButtonElement).focus();
}

export interface ChoiceModalOptions {
  title: string;
  message: string;
  /**
   * The actions offered, in order.  The last one gets focus, matching the
   * confirm modal.  `detail` is a dimmer second line under the label.
   * A `disabled` choice is shown but cannot be picked -- use it when the
   * option genuinely exists and the reason it is unavailable belongs in
   * `detail` (an unaffordable duel stake, say); hide it instead when its
   * existence is not worth explaining.
   */
  choices: Array<{
    label: string; detail?: string; disabled?: boolean; onPick: () => void;
  }>;
  cancelLabel?: string;
  onCancel?: () => void;
}

/**
 * A modal offering several actions rather than a yes/no.  Used where a
 * single step has genuinely different outcomes, such as standing on a gate
 * with a co-op run waiting on the other side of it.  Escape and the
 * backdrop cancel.
 */
export function showChoiceModal(opts: ChoiceModalOptions): void {
  document.getElementById("modal-root")?.remove();

  const root = document.createElement("div");
  root.id = "modal-root";
  root.className = "modal-overlay";
  const buttons = opts.choices.map((c, i) =>
    `<button class="modal-choice" data-choice="${i}"${c.disabled ? " disabled" : ""}>${
      escapeHtml(c.label)}${
      c.detail ? `<span class="modal-choice-detail">${escapeHtml(c.detail)}</span>` : ""
    }</button>`).join("");
  root.innerHTML = `
    <div class="modal modal-info" role="alertdialog" aria-modal="true">
      <div class="modal-title">${escapeHtml(opts.title)}</div>
      <div class="modal-body">${escapeHtml(opts.message)}</div>
      <div class="modal-actions modal-actions-stacked">
        <button class="modal-cancel">${escapeHtml(opts.cancelLabel ?? "Cancel")}</button>
        ${buttons}
      </div>
    </div>
  `;

  const close = (pick: number | null) => {
    root.remove();
    document.removeEventListener("keydown", onKey);
    if (pick === null) opts.onCancel?.();
    else opts.choices[pick].onPick();
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); close(null); }
  };

  root.addEventListener("click", (e) => { if (e.target === root) close(null); });
  root.querySelector(".modal-cancel")!.addEventListener("click", () => close(null));
  root.querySelectorAll<HTMLButtonElement>(".modal-choice").forEach(btn => {
    if (btn.disabled) return;
    btn.addEventListener("click", () => close(Number(btn.dataset.choice)));
  });
  document.addEventListener("keydown", onKey);

  document.body.appendChild(root);
  const pickable = Array.from(
    root.querySelectorAll<HTMLButtonElement>(".modal-choice")).filter(b => !b.disabled);
  (pickable[pickable.length - 1]
    ?? root.querySelector(".modal-cancel") as HTMLButtonElement).focus();
}
