#!/usr/bin/env node
// hello-test — the agent-to-agent relay: the button starts leg 1 and the
// agents cascade it themselves — leg 1's agent creates leg 2, leg 2's creates
// leg 3, … until the circle closes back on the origin. That cascade IS the
// proof this mod exists for: agents calling each other.
//
// Modes:
//   relay (default) — the cascade above. Each agent must construct the next
//     leg's request itself (byte-exact nested brief). The integrity guard
//     brands handbacks that claim a relay that never fired.
//   --flat — reliability fallback: the origin enqueues one short greeting per
//     other agent (read_task + hand_back only). This proves transport and
//     acceptance but NOT agent-calls-agent — use it deliberately.
//
// Usage:
//   node scripts/hello-test.mjs [--from "Herdr-A2A"] [--flat] [--dry] [--force]
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
const DB = `${process.env.HOME}/.config/opencode/supreme-consciousness/coordination.sqlite`;
const PENDING = new Set(['queued', 'unknown', 'submitted', 'accepted']);

const flags = { from: 'Herdr-A2A', flat: false, dry: false, force: false };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--from') flags.from = argv[++i];
  else if (argv[i] === '--flat') flags.flat = true;
  else if (argv[i] === '--dry') flags.dry = true;
  else if (argv[i] === '--force') flags.force = true;
  else { console.error(`Unexpected argument "${argv[i]}"`); process.exit(1); }
}

const { stdout } = await run(shim, ['agent', 'list'], { timeout: 15_000, maxBuffer: 8 * 1024 * 1024 });
const store = new Store();
// Observe before enqueueing — the same inventory pass the delivery workers
// run. This pins every live pane into the store (the shim may report sessions
// the workers have not observed yet, e.g. right after a /new), so the
// recipient rows exist when enqueue resolves their agent records.
const { inventory } = await import('../dist/delivery.js');
const observed = await inventory(store).catch(() => []);
const agents = (observed.length ? observed : (JSON.parse(stdout)?.result?.agents ?? []).filter(a => !a.conflict || a.conflict <= 1).map(a => ({
  id: createHash('sha256').update(`${store.machineId}\0${a.agent_session.value}`).digest('hex'),
  sessionId: a.agent_session.value,
  directory: a.cwd, label: a.name, paneId: a.pane_id, terminalId: a.terminal_id,
  workspaceId: a.workspace_id, state: a.agent_status, lastSeen: Date.now(),
})));
const resolve = (needle) => {
  const lower = needle.toLowerCase();
  const found = agents.find(a => a.sessionId === needle)
    ?? agents.find(a => (a.label ?? '').toLowerCase().includes(lower) || (a.directory ?? '').toLowerCase().includes(lower));
  if (!found) { console.error(`No agent matches "${needle}". Live panes:`); for (const a of agents) console.error(`  ${a.label ?? a.sessionId} (${a.sessionId})`); process.exit(1); }
  return found;
};
const origin = resolve(flags.from);
const others = agents.filter(a => a.sessionId !== origin.sessionId);
const label = (a) => String(a.label ?? a.directory ?? a.paneId).replace(/^OC \| /, '').slice(0, 26);

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
const agentId = (sessionId) => createHash('sha256').update(`${store.machineId}\0${sessionId}`).digest('hex');

if (!flags.flat) {
  // —— relay mode (the design): the agent-to-agent cascade ——
  // Full circle: origin greets the first agent, who greets the next, … and the
  // last greeting lands back on the origin. Each leg's brief carries the next
  // verbatim, so the agents pass it along themselves.
  const route = [...others, origin];
  const N = route.length;

  // Bottom-up brief generation — each leg n is delivered to route[n-1]; its
  // sender is origin for leg 1, route[n-2] afterwards, so the greeting story
  // reads: origin → route[0] → route[1] → … → origin.
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
      brief = `Hello relay leg ${n}/${N}: ${from} greeted you! Please pass the greeting on to ${label(next)}: Call read_task (requestId/generation/deliveryId above), then request_agent identity "${agentId(next.sessionId)}" kind task key "${legKey(n + 1)}" with EXACTLY this text: ${JSON.stringify(brief)} then hand_back completed with summary 'leg ${n}/${N}: ${label(hop)} greeted ${label(next)}'.`;
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
      originSessionId: origin.sessionId,
      originDirectory: origin.directory,
      recipientId: agentId(route[0].sessionId),
      kind: 'task',
      text: briefs.get(1),
      executionPolicy: 'advisory',
      idempotencyKey: legKey(1),
    });
    console.log(`hello run ${stamp} (relay): ${[origin, ...route].map(label).join(' → ')}`);
    console.log(`legs: ${N} · leg 1 requestId ${request.id} (${request.state})`);
    console.log(`watch: the mod's "Hello test" section, or node scripts/watch-store.mjs`);
  } finally {
    store.close();
  }
  process.exit(0);
}

// —— flat mode (--flat): the reliability fallback ——
// One short, independent greeting per other agent. Proves transport,
// acceptance and handback — but the origin orchestrates; agents do not call
// each other, so this mode does not carry the mod's proof.
const M = others.length;
if (M === 0) { console.error('No other live agents to greet.'); store.close(); process.exit(1); }
const briefs = others.map((hop, index) => ({
  hop, key: legKey(index + 1),
  text: `Hello across the mesh — greeting leg ${index + 1}/${M}: ${label(origin)} greets ${label(hop)}! Call read_task (requestId/generation/deliveryId above) to accept it, then hand_back completed with summary 'leg ${index + 1}/${M}: ${label(hop)} acknowledged the hello from ${label(origin)}'.`,
}));
if (flags.dry) {
  for (const b of briefs) console.log(`— ${b.key} → ${label(b.hop)} —\n${b.text}\n`);
  store.close();
  process.exit(0);
}
try {
  const enqueued = briefs.map(b => store.enqueue({
    originSessionId: origin.sessionId,
    originDirectory: origin.directory,
    recipientId: agentId(b.hop.sessionId),
    kind: 'task',
    text: b.text,
    executionPolicy: 'advisory',
    idempotencyKey: b.key,
  }));
  console.log(`hello run ${stamp} (flat): ${label(origin)} greets ${others.map(label).join(', ')}`);
  console.log(`legs: ${M} enqueued · first requestId ${enqueued[0].id} (${enqueued[0].state})`);
  console.log(`watch: the mod's "Hello test" section, or node scripts/watch-store.mjs`);
} finally {
  store.close();
}
