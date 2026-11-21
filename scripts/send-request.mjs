#!/usr/bin/env node
// send-request — trigger an agent-to-agent request from a terminal, the same
// way the request_agent tool does. Owner path: this writes to the coordination
// store directly and is meant for the person running this machine.
//
// Usage:
//   node scripts/send-request.mjs --to "arcadedb" --from "Herdr-A2A" \
//        [--kind task|instruction] [--policy advisory|code_change] \
//        [--key <idempotencyKey>] "The task or instruction text"
//
// --to / --from accept a case-insensitive SUBSTRING of the pane label, or an
// exact session id (ses_…). Labels come from the herdr shim's inventory.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { Store } from '../dist/store.js';

const run = promisify(execFile);
const shim = process.env.HERDR_SHIM || `${process.env.HOME}/.local/bin/herdr`;

const argv = process.argv.slice(2);
const flags = { to: null, from: null, kind: 'task', policy: 'advisory', key: null };
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === '--to') flags.to = argv[++i];
  else if (arg === '--from') flags.from = argv[++i];
  else if (arg === '--kind') flags.kind = argv[++i];
  else if (arg === '--policy') flags.policy = argv[++i];
  else if (arg === '--key') flags.key = argv[++i];
  else if (arg === '--help' || arg === '-h') { usage(); process.exit(0); }
  else positional.push(arg);
}
function usage() {
  console.log(`Usage:
  node scripts/send-request.mjs --to <pane-label-substring|ses_…> --from <pane-label-substring|ses_…> \\
       [--kind task|instruction] [--policy advisory|code_change] [--key <idempotencyKey>] "text"

Example:
  node scripts/send-request.mjs --to arcadedb --from "Herdr-A2A" \\
       "Report how many ArcadeDB vertices exist; hand_back when done."`);
}
if (!flags.to || !flags.from || positional.length === 0) { usage(); process.exit(1); }
const text = positional.join(' ');
if (!['task', 'instruction'].includes(flags.kind)) { console.error('--kind must be task or instruction'); process.exit(1); }
if (!['advisory', 'code_change'].includes(flags.policy)) { console.error('--policy must be advisory or code_change'); process.exit(1); }

const { stdout } = await run(shim, ['agent', 'list'], { timeout: 15_000, maxBuffer: 8 * 1024 * 1024 });
const agents = JSON.parse(stdout)?.result?.agents ?? [];
const resolve = (needle) => {
  const bySession = agents.find(a => a.agent_session?.value === needle);
  if (bySession) return bySession;
  const lower = needle.toLowerCase();
  const byLabel = agents.find(a => (a.name ?? '').toLowerCase().includes(lower) || (a.cwd ?? '').toLowerCase().includes(lower));
  if (!byLabel) { console.error(`No agent matches "${needle}". Live panes:`); for (const a of agents) console.error(`  ${a.name} (${a.agent_session?.value})`); process.exit(1); }
  return byLabel;
};
const target = resolve(flags.to);
const origin = resolve(flags.from);
if (target.agent_session.value === origin.agent_session.value) { console.error('--to and --from resolve to the same session'); process.exit(1); }

const store = new Store();
try {
  const agentId = (sessionId) => createHash('sha256').update(`${store.machineId}\0${sessionId}`).digest('hex');
  const request = store.enqueue({
    originSessionId: origin.agent_session.value,
    originDirectory: origin.cwd,
    recipientId: agentId(target.agent_session.value),
    kind: flags.kind,
    text,
    executionPolicy: flags.policy,
    idempotencyKey: flags.key ?? randomUUID(),
  });
  console.log(`queued ${flags.kind} for "${target.name}"`);
  console.log(`  requestId:     ${request.id}`);
  console.log(`  deliveryId:    ${request.deliveryId}`);
  console.log(`  generation:    ${request.generation}`);
  console.log(`  state:         ${request.state}`);
  console.log(`  from session:  ${origin.agent_session.value}`);
  console.log('Watch it move: node scripts/watch-store.mjs   (or the Coordination panel)');
} finally {
  store.close();
}
