#!/usr/bin/env node
// set-nickname — the herdr panel's ✎ rename button shells out here. The mod
// itself never mutates the store (see the panel's RECIPE); this script is the
// plugin-sanctioned mutation path, exactly like hello-test/hello-cancel.
//
// Usage:
//   node scripts/set-nickname.mjs <sessionId|agentId> <nickname...>
//
// Prints one JSON line: { ok, agent, nickname, label } — or refuses with a
// "Refusing:" line on stderr and a non-zero exit, mirroring hello-test.
import { Store } from '../dist/store.js';

const DB = `${process.env.HOME}/.config/opencode/supreme-consciousness/coordination.sqlite`;

const [idOrSession, ...rest] = process.argv.slice(2);
const nickname = rest.join(' ').trim();
if (!idOrSession) {
  console.error('Refusing: usage: set-nickname.mjs <sessionId|agentId> <nickname>');
  process.exit(1);
}
if (!nickname) {
  console.error('Refusing: nickname must not be empty (use a real name)');
  process.exit(1);
}
if (nickname.length > 80) {
  console.error('Refusing: nickname too long (max 80 characters)');
  process.exit(1);
}

const store = new Store(DB);
try {
  store.updateAgentNickname(idOrSession, nickname);
  const agent = store.agents().find(a => a.id === idOrSession || a.sessionId === idOrSession);
  console.log(JSON.stringify({ ok: true, agent: idOrSession, nickname, label: agent?.label ?? nickname }));
} finally {
  store.close();
}
