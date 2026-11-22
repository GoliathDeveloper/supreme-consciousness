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

// Resolve a short (8-char) request id against the store before cancelling.
let requestId = flags.id;
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId)) {
  const { createRequire } = await import('node:module');
  const require_ = createRequire(import.meta.url);
  const dbModule = typeof globalThis.Bun !== 'undefined' ? require_('bun:sqlite') : require_('node:sqlite');
  const Database = dbModule.Database ?? dbModule.DatabaseSync;
  const db = new Database('/Users/phil/.config/opencode/opencode-herdr/coordination.sqlite', { readOnly: true });
  const rows = db.prepare('SELECT id FROM requests WHERE id LIKE ?').all(`${requestId}%`);
  db.close();
  if (rows.length !== 1) {
    console.error(`Request id "${requestId}" matched ${rows.length} requests — use a longer prefix or the full id`);
    process.exit(1);
  }
  requestId = rows[0].id;
}

const store = new Store();
try {
  const request = store.cancel(requestId, origin.agent_session.value);
  console.log(`cancelled ${request.id} → ${request.state}`);
} finally {
  store.close();
}
