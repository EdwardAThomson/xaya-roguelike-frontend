# Development Log

## 2026-06-30

A documentation reconciliation pass brought the state docs back in line with the actual engine. The README and ROADMAP had drifted from the code: they claimed 14 monster types and (inconsistently between the two files) 35 or 28 items, while `monsters.ts` actually defines 12 templates and `items.ts` 31 item definitions. Since the monster and item databases are parity-critical against the C++ backend, stale counts in the docs are worse than cosmetic. The README's project-structure tree was also updated to include modules that had shipped but never been documented: `net/validator.ts` (client-side pre-validation mirroring the backend's move parser), `net/pending.ts` (post-submit revalidation to detect silently-dropped moves), and the `ui/` modal and overlay modules.

**Decisions & notes:** Docs-only change; no engine behavior touched.

## 2026-06-28

A big push across two fronts: rounding out overworld/dungeon gameplay and standing up an automated browser-testing stack. On the gameplay side, the overworld was reworked to be coordinate-based with proper gate alignment and entry-gate spawning, and dungeon sessions were switched to use the GSP's effective stats so local play matches the on-chain replay (the core determinism contract). Smaller quality-of-life additions landed too: an inventory and equipment modal with a discard action, persisting the explored map per segment so revisits keep their fog state, auto-selecting same-origin RPC/proxy endpoints when the app is hosted rather than run locally, and sending a transit gate-walk move when leaving a confirmed segment.

The second half of the day built out end-to-end testing from scratch: a headless Playwright harness with a `?e2e` debug hook, then a heuristic self-playing agent that drives the browser as a soak tester, and finally a multi-agent harness where competing players run against a referee. That harness was refactored into a shared `agentcore` and capped off with scripted multiplayer competition tests that assert hard outcomes rather than just smoke-running.

**Decisions & notes:** Dungeon sessions must source stats from the GSP `effective_stats`, never local state, to preserve TS/C++ replay parity. Local rate limiting is off by default, so the test agent needs no throttle flag. The agent cooldown calculation was corrected shortly after the agent landed.
