#!/usr/bin/env node
// cancel-request — cancel your outgoing request (the same call the
// cancel_request tool makes). Already-submitted work may keep going.
//
// Usage:
//   node scripts/cancel-request.mjs --id <requestId> --from <pane-label-substring|ses_…>
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Store } from '../dist/store.js';

const run = promisify(execFile);
const shim = process.env.HERDR_SHIM || `${process.env.HOME}/.local/bin/herdr`;

const argv = process.argv.slice(2);
const flags = {};
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--id') flags.id = argv[++i];
  else if (argv[i] === '--from') flags.from = argv[++i];
}
if (!flags.id || !flags.from) {
  console.error('Usage: node scripts/cancel-request.mjs --id <requestId> --from <pane-label-substring|ses_…>');
  process.exit(1);
}

const { stdout } = await run(shim, ['agent', 'list'], { timeout: 15_000, maxBuffer: 8 * 1024 * 1024 });
const agents = JSON.parse(stdout)?.result?.agents ?? [];
const lower = flags.from.toLowerCase();
const origin = agents.find(a => a.agent_session?.value === flags.from)
  ?? agents.find(a => (a.name ?? '').toLowerCase().includes(lower) || (a.cwd ?? '').toLowerCase().includes(lower));
if (!origin) { console.error(`No agent matches "${flags.from}"`); process.exit(1); }

const store = new Store();
try {
  const request = store.cancel(flags.id, origin.agent_session.value);
  console.log(`cancelled ${request.id} → ${request.state}`);
} finally {
  store.close();
}
