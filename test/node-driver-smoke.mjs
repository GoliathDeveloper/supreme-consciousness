// Node-runtime smoke test for the node:sqlite adapter branch of the Store.
// The bun test suites exercise bun:sqlite; this proves the same Store code
// runs under plain Node (schema, agents, enqueue, atomic CAS claims).
import { Store } from '../dist/store.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'herdr-node-smoke-'));
const store = new Store(join(dir, 'coordination.sqlite'));
try {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(store.machineId)) {
    throw new Error('machine ID missing');
  }
  const agent = store.observeAgent({
    sessionId: 'smoke-session', socket: '/tmp/opencode.sock', paneId: 'pane', terminalId: 'terminal',
    workspaceId: 'workspace', directory: '/project', label: 'Worker', state: 'idle', lastSeen: Date.now(),
  });
  const request = store.enqueue({
    originSessionId: 'origin', originDirectory: '/origin', recipientId: agent.id,
    kind: 'task', text: 'Smoke brief', idempotencyKey: 'smoke-1',
  });
  if (request.state !== 'queued' || request.generation !== 1) throw new Error('enqueue produced an unexpected request');
  const operation = store.beginOperation('open_agent', 'origin', 'smoke-op', { management: 'independent' });
  if (store.claimOperation(operation.id, 'requested', 'preparing') !== true) throw new Error('first claim failed');
  if (store.claimOperation(operation.id, 'requested', 'preparing') !== false) throw new Error('second claim should lose the CAS');
  if (store.closingAgent(agent.id) !== false) throw new Error('no close reservation expected');
  if (store.list('origin').outbox.length !== 1) throw new Error('outbox should hold the queued request');
  console.log('node-driver smoke: PASS');
} finally {
  store.close();
  rmSync(dir, { recursive: true, force: true });
}
