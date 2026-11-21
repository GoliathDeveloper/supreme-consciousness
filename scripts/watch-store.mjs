#!/usr/bin/env node
// watch-store — read-only view of the coordination store: requests, delivery
// states, and the latest audit trail. The same data the GUI mod renders.
import { createHash } from 'node:crypto';
import { Store } from '../dist/store.js';

const store = new Store();
try {
  const { createRequire } = await import('node:module');
  const require_ = createRequire(import.meta.url);
  const dbModule = typeof globalThis.Bun !== 'undefined'
    ? require_('bun:sqlite')
    : require_('node:sqlite');
  const Database = dbModule.Database ?? dbModule.DatabaseSync;
  const db = new Database('/Users/phil/.config/opencode/opencode-herdr/coordination.sqlite', { readOnly: true });
  const all = (sql) => db.prepare(sql).all();
  const labels = Object.fromEntries(all('SELECT id, label, sessionId FROM agents')
    .flatMap(a => [[a.id, a.label], [a.sessionId, a.label]]));
  const label = (key) => labels[key] ?? String(key ?? '').slice(0, 12);
  const short = (s) => String(s ?? '').slice(0, 8);

  console.log('— requests (newest first) —');
  for (const r of all(`SELECT r.id, r.kind, r.originSessionId AS origin, r.recipientId AS recipient,
      r.generation, r.revision,
      CASE WHEN r.cancelledAt IS NOT NULL THEN 'cancelled'
           WHEN t.outcome IS NOT NULL THEN t.outcome ELSE d.state END AS state,
      substr(g.text, 1, 70) AS brief, substr(t.summary, 1, 70) AS summary
    FROM requests r
    JOIN generations g ON g.requestId = r.id AND g.generation = r.generation
    JOIN deliveries d ON d.requestId = r.id AND d.generation = r.generation
    LEFT JOIN results t ON t.requestId = r.id AND t.generation = r.generation
    ORDER BY r.updatedAt DESC`)) {
    console.log(`${short(r.id)} [${r.state}] ${r.kind}  ${label(r.origin)} → ${label(r.recipient)}  (gen${r.generation} rev${r.revision})`);
    console.log(`    asked: ${r.brief}`);
    if (r.summary) console.log(`    result: ${r.summary}`);
  }
  console.log('— recent audit —');
  for (const e of all('SELECT entityId, transition, sessionId, createdAt FROM audit_events ORDER BY id DESC LIMIT 15').reverse()) {
    const time = new Date(e.createdAt).toLocaleTimeString();
    console.log(`${time}  ${short(e.entityId)}  ${e.transition}  by ${label(e.sessionId)}`);
  }
  db.close();
} finally {
  store.close();
}
