#!/usr/bin/env node
// chain-test — multi-turn relay chains: N hops of sending and receiving across
// the OpenCode panes, ending with an acknowledgement leg back to the starter.
// Only leg 1 is enqueued here; each hop's brief instructs its agent to send the
// next leg, so the chain propagates through the agents themselves.
//
// Usage:
//   node scripts/chain-test.mjs --hops 4 [--from "Herdr-A2A"] [--dry]
//   node scripts/chain-test.mjs --hops 6 [--from "Herdr-A2A"] [--dry]
//
// Routes (linear — never re-dispatches to an agent holding an open task):
//   4 hops: <from> → arcadedb → ICM → myenergi → <from>
//   6 hops: <from> → arcadedb → ICM → myenergi → <from> → arcadedb → ICM
//
// Watch it live: the Coordination panel's Now feed, or node scripts/watch-store.mjs
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { Store } from '../dist/store.js';

const run = promisify(execFile);
const shim = process.env.HERDR_SHIM || `${process.env.HOME}/.local/bin/herdr`;

const argv = process.argv.slice(2);
const flags = { hops: null, from: 'Herdr-A2A', dry: false };
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === '--hops') flags.hops = Number(argv[++i]);
  else if (arg === '--from') flags.from = argv[++i];
  else if (arg === '--dry') flags.dry = true;
  else positional_push_fail(arg);
}
function positional_push_fail(arg) { console.error(`Unexpected argument "${arg}"`); }
if (![4, 6].includes(flags.hops)) {
  console.error('Usage: node scripts/chain-test.mjs --hops 4|6 [--from "Herdr-A2A"] [--dry]');
  process.exit(1);
}

const { stdout } = await run(shim, ['agent', 'list'], { timeout: 15_000, maxBuffer: 8 * 1024 * 1024 });
const agents = JSON.parse(stdout)?.result?.agents ?? [];
const resolve = (needle) => {
  const lower = needle.toLowerCase();
  const found = agents.find(a => a.agent_session?.value === needle)
    ?? agents.find(a => (a.name ?? '').toLowerCase().includes(lower) || (a.cwd ?? '').toLowerCase().includes(lower));
  if (!found) { console.error(`No agent matches "${needle}". Live panes:`); for (const a of agents) console.error(`  ${a.name} (${a.agent_session?.value})`); process.exit(1); }
  return found;
};
const origin = resolve(flags.from);
const arc = resolve('arcadedb');
const icm = resolve('intelligent context manager');
const mye = resolve('myenergi');
const label = (a) => a.name.replace(/^OC \| /, '').slice(0, 26);

// Linear routes; the starter participates as a normal agent at the ack hops.
const route = flags.hops === 4
  ? [arc, icm, mye, origin]
  : [arc, icm, mye, origin, arc, icm];

const store = new Store();
const agentId = (sessionId) => createHash('sha256').update(`${store.machineId}\0${sessionId}`).digest('hex');
const legKey = (n) => `chain${flags.hops}-leg${n}`;

// Bottom-up brief generation: the final hop acknowledges; every earlier hop
// relays the next leg verbatim, then hands back the received summary.
let brief = null;
const briefs = new Map();
for (let n = route.length; n >= 1; n--) {
  const hop = route[n - 1];
  const next = route[n]; // undefined for the final hop
  if (n === route.length) {
    brief = `Chain relay hop ${n}/${route.length}. Step 1: call accept_delivery with the exact requestId, generation and deliveryId from the bracketed line above. Step 2: call hand_back for this task with outcome completed and summary 'chain hop ${n} acknowledged by ${label(hop)}'.`;
  } else {
    brief = `Chain relay hop ${n}/${route.length}. Step 1: call accept_delivery with the exact requestId, generation and deliveryId from the bracketed line above. Step 2: call request_agent with identity "${agentId(next.agent_session.value)}", kind task, executionPolicy advisory, idempotencyKey "${legKey(n + 1)}", and EXACTLY this text: ${JSON.stringify(brief)} Step 3: poll list_requests until that outgoing request shows completed and note its result summary. Step 4: call hand_back for this task with outcome completed and summary 'hop ${n} (${label(hop)}): ${label(next)} replied: <the summary you received>'.`;
  }
  briefs.set(n, brief);
}

if (flags.dry) {
  for (const [n, text] of [...briefs.entries()].reverse()) {
    console.log(`— leg ${n} → ${label(route[n - 1])} (key ${legKey(n)}) —\n${text}\n`);
  }
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
  console.log(`chain: ${route.map(label).join(' → ')}`);
  console.log(`hops: ${flags.hops} sends + the handback cascade back to you`);
  console.log(`leg 1 requestId: ${request.id}  (state ${request.state})`);
  console.log('watch: node scripts/watch-store.mjs  |  the Coordination panel Now feed');
  console.log('each intermediate agent reads its task, sends the next leg, and hands back');
  console.log('the received summary — the cascade ends with handback notices to you.');
} finally {
  store.close();
}
