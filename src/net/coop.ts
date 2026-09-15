/**
 * Multiplayer co-op runtime: a pluggable message transport plus the runner
 * that turns two players' real-time inputs into ONE merged action log both
 * clients agree on (backend docs/SPEC_multiplayer_coop.md, section 2b).
 *
 * The transport is a dumb pipe.  Each client posts only its OWN actions,
 * tagged with a per-participant ordinal, and reads everyone's.  The engine
 * (DungeonSession, N participants) is the synchroniser: a round needs one
 * action from each active participant, applied in canonical order, so a
 * client simply applies participant i's next ordinal whenever the engine
 * says it is i's turn and that action has arrived.  No sequencer, no
 * server-side ordering, and nobody ever writes an action for someone else:
 *
 *   - Waits are self-authored.  If the partner has acted this round and
 *     this player idles past a grace window, THIS client emits its own
 *     wait.  When everyone is idle no round opens and the world freezes.
 *   - An action that turns out to be invalid when its turn comes (the
 *     partner stepped into the tile first, killed the monster first, ...)
 *     is replaced by a wait.  Both clients evaluate validity on the same
 *     state at the same point of the same log, so both substitute
 *     identically and the logs stay byte-identical.  Actions taken on
 *     one's own turn are validated before they are sent, so this only
 *     ever affects actions queued ahead of turn.
 *
 * The relay keeps the full history, so a reloaded client rebuilds the run
 * by fetching from index 0 and draining in engine order.
 *
 * DUELS (backend docs/SPEC_multiplayer_pvp.md) ride this same pipe with no
 * new message kind.  The spec's section 9 speaks of "commit" and "reveal"
 * messages alongside "action"; modelling them as ACTION TYPES instead
 * (session.ts) means they flow through the identical ordinal/queue/drain
 * path, so one mechanism keeps all three in order and the relay needs no
 * idea that duels exist.  What a duel does change is the local client's
 * job per round: the player chooses ONCE, at the commit step, and the
 * runner then emits the reveal and the action by itself.
 */

import { DungeonSession, GameAction, duelCommitHash } from "../game/session.js";
import { loadClaim } from "./moves.js";

/**
 * 16 bytes of randomness as lowercase hex: a duel round's salt (spec §2).
 * Must be unpredictable to the opponent -- it is what makes the round's
 * entropy unbiasable -- so this uses the platform CSPRNG, never Math.random.
 */
export function randomSaltHex(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, x => x.toString(16).padStart(2, "0")).join("");
}

/** One relayed action: who, their per-participant ordinal, and the action. */
export interface CoopMessage {
  from: string;
  n: number;
  action: GameAction;
}

/**
 * The message path between the participants of one visit.  Implementations:
 * the devnet proxy relay (below), later WebRTC and the Xaya gamechannel
 * broadcast.  `poll` returns everything new since the previous poll,
 * including this client's own echoes (the runner de-duplicates by ordinal).
 */
export interface CoopTransport {
  send(msg: { n: number; action: GameAction }): Promise<void>;
  poll(): Promise<CoopMessage[]>;
}

/**
 * Relay through the devnet move proxy (`relay_send` / `relay_recv`
 * actions), which checks the sender's claim token so a partner's actions
 * cannot be spoofed at the relay either.  Same origin as moves, so it
 * works unchanged behind the hosted reverse proxy.
 */
export class ProxyRelayTransport implements CoopTransport {
  private cursor = 0;

  constructor(private proxyUrl: string, private visitId: number,
              private name: string) {}

  async send(msg: { n: number; action: GameAction }): Promise<void> {
    await this.post({
      action: "relay_send",
      name: this.name,
      token: loadClaim(this.name),
      visit: this.visitId,
      msg: { n: msg.n, action: msg.action },
    });
  }

  async poll(): Promise<CoopMessage[]> {
    const resp = (await this.post({
      action: "relay_recv",
      visit: this.visitId,
      since: this.cursor,
    })) as { messages?: Array<{ from?: string; n?: number; action?: GameAction }>; next?: number };
    const out: CoopMessage[] = [];
    for (const m of resp.messages ?? []) {
      if (typeof m.from !== "string" || typeof m.n !== "number" || !m.action) continue;
      out.push({ from: m.from, n: m.n, action: m.action });
    }
    if (typeof resp.next === "number") this.cursor = resp.next;
    return out;
  }

  private async post(body: object): Promise<unknown> {
    const resp = await fetch(this.proxyUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!resp.ok) throw new Error(`Relay error ${resp.status}: ${await resp.text()}`);
    return resp.json();
  }
}

export interface CoopRunnerOptions {
  session: DungeonSession;
  /** This client's canonical participant index. */
  me: number;
  /** Participant names in canonical order (index = canonical index). */
  names: string[];
  transport: CoopTransport;
  /** Idle time after the partner acted before this client auto-waits. */
  graceMs?: number;
  /**
   * Duel only: the fixed tick that bounds the COMMIT step (spec §2c).  A
   * duel round cannot open on "someone acted", because a commit is opaque
   * until it arrives -- two players each waiting to see movement would wait
   * forever -- so the timer runs from the round opening, unconditionally.
   * Not part of consensus: the log records rounds, never ticks.
   */
  tickMs?: number;
  /** Relay poll period. */
  pollMs?: number;
  /** Called after every state change (apply, queue, error) so the UI can redraw. */
  onChange: () => void;
  /** Called with a human-readable note for the message log. */
  onNote?: (text: string, kind: "info" | "warning") => void;
}

export class CoopRunner {
  readonly session: DungeonSession;
  readonly me: number;
  readonly names: string[];

  private transport: CoopTransport;
  private graceMs: number;
  private pollMs: number;
  private onChange: () => void;
  private onNote: (text: string, kind: "info" | "warning") => void;

  /** Per participant: ordinal -> action not yet applied. */
  private queues: Map<number, GameAction>[];
  /** Per participant: next ordinal the engine will consume. */
  private consumed: number[];
  /** Next ordinal this client assigns to its own actions. */
  private mySent = 0;

  /** Unsent own actions (network hiccups), flushed in order. */
  private outbox: { n: number; action: GameAction }[] = [];
  private flushing = false;

  /**
   * Auto-wait bookkeeping.  A round is "waiting on me" only when someone
   * else has contributed to the CURRENT round (their action applied, or
   * queued behind my turn); when everyone is idle no round opens and no
   * wait is ever emitted.  `roundOtherAt` is when another participant's
   * action was applied in the current round (null once the round closes),
   * `otherQueuedAt` when the oldest still-queued other action arrived.
   */
  private roundOtherAt: number | null = null;
  private otherQueuedAt: number | null = null;

  /* ---- Duel state (unused in co-op) -------------------------------- */

  private tickMs: number;
  /** The choice this client sealed for the current round, kept so the
      reveal and the action can be emitted from it without asking the
      player again. */
  private choice: { action: GameAction; salt: string } | null = null;
  /** Round index the current `choice` belongs to, -1 when none. */
  private choiceRound = -1;
  /** Round the commit tick is timing, and when that round opened. */
  private tickRound = -1;
  private tickStartedAt = 0;

  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private graceTimer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  private stopped = false;
  /** Last transport failure, for the UI; cleared on the next success. */
  transportError: string | null = null;

  constructor(opts: CoopRunnerOptions) {
    this.session = opts.session;
    this.me = opts.me;
    this.names = opts.names;
    this.transport = opts.transport;
    this.graceMs = opts.graceMs ?? 700;
    this.tickMs = opts.tickMs ?? 3000;
    this.pollMs = opts.pollMs ?? 300;
    this.onChange = opts.onChange;
    this.onNote = opts.onNote ?? (() => {});
    this.queues = this.names.map(() => new Map());
    this.consumed = this.names.map(() => 0);
  }

  start(): void {
    this.stopped = false;
    void this.pollOnce();
    this.pollTimer = setInterval(() => void this.pollOnce(), this.pollMs);
    this.graceTimer = setInterval(
      () => (this.session.isDuel() ? this.commitTick() : this.graceTick()), 100);
  }

  stop(): void {
    this.stopped = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.graceTimer) clearInterval(this.graceTimer);
    this.pollTimer = null;
    this.graceTimer = null;
  }

  /** True while an own action is queued but not yet applied by the engine. */
  get hasPendingOwn(): boolean {
    return this.mySent > this.consumed[this.me];
  }

  /** Whose action the engine is waiting for, by name. */
  get waitingOn(): string {
    return this.names[this.session.nextActor];
  }

  /** True when the engine is waiting for THIS client's action. */
  get myTurn(): boolean {
    return !this.session.gameOver && this.session.nextActor === this.me
      && !this.hasPendingOwn;
  }

  /**
   * The local player acts.  Returns false when nothing was sent: not
   * active, game over, an own action already in flight, or (on own turn)
   * the action is invalid right now.
   */
  submitLocal(action: GameAction): boolean {
    const s = this.session;
    if (s.gameOver || !s.isPlayerActive(this.me)) return false;
    if (this.hasPendingOwn) return false;

    // In a duel the player's input seals a choice for the round rather
    // than taking it: what goes on the wire now is the COMMITMENT, and the
    // reveal and the action follow automatically once the opponent's
    // commit is in (spec §2).
    if (s.isDuel()) return this.commitChoice(action);

    const n = this.mySent;
    if (s.nextActor === this.me) {
      // Own turn: apply now (validated against the real state), then ship.
      if (!s.processActionBy(this.me, action)) return false;
      this.mySent = n + 1;
      this.consumed[this.me] = n + 1;
      this.afterApplied(this.me);
    } else {
      // Ahead of turn: queue; applied (or substituted) when the turn comes.
      this.queues[this.me].set(n, action);
      this.mySent = n + 1;
    }
    this.outbox.push({ n, action });
    void this.flush();
    this.drain();
    this.onChange();
    return true;
  }

  private async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      while (this.outbox.length > 0 && !this.stopped) {
        const msg = this.outbox[0];
        try {
          await this.transport.send(msg);
          this.outbox.shift();
          this.transportError = null;
        } catch (e) {
          this.transportError = e instanceof Error ? e.message : String(e);
          this.onChange();
          await new Promise(r => setTimeout(r, 1000));
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  private async pollOnce(): Promise<void> {
    if (this.polling || this.stopped) return;
    this.polling = true;
    try {
      const msgs = await this.transport.poll();
      this.transportError = null;
      if (msgs.length > 0) this.onMessages(msgs);
    } catch (e) {
      this.transportError = e instanceof Error ? e.message : String(e);
      this.onChange();
    } finally {
      this.polling = false;
    }
  }

  private onMessages(msgs: CoopMessage[]): void {
    let changed = false;
    for (const m of msgs) {
      const idx = this.names.indexOf(m.from);
      if (idx < 0) continue;                       // not a participant
      if (m.n < this.consumed[idx]) continue;      // already applied (own echo, replay)
      if (idx === this.me) {
        if (m.n < this.mySent) continue;           // own, already queued/applied
        // Own action seen only via the relay: a reload.  Adopt it.
        this.mySent = m.n + 1;
      } else if (this.otherQueuedAt === null) {
        this.otherQueuedAt = Date.now();
      }
      this.queues[idx].set(m.n, m.action);
      changed = true;
    }
    if (changed) {
      this.drain();
      this.onChange();
    }
  }

  /**
   * Applies every action the engine can consume right now, in engine
   * order: whoever's turn it is, if their next ordinal has arrived.
   */
  private drain(): void {
    const s = this.session;
    while (!s.gameOver) {
      const actor = s.nextActor;
      const n = this.consumed[actor];
      const action = this.queues[actor].get(n);
      if (!action) break;
      this.queues[actor].delete(n);
      this.consumed[actor] = n + 1;
      if (!s.processActionBy(actor, action)) {
        // Invalid by the time its turn came: deterministic substitution
        // (both clients do exactly this on the same state).
        s.processActionBy(actor, { type: "wait" });
        this.onNote(
          `${this.names[actor]}'s ${action.type} was blocked; counted as a wait.`,
          "warning");
      }
      this.afterApplied(actor);
    }
    // The engine may now be waiting on this client's reveal or action.
    this.pumpDuel();
  }

  /** Round bookkeeping after participant `actor`'s action was applied. */
  private afterApplied(actor: number): void {
    const s = this.session;
    if (actor !== this.me) this.roundOtherAt = Date.now();
    // The turn wrapping back to (or staying at) an index <= actor means the
    // round closed and the monsters moved: nobody has acted in the new one.
    if (s.gameOver || s.nextActor <= actor) this.roundOtherAt = null;
    // Recompute whether any other participant still has a queued action.
    let anyOther = false;
    for (let i = 0; i < this.queues.length; i++)
      if (i !== this.me && this.queues[i].size > 0) anyOther = true;
    if (!anyOther) this.otherQueuedAt = null;
  }

  /* ================= Duel round protocol (spec §2) ================= */

  /** What the local player is being asked for right now, for the UI. */
  get phaseLabel(): "choose" | "waiting for opponent" | "revealing" | "-" {
    const s = this.session;
    if (!s.isDuel() || s.gameOver) return "-";
    if (s.phase === "commit")
      return this.choiceRound === s.roundIndex ? "waiting for opponent" : "choose";
    if (s.phase === "reveal") return "revealing";
    return "waiting for opponent";
  }

  /** True when the duel is waiting for this player to choose a move. */
  get myChoicePending(): boolean {
    const s = this.session;
    return s.isDuel() && !s.gameOver && s.isPlayerActive(this.me)
      && s.phase === "commit" && this.choiceRound !== s.roundIndex;
  }

  /**
   * Seals `action` for this round: draws a salt, sends the commitment, and
   * remembers both so reveal and apply need no further input.  The salt
   * never leaves this client until the reveal, which is what stops the
   * opponent predicting the round's rolls.
   */
  private commitChoice(action: GameAction): boolean {
    const s = this.session;
    if (s.phase !== "commit") return false;
    if (this.choiceRound === s.roundIndex) return false;   // already sealed

    const salt = randomSaltHex();
    this.choice = { action, salt };
    this.choiceRound = s.roundIndex;
    return this.emit({
      type: "commit",
      hex: duelCommitHash(s.duelVisitId, s.roundIndex, this.me, action, salt),
    });
  }

  /**
   * Emits whatever the round protocol owes next from the sealed choice: the
   * reveal once both commits are in, then the action once both reveals are.
   * Called after every drain, so it fires as soon as the opponent's message
   * lands rather than on a timer.
   */
  private pumpDuel(): void {
    const s = this.session;
    if (!s.isDuel() || s.gameOver) return;
    if (!s.isPlayerActive(this.me)) return;
    if (this.hasPendingOwn || s.nextActor !== this.me) return;
    if (!this.choice || this.choiceRound !== s.roundIndex) return;

    if (s.phase === "reveal") this.emit({ type: "reveal", hex: this.choice.salt });
    else if (s.phase === "act") this.emit(this.choice.action);
  }

  /**
   * Queues and ships one of this client's own protocol entries.  Applies it
   * straight away when the engine is already waiting for it, so the local
   * view never lags the wire.
   */
  private emit(action: GameAction): boolean {
    const s = this.session;
    const n = this.mySent;
    if (s.nextActor === this.me) {
      if (!s.processActionBy(this.me, action)) return false;
      this.mySent = n + 1;
      this.consumed[this.me] = n + 1;
      this.afterApplied(this.me);
    } else {
      this.queues[this.me].set(n, action);
      this.mySent = n + 1;
    }
    this.outbox.push({ n, action });
    void this.flush();
    this.drain();
    this.onChange();
    return true;
  }

  /**
   * The fixed tick (spec §2c): if the player has not chosen by the
   * deadline, this client commits a WAIT for them -- self-authored, exactly
   * like co-op's grace wait.  Runs from the round opening rather than from
   * the opponent acting, because a commit is invisible until it arrives and
   * two clients each waiting for the other would wait forever.
   */
  private commitTick(): void {
    const s = this.session;
    if (s.gameOver || !s.isPlayerActive(this.me)) return;

    if (this.tickRound !== s.roundIndex) {
      this.tickRound = s.roundIndex;
      this.tickStartedAt = Date.now();
      return;
    }
    if (!this.myChoicePending) return;
    if (Date.now() - this.tickStartedAt < this.tickMs) return;
    this.submitLocal({ type: "wait" });
  }

  /** Self-authored wait after the partner acted and this player idled. */
  private graceTick(): void {
    const s = this.session;
    if (s.gameOver || !s.isPlayerActive(this.me)) return;
    if (this.hasPendingOwn) return;
    if (s.nextActor !== this.me) return;
    // A round is waiting on me only if someone else contributed to it:
    // their action applied this round, or queued behind my turn.
    const since = this.otherQueuedAt ?? this.roundOtherAt;
    if (since === null) return;
    if (Date.now() - since < this.graceMs) return;
    this.submitLocal({ type: "wait" });
  }
}
