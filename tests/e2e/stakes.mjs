/**
 * Checks that a duel's staked items changed hands (backend
 * PVP_item_staking_checklist.md item 17), shared by `npm run duel` and
 * `npm run duel:evil`.
 *
 * The GSP never says whose rows are whose in a pot: `staked_items` on a
 * visit is `[{item_id, quantity, worth}]` with the rowids deliberately left
 * out. So each side's stake is read as a difference: the pot after the host
 * opened is the host's, and what the join added is the challenger's.
 * Checked by item id and quantity, because a won stackable merges into the
 * winner's existing stack and keeps no row of its own.
 */

/** `{item_id: quantity}` over a player's bag rows (escrowed ones included). */
export function bagTotals(p) {
  const out = {};
  for (const i of p?.inventory ?? [])
    if (i.slot === "bag") out[i.item_id] = (out[i.item_id] ?? 0) + i.quantity;
  return out;
}

/** `{item_id: quantity}` over a visit's `staked_items`. */
export function potTotals(staked) {
  const out = {};
  for (const s of staked ?? []) out[s.item_id] = (out[s.item_id] ?? 0) + s.quantity;
  return out;
}

/** `a - b`, by item id, dropping the zeros. */
export function minus(a, b) {
  const out = {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const n = (a[k] ?? 0) - (b[k] ?? 0);
    if (n !== 0) out[k] = n;
  }
  return out;
}

export const describe = (t) =>
  Object.entries(t).map(([k, n]) => `${n}x ${k}`).join(", ") || "nothing";

/**
 * The checks, as a list of failure strings (empty when the stakes moved).
 *
 *  - the escrow is empty once the duel has settled;
 *  - the winner holds at least what they held before plus the loser's
 *    stake (at least: they may also bank treasure found in the arena);
 *  - the loser holds exactly what they held before minus their stake (a
 *    death banks no finds and drinks no potions, so nothing else moves).
 *
 * The winner's OWN stake needs no line: it never left their bag, and the
 * "at least before" floor already covers it coming back.
 */
export function stakeTransferFailures({ winner, loser, before, after, loserStake, settledPot }) {
  const out = [];
  if ((settledPot ?? []).length > 0)
    out.push(`the escrow still holds ${describe(potTotals(settledPot))} after settlement`);
  for (const [id, n] of Object.entries(loserStake)) {
    const want = (before[winner][id] ?? 0) + n;
    const got = after[winner][id] ?? 0;
    if (got < want)
      out.push(`${winner} should hold at least ${want}x ${id} (had ` +
               `${before[winner][id] ?? 0}, won ${n}) but holds ${got}`);
    const left = (before[loser][id] ?? 0) - n;
    const kept = after[loser][id] ?? 0;
    if (kept !== left)
      out.push(`${loser} should hold ${left}x ${id} after losing ${n} but holds ${kept}`);
  }
  return out;
}
