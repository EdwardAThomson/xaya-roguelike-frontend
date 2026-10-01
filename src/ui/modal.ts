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

export interface AmountModalOptions {
  title: string;
  message: string;
  /** Label beside the input. */
  label: string;
  /** Inclusive bounds; the value is clamped and must be a whole number. */
  min: number;
  max: number;
  initial?: number;
  /** Quick-pick buttons offered above the input, as [label, value] pairs. */
  presets?: Array<[string, number]>;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: (value: number) => void;
  onCancel?: () => void;
}

/**
 * Asks for a whole number in a range.  A preset ladder cannot express "stake
 * the 7 gold I actually have", so anything that is genuinely an amount needs
 * a field; the presets stay as shortcuts for the common picks.
 */
export function showAmountModal(opts: AmountModalOptions): void {
  document.getElementById("modal-root")?.remove();

  const root = document.createElement("div");
  root.id = "modal-root";
  root.className = "modal-overlay";
  const start = Math.min(Math.max(opts.initial ?? opts.min, opts.min), opts.max);
  const presets = (opts.presets ?? []).filter(
    ([, v]) => v >= opts.min && v <= opts.max);
  root.innerHTML = `
    <div class="modal modal-info" role="alertdialog" aria-modal="true">
      <div class="modal-title">${escapeHtml(opts.title)}</div>
      <div class="modal-body">${escapeHtml(opts.message)}</div>
      ${presets.length ? `<div class="modal-presets">${presets.map(([l, v]) =>
        `<button class="modal-preset" data-value="${v}">${escapeHtml(l)}</button>`).join("")}</div>` : ""}
      <label class="modal-amount">
        <span>${escapeHtml(opts.label)}</span>
        <input class="modal-amount-input" type="number" inputmode="numeric"
               min="${opts.min}" max="${opts.max}" step="1" value="${start}">
        <span class="modal-amount-max">max ${opts.max}</span>
      </label>
      <div class="modal-amount-error" hidden></div>
      <div class="modal-actions">
        <button class="modal-cancel">${escapeHtml(opts.cancelLabel ?? "Cancel")}</button>
        <button class="modal-dismiss modal-confirm">${escapeHtml(opts.confirmLabel ?? "Confirm")}</button>
      </div>
    </div>
  `;

  const input = root.querySelector(".modal-amount-input") as HTMLInputElement;
  const error = root.querySelector(".modal-amount-error") as HTMLElement;

  /** The entered value when it is a whole number in range, else null. */
  const parsed = (): number | null => {
    const raw = input.value.trim();
    if (raw === "") return null;
    const v = Number(raw);
    if (!Number.isInteger(v) || v < opts.min || v > opts.max) return null;
    return v;
  };

  const close = (accept: boolean) => {
    const v = accept ? parsed() : null;
    if (accept && v === null) {
      error.textContent =
        `Enter a whole number between ${opts.min} and ${opts.max}.`;
      error.hidden = false;
      input.focus();
      input.select();
      return;
    }
    root.remove();
    document.removeEventListener("keydown", onKey);
    if (accept) opts.onConfirm(v as number);
    else opts.onCancel?.();
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); close(false); }
    else if (e.key === "Enter") { e.preventDefault(); close(true); }
  };

  input.addEventListener("input", () => { error.hidden = true; });
  root.querySelectorAll<HTMLButtonElement>(".modal-preset").forEach(b => {
    b.addEventListener("click", () => {
      input.value = b.dataset.value!;
      error.hidden = true;
      input.focus();
    });
  });
  root.addEventListener("click", (e) => { if (e.target === root) close(false); });
  root.querySelector(".modal-cancel")!.addEventListener("click", () => close(false));
  root.querySelector(".modal-confirm")!.addEventListener("click", () => close(true));
  document.addEventListener("keydown", onKey);

  document.body.appendChild(root);
  input.focus();
  input.select();
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
  /**
   * Accent for the dialog frame.  "info" (default) is the teal used when a
   * choice moves the player forward; "warn" is for leaving, forfeiting or
   * anything else where teal would read as encouragement.
   */
  variant?: "info" | "warn";
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
    <div class="modal modal-${opts.variant === "warn" ? "warn" : "info"}" role="alertdialog" aria-modal="true">
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

export interface ItemStakeRow {
  rowid: number;
  label: string;
  /** Dimmer second line: what it is, what it is worth. */
  detail?: string;
  /** Gold worth of the whole row, ItemDef.value times quantity. */
  worth: number;
}

export interface ItemStakeModalOptions {
  title: string;
  message: string;
  rows: ItemStakeRow[];
  /** Rows ticked when the dialog opens. */
  initial?: number[];
  /** Gold already staked, added to the running total but not selectable. */
  goldWorth?: number;
  /** Confirm stays disabled until gold plus picked worth reaches this. */
  floor?: number;
  /** Live advice under the total; null for none.  Never blocks confirm. */
  warning?: (picked: number[]) => string | null;
  /**
   * What to say when the total is below the floor.  Being told you are
   * short is useless on its own: the caller knows what WOULD close the
   * gap (unequipping a sword, usually) and this is where it says so.
   * `short` is how much is missing.
   */
  shortfall?: (short: number) => string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: (rowids: number[]) => void;
  onCancel?: () => void;
}

/**
 * Picks bag rows to stake on a duel.
 *
 * Whole rows only, which is the GSP's rule rather than a UI simplification
 * (docs/PVP_item_staking_checklist.md decision 3): staking part of a stack
 * would mean splitting the row at escrow and merging it back on a refund,
 * so a stack of three potions is all three or none.
 *
 * The running total is gold plus the worth of what is ticked, because that
 * sum is exactly what the GSP measures against a duel's floor.  Equipped
 * gear never appears: only bag rows are stakeable, and the caller filters
 * for that.
 */
export function showItemStakeModal(opts: ItemStakeModalOptions): void {
  document.getElementById("modal-root")?.remove();

  const root = document.createElement("div");
  root.id = "modal-root";
  root.className = "modal-overlay";
  const gold = opts.goldWorth ?? 0;
  const floor = opts.floor ?? 0;
  const picked = new Set<number>(opts.initial ?? []);

  const list = opts.rows.map(r => `
    <label class="modal-stake-row" style="display:flex;align-items:flex-start;
           gap:.5em;padding:.35em .2em;cursor:pointer">
      <input type="checkbox" data-rowid="${r.rowid}"${
        picked.has(r.rowid) ? " checked" : ""} style="margin-top:.25em">
      <span style="flex:1">${escapeHtml(r.label)}${
        r.detail ? `<span class="modal-choice-detail" style="display:block">${
          escapeHtml(r.detail)}</span>` : ""}</span>
    </label>`).join("");

  root.innerHTML = `
    <div class="modal modal-info" role="alertdialog" aria-modal="true">
      <div class="modal-title">${escapeHtml(opts.title)}</div>
      <div class="modal-body">${escapeHtml(opts.message)}</div>
      ${opts.rows.length
        ? `<div class="modal-stake-list" style="max-height:15em;overflow-y:auto;
             margin:.5em 0;border-top:1px solid rgba(128,128,128,.3);
             border-bottom:1px solid rgba(128,128,128,.3)">${list}</div>`
        : `<div class="modal-body" style="opacity:.7">Your bag is empty, so
             there is nothing to stake. Unequip something first if you want
             to wager it.</div>`}
      <div class="modal-stake-total" style="font-weight:600;margin:.3em 0"></div>
      <div class="modal-stake-warning modal-amount-error" hidden></div>
      <div class="modal-actions">
        <button class="modal-cancel">${escapeHtml(opts.cancelLabel ?? "Cancel")}</button>
        <button class="modal-dismiss modal-confirm">${
          escapeHtml(opts.confirmLabel ?? "Confirm")}</button>
      </div>
    </div>
  `;

  const totalEl = root.querySelector(".modal-stake-total") as HTMLElement;
  const warnEl = root.querySelector(".modal-stake-warning") as HTMLElement;
  const confirm = root.querySelector(".modal-confirm") as HTMLButtonElement;

  const refresh = () => {
    const rowids = [...picked];
    const items = opts.rows
      .filter(r => picked.has(r.rowid))
      .reduce((n, r) => n + r.worth, 0);
    const total = gold + items;
    totalEl.textContent = gold > 0
      ? `Putting up ${gold} gold + ${items} in items = ${total}`
      : `Putting up ${items} in items`;
    const short = total < floor;
    confirm.disabled = short;
    const advice = short
      ? (opts.shortfall?.(floor - total)
         ?? `That is below the ${floor} this duel asks for.`)
      : (opts.warning?.(rowids) ?? null);
    warnEl.textContent = advice ?? "";
    warnEl.hidden = advice === null;
  };

  const close = (accept: boolean) => {
    root.remove();
    document.removeEventListener("keydown", onKey);
    if (accept) opts.onConfirm([...picked]);
    else opts.onCancel?.();
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); close(false); }
    else if (e.key === "Enter" && !confirm.disabled) {
      e.preventDefault(); close(true);
    }
  };

  root.querySelectorAll<HTMLInputElement>("input[type=checkbox]").forEach(cb => {
    cb.addEventListener("change", () => {
      const id = Number(cb.dataset.rowid);
      if (cb.checked) picked.add(id); else picked.delete(id);
      refresh();
    });
  });
  root.addEventListener("click", (e) => { if (e.target === root) close(false); });
  root.querySelector(".modal-cancel")!.addEventListener("click", () => close(false));
  confirm.addEventListener("click", () => { if (!confirm.disabled) close(true); });
  document.addEventListener("keydown", onKey);

  document.body.appendChild(root);
  refresh();
  confirm.focus();
}

/**
 * A modal with no way out, for a step the player must simply wait through.
 *
 * Settlement is the case it exists for. It takes a couple of on-chain moves
 * and can take longer when the other side is slow to submit, and until it
 * lands the player cannot move: a line in the log box saying "confirming"
 * while the game ignores every key reads exactly like a hang, which is what
 * it was reported as. Returns a function that updates the text, and one
 * that closes it.
 */
export function showProgressModal(title: string, message: string):
    { update: (m: string) => void; close: () => void } {
  document.getElementById("modal-root")?.remove();

  const root = document.createElement("div");
  root.id = "modal-root";
  root.className = "modal-overlay";
  root.innerHTML = `
    <div class="modal modal-info" role="alertdialog" aria-modal="true">
      <div class="modal-title">${escapeHtml(title)}</div>
      <div class="modal-body modal-progress-body">${escapeHtml(message)}</div>
    </div>
  `;
  // Deliberately no dismiss, no backdrop close and no Escape handler: there
  // is nothing useful to do with the game until this resolves, and letting
  // it be dismissed would put the player back in a world that is about to
  // change under them.
  document.body.appendChild(root);

  const body = root.querySelector(".modal-progress-body") as HTMLElement;
  return {
    update: (m: string) => { body.textContent = m; },
    close: () => { root.remove(); },
  };
}
