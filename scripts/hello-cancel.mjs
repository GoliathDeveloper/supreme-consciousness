#!/usr/bin/env node
// hello-cancel — the human's cleanup for a hello test: cancels every in-flight
// hello leg so the next ▶ press isn't refused by the guard. Completed history
// is untouched; only requests whose idempotencyKey starts with "hello-" are
// considered, and each is cancelled with its own origin session's authority.
//
// Usage: node scripts/hello-cancel.mjs [--dry]
//
// Scope note: this intentionally only touches hello-test artifacts — never
// arbitrary coordination requests between agents.
import { Store } from '../dist/store.js';
import { createRequire } from 'node:module';

const flags = { dry: process.argv.slice(2).includes('--dry') };
const DB = `${process.env.HOME}/.config/opencode/opencode-herdr/coordination.sqlite`;
const PENDING = new Set(['queued', 'unknown', 'submitted', 'accepted']);

const require_ = createRequire(import.meta.url);
const dbModule = typeof globalThis.Bun !== 'undefined' ? require_('bun:sqlite') : require_('node:sqlite');
const Database = dbModule.Database ?? dbModule.DatabaseSync;

// Effective state mirrors the review projection: delivery rows freeze at
// 'accepted' after handback — completion lives in the results table.
const db = new Database(DB, { readOnly: true });
const rows = db.prepare(`SELECT r.id, r.idempotencyKey, r.originSessionId,
    CASE WHEN r.cancelledAt IS NOT NULL THEN 'cancelled'
         WHEN t.outcome IS NOT NULL THEN t.outcome
         ELSE d.state END AS state
  FROM requests r
  JOIN deliveries d ON d.requestId = r.id AND d.generation = r.generation
  LEFT JOIN results t ON t.requestId = r.id AND t.generation = r.generation
  WHERE r.idempotencyKey LIKE 'hello-%'`).all();
db.close();
const inFlight = rows.filter((row) => PENDING.has(row.state));

if (!inFlight.length) {
  console.log('nothing in flight — every hello leg is completed or cancelled');
  process.exit(0);
}

if (flags.dry) {
  for (const leg of inFlight) console.log(`would cancel  ${leg.id.slice(0, 8)}  ${leg.idempotencyKey}  [${leg.state}]`);
  process.exit(0);
}

const store = new Store();
try {
  for (const leg of inFlight) {
    try {
      const cancelled = store.cancel(leg.id, leg.originSessionId);
      console.log(`cancelled  ${cancelled.id.slice(0, 8)}  ${leg.idempotencyKey}  [${cancelled.state}]`);
    } catch (error) {
      console.error(`failed     ${leg.id.slice(0, 8)}  ${leg.idempotencyKey}: ${String(error?.message ?? error).slice(0, 120)}`);
    }
  }
  console.log(`${inFlight.length} leg(s) cleared — the ▶ button can start a fresh round`);
} finally {
  store.close();
}
