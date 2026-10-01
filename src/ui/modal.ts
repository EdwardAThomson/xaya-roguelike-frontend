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
  /** Shown big on the tile.  Defaults to a crate. */
  icon?: string;
  /** Accent for the tile's border, the item's colour in the database. */
  color?: string;
  /** Stack size; a badge on the tile when above one. */
  quantity?: number;
}

/** The host's floor: the least a challenger may put up against them. */
export interface StakeFloorField {
  label: string;
  /** What the field holds for a given stake, until the player edits it. */
  initial: (total: number, itemWorth: number) => number;
  /** Quick picks for a given stake, as [label, value] pairs. */
  presets: (total: number) => Array<[string, number]>;
  /** One line under the field, recomputed as the stake changes. */
  hint?: (total: number, itemWorth: number) => string | null;
}

export interface StakeModalOptions {
  title: string;
  message: string;
  /** Gold field bounds; whole numbers only. */
  goldMax: number;
  goldMin?: number;
  goldInitial?: number;
  goldPresets?: Array<[string, number]>;
  rows: ItemStakeRow[];
  /** Rows ticked when the dialog opens. */
  initial?: number[];
  /** Confirm stays disabled until gold plus picked worth reaches this. */
  floor?: number;
  /** A second field for the host to set the floor they ask of others. */
  floorField?: StakeFloorField;
  /** Live advice under the total; null for none.  Never blocks confirm. */
  warning?: (picked: number[]) => string | null;
  /**
   * What to say when the total is below the floor.  Being told you are
   * short is useless on its own: the caller knows what WOULD close the
   * gap (unequipping a sword, usually) and this is where it says so.
   * `short` is how much is missing.
   */
  shortfall?: (short: number) => string;
  /** Shown in place of the grid when there are no rows. */
  emptyNote?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: (stake: { gold: number; rowids: number[]; minStake: number }) => void;
  onCancel?: () => void;
}

/**
 * The whole duel stake on one screen: a gold field and a grid of the bag
 * rows that can go in alongside it, plus (for a host) the floor they ask of
 * a challenger.  It used to be two or three dialogs in a row, and the floor
 * in particular could only be set after the items, because it is measured
 * against gold and items together; here it just follows the total.
 *
 * Whole rows only, which is the GSP's rule rather than a UI simplification
 * (docs/PVP_item_staking_checklist.md decision 3): staking part of a stack
 * would mean splitting the row at escrow and merging it back on a refund,
 * so a stack of three potions is one tile and is all three or none.
 *
 * The running total is gold plus the worth of what is ticked, because that
 * sum is exactly what the GSP measures against a duel's floor.  Equipped
 * gear never appears: only bag rows are stakeable, and the caller filters
 * for that.
 */
export function showStakeModal(opts: StakeModalOptions): void {
  document.getElementById("modal-root")?.remove();

  const root = document.createElement("div");
  root.id = "modal-root";
  root.className = "modal-overlay";
  const goldMin = Math.min(opts.goldMin ?? 0, opts.goldMax);
  const goldStart = Math.min(Math.max(opts.goldInitial ?? goldMin, goldMin),
                             opts.goldMax);
  const floor = opts.floor ?? 0;
  const picked = new Set<number>(opts.initial ?? []);
  const goldPresets = (opts.goldPresets ?? []).filter(
    ([, v]) => v >= goldMin && v <= opts.goldMax);

  const tiles = opts.rows.map(r => `
    <label class="modal-stake-row${picked.has(r.rowid) ? " picked" : ""}"
           title="${escapeHtml(r.label + (r.detail ? ` (${r.detail})` : ""))}"${
           r.color ? ` style="--tile-accent:${escapeHtml(r.color)}"` : ""}>
      <input type="checkbox" data-rowid="${r.rowid}"${
        picked.has(r.rowid) ? " checked" : ""}>
      <span class="stake-tile-icon">${escapeHtml(r.icon ?? "📦")}</span>${
        (r.quantity ?? 1) > 1
          ? `<span class="stake-tile-qty">x${r.quantity}</span>` : ""}
      <span class="stake-tile-name">${escapeHtml(r.label)}</span>
      <span class="stake-tile-worth">${r.worth}</span>
    </label>`).join("");

  const ff = opts.floorField;
  root.innerHTML = `
    <div class="modal modal-info modal-stake" role="alertdialog" aria-modal="true">
      <div class="modal-title">${escapeHtml(opts.title)}</div>
      <div class="modal-body">${escapeHtml(opts.message)}</div>
      <div class="stake-section-title">Gold</div>
      ${goldPresets.length ? `<div class="modal-presets">${goldPresets.map(([l, v]) =>
        `<button class="modal-preset" data-value="${v}">${escapeHtml(l)}</button>`).join("")}</div>` : ""}
      <label class="modal-amount">
        <input class="modal-amount-input" type="number" inputmode="numeric"
               min="${goldMin}" max="${opts.goldMax}" step="1" value="${goldStart}">
        <span class="modal-amount-max">of ${opts.goldMax}</span>
      </label>
      <div class="stake-section-title">Items from your bag${
        opts.rows.length ? ` <span class="stake-section-note">click to stake</span>` : ""}</div>
      ${opts.rows.length
        ? `<div class="modal-stake-list">${tiles}</div>`
        : `<div class="stake-empty">${escapeHtml(opts.emptyNote ??
            "Your bag is empty, so there are no items to stake.")}</div>`}
      <div class="modal-stake-total"></div>
      ${ff ? `
      <div class="modal-floor" hidden>
        <div class="stake-section-title">${escapeHtml(ff.label)}</div>
        <div class="modal-presets modal-floor-presets"></div>
        <label class="modal-amount">
          <input class="modal-floor-input" type="number" inputmode="numeric"
                 min="0" step="1" value="0">
          <span class="modal-floor-max"></span>
        </label>
        <div class="modal-floor-hint"></div>
      </div>` : ""}
      <div class="modal-stake-warning modal-amount-error" hidden></div>
      <div class="modal-actions">
        <button class="modal-cancel">${escapeHtml(opts.cancelLabel ?? "Cancel")}</button>
        <button class="modal-dismiss modal-confirm">${
          escapeHtml(opts.confirmLabel ?? "Confirm")}</button>
      </div>
    </div>
  `;

  const goldEl = root.querySelector(".modal-amount-input") as HTMLInputElement;
  const totalEl = root.querySelector(".modal-stake-total") as HTMLElement;
  const warnEl = root.querySelector(".modal-stake-warning") as HTMLElement;
  const confirm = root.querySelector(".modal-confirm") as HTMLButtonElement;
  const floorBox = root.querySelector(".modal-floor") as HTMLElement | null;
  const floorEl = root.querySelector(".modal-floor-input") as HTMLInputElement | null;
  const floorPresets = root.querySelector(".modal-floor-presets") as HTMLElement | null;
  const floorMax = root.querySelector(".modal-floor-max") as HTMLElement | null;
  const floorHint = root.querySelector(".modal-floor-hint") as HTMLElement | null;

  /** A whole number in [lo, hi] from a field, else null. */
  const whole = (el: HTMLInputElement, lo: number, hi: number): number | null => {
    const raw = el.value.trim();
    if (raw === "") return null;
    const v = Number(raw);
    return Number.isInteger(v) && v >= lo && v <= hi ? v : null;
  };
  const itemWorth = () => opts.rows
    .filter(r => picked.has(r.rowid))
    .reduce((n, r) => n + r.worth, 0);

  // The floor follows the stake until the player types in it or picks a
  // preset; after that it is theirs and only gets clamped to the new total.
  let floorTouched = false;
  let lastTotal = -1;

  const refresh = () => {
    const gold = whole(goldEl, goldMin, opts.goldMax);
    const items = itemWorth();
    const total = (gold ?? 0) + items;
    totalEl.textContent = `Putting up ${gold ?? "?"} gold + ${items} in items = ${total}`;

    let floorOk = true;
    if (ff && floorEl && floorBox && gold !== null) {
      // A friendly duel has nothing to protect, so no floor to set.
      floorBox.hidden = total === 0;
      if (total !== lastTotal) {
        lastTotal = total;
        floorEl.max = String(total);
        floorMax!.textContent = `of ${total}`;
        if (!floorTouched) floorEl.value = String(ff.initial(total, items));
        else if (Number(floorEl.value) > total) floorEl.value = String(total);
        floorPresets!.innerHTML = ff.presets(total)
          .filter(([, v]) => v >= 0 && v <= total)
          .map(([l, v]) => `<button class="modal-preset" data-value="${v}">${
            escapeHtml(l)}</button>`).join("");
        floorPresets!.querySelectorAll<HTMLButtonElement>(".modal-preset").forEach(b =>
          b.addEventListener("click", () => {
            floorEl.value = b.dataset.value!;
            floorTouched = true;
            refresh();
          }));
      }
      const hint = ff.hint?.(total, items) ?? null;
      floorHint!.textContent = hint ?? "";
      floorHint!.hidden = hint === null;
      floorOk = total === 0 || whole(floorEl, 0, total) !== null;
    }

    let advice: string | null;
    if (gold === null) {
      advice = `Enter a whole number of gold between ${goldMin} and ${opts.goldMax}.`;
    } else if (!floorOk) {
      advice = `Enter a minimum between 0 and ${total}.`;
    } else if (total < floor) {
      advice = opts.shortfall?.(floor - total)
        ?? `That is below the ${floor} this duel asks for.`;
    } else {
      advice = opts.warning?.([...picked]) ?? null;
    }
    confirm.disabled = gold === null || !floorOk || total < floor;
    warnEl.textContent = advice ?? "";
    warnEl.hidden = advice === null;
  };

  const close = (accept: boolean) => {
    if (accept && confirm.disabled) return;
    const gold = whole(goldEl, goldMin, opts.goldMax) ?? 0;
    const total = gold + itemWorth();
    const minStake = ff && floorEl && total > 0
      ? (whole(floorEl, 0, total) ?? 0) : 0;
    root.remove();
    document.removeEventListener("keydown", onKey);
    if (accept) opts.onConfirm({ gold, rowids: [...picked], minStake });
    else opts.onCancel?.();
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); close(false); }
    else if (e.key === "Enter" && !confirm.disabled) {
      e.preventDefault(); close(true);
    }
  };

  root.querySelectorAll<HTMLInputElement>(".modal-stake-row input").forEach(cb => {
    cb.addEventListener("change", () => {
      const id = Number(cb.dataset.rowid);
      if (cb.checked) picked.add(id); else picked.delete(id);
      cb.closest(".modal-stake-row")!.classList.toggle("picked", cb.checked);
      refresh();
    });
  });
  goldEl.addEventListener("input", refresh);
  root.querySelectorAll<HTMLButtonElement>(".modal-presets:not(.modal-floor-presets) .modal-preset")
    .forEach(b => b.addEventListener("click", () => {
      goldEl.value = b.dataset.value!;
      refresh();
    }));
  floorEl?.addEventListener("input", () => { floorTouched = true; refresh(); });
  root.addEventListener("click", (e) => { if (e.target === root) close(false); });
  root.querySelector(".modal-cancel")!.addEventListener("click", () => close(false));
  confirm.addEventListener("click", () => close(true));
  document.addEventListener("keydown", onKey);

  document.body.appendChild(root);
  refresh();
  goldEl.focus();
  goldEl.select();
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
