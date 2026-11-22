#!/usr/bin/env node
// hello-test — every live OpenCode pane greets every other once, round-robin,
// and the circle closes when the last greeting arrives back at the origin.
// Only leg 1 is enqueued here; each leg's brief carries the next greeting, so
// the agents pass it along themselves:
//
//   origin → B → C → … → origin     (each participant receives exactly one hello)
//
// Usage:
//   node scripts/hello-test.mjs [--from "Herdr-A2A"] [--dry] [--force]
//
// The mod's "Hello test" section runs this same script and watches the legs
// live (requests whose idempotencyKey starts with "hello-").
//
// Queue safety: one pending request per agent, so a stalled leg blocks that
// agent. This script refuses to start a new round while hello legs are still
// in flight (cancel them first; --force overrides).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { Store } from '../dist/store.js';

const run = promisify(execFile);
const shim = process.env.HERDR_SHIM || `${process.env.HOME}/.local/bin/herdr`;
const DB = `${process.env.HOME}/.config/opencode/opencode-herdr/coordination.sqlite`;
const PENDING = new Set(['queued', 'unknown', 'submitted', 'accepted']);

const flags = { from: 'Herdr-A2A', dry: false, force: false };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--from') flags.from = argv[++i];
  else if (argv[i] === '--dry') flags.dry = true;
  else if (argv[i] === '--force') flags.force = true;
  else { console.error(`Unexpected argument "${argv[i]}"`); process.exit(1); }
}

const { stdout } = await run(shim, ['agent', 'list'], { timeout: 15_000, maxBuffer: 8 * 1024 * 1024 });
const agents = (JSON.parse(stdout)?.result?.agents ?? []).filter(a => !a.conflict || a.conflict <= 1);
const resolve = (needle) => {
  const lower = needle.toLowerCase();
  const found = agents.find(a => a.agent_session?.value === needle)
    ?? agents.find(a => (a.name ?? '').toLowerCase().includes(lower) || (a.cwd ?? '').toLowerCase().includes(lower));
  if (!found) { console.error(`No agent matches "${needle}". Live panes:`); for (const a of agents) console.error(`  ${a.name} (${a.agent_session?.value})`); process.exit(1); }
  return found;
};
const origin = resolve(flags.from);
const others = agents.filter(a => a.agent_session?.value !== origin.agent_session?.value);
const label = (a) => String(a.name ?? a.cwd ?? a.pane_id).replace(/^OC \| /, '').slice(0, 26);

// Full circle: origin greets each other pane in order; the last hop greets
// the origin back, closing the loop. With no other agents, origin greets
// itself — degenerate but still exercises read + handback.
const route = [...others, origin];

// Refuse while a previous hello round still has legs in flight: the store
// allows one pending request per agent, so a stalled leg would queue the new
// round behind it and muddy both runs.
if (!flags.dry && !flags.force) {
  const { createRequire } = await import('node:module');
  const require_ = createRequire(import.meta.url);
  const dbModule = typeof globalThis.Bun !== 'undefined' ? require_('bun:sqlite') : require_('node:sqlite');
  const Database = dbModule.Database ?? dbModule.DatabaseSync;
  let inFlight = [];
  try {
    const db = new Database(DB, { readOnly: true });
    // Effective state mirrors the review projection: a delivery row stays
    // 'accepted' after handback — completion lives in the results table.
    const rows = db.prepare(`SELECT r.id, r.idempotencyKey,
        CASE WHEN r.cancelledAt IS NOT NULL THEN 'cancelled'
             WHEN t.outcome IS NOT NULL THEN t.outcome
             ELSE d.state END AS state
      FROM requests r
      JOIN deliveries d ON d.requestId = r.id AND d.generation = r.generation
      LEFT JOIN results t ON t.requestId = r.id AND t.generation = r.generation
      WHERE r.idempotencyKey LIKE 'hello-%'`).all();
    db.close();
    inFlight = rows.filter((row) => PENDING.has(row.state));
  } catch {}
  if (inFlight.length) {
    console.error(`Refusing: ${inFlight.length} hello leg(s) still in flight — cancel them first:`);
    for (const leg of inFlight) console.error(`  ${leg.id.slice(0, 8)}  ${leg.idempotencyKey}  [${leg.state}]`);
    console.error(`  node scripts/cancel-request.mjs --id <id> --from "${flags.from}"   (or rerun with --force)`);
    process.exit(1);
  }
}

const stamp = Date.now().toString(36).slice(-6);
const legKey = (n) => `hello-${stamp}-leg${n}`;
const N = route.length;

const store = new Store();
const agentId = (sessionId) => createHash('sha256').update(`${store.machineId}\0${sessionId}`).digest('hex');

// Bottom-up brief generation — compact on purpose: short relays are what the
// smaller local models can copy verbatim. Each leg n is delivered to
// route[n-1]; its sender is origin for leg 1, route[n-2] afterwards, so the
// greeting story reads: origin → route[0] → route[1] → … → origin.
let brief = null;
const briefs = new Map();
const senderOf = (n) => (n === 1 ? origin : route[n - 2]);
for (let n = N; n >= 1; n--) {
  const hop = route[n - 1];
  const next = route[n]; // undefined only for the final leg
  const from = label(senderOf(n));
  if (n === N) {
    brief = N === 1
      ? `Hello relay leg 1/1. Call read_task (requestId/generation/deliveryId above), then hand_back completed with summary 'hello circle closed by ${label(hop)}'.`
      : `Hello relay leg ${n}/${N}: ${from} greeted you — the circle is complete! Call read_task (requestId/generation/deliveryId above), then hand_back completed with summary 'leg ${n}/${N}: ${from} greeted ${label(hop)} back — all ${N} agents said hello'.`;
  } else {
    brief = `Hello relay leg ${n}/${N}: ${from} greeted you! Please pass the greeting on to ${label(next)}: Call read_task (requestId/generation/deliveryId above), then request_agent identity "${agentId(next.agent_session.value)}" kind task key "${legKey(n + 1)}" with EXACTLY this text: ${JSON.stringify(brief)} then hand_back completed with summary 'leg ${n}/${N}: ${label(hop)} greeted ${label(next)}'.`;
  }
  briefs.set(n, brief);
}

if (flags.dry) {
  for (const [n, text] of [...briefs.entries()].reverse()) console.log(`— leg ${n}/${N} → ${label(route[n - 1])} (${legKey(n)}) —\n${text}\n`);
  store.close();
  process.exit(0);
}

try {
  const request = store.enqueue({
    originSessionId: origin.agent_session.value,
    originDirectory: origin.cwd,
    recipientId: agentId(route[0].agent_session.value),
    kind: 'task',
    text: briefs.get(1),
    executionPolicy: 'advisory',
    idempotencyKey: legKey(1),
  });
  console.log(`hello run ${stamp}: ${[origin, ...route].map(label).join(' → ')}`);
  console.log(`legs: ${N} · leg 1 requestId ${request.id} (${request.state})`);
  console.log(`watch: the mod's "Hello test" section, or node scripts/watch-store.mjs`);
} finally {
  store.close();
}
