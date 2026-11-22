#!/usr/local/bin/node
// herdr — compatibility shim for the supreme-consciousness plugin.
//
// The plugin targets the Herdr TUI generation (`herdr agent list`, `herdr pane …`).
// This machine runs the newer herdr-app / herdr-core (`hc`) generation, so this
// shim translates the plugin's calls onto the installed stack:
//   - layout and panes:        `herdr-app ls` / `herdr-app do pane.*`
//   - terminals:               `hc get` / `hc send`
//   - OpenCode session identity + running state: the local OpenCode HTTP API
//   - sidebar metadata:        written as JSON for the supreme-consciousness GUI mod
//
// It never changes coordination state; the plugin's Store remains the source of
// truth and the GUI stays a presentation and interaction layer.
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const METADATA_DIR = join(process.env.XDG_STATE_HOME || join(homedir(), '.local/state'), 'supreme-consciousness', 'metadata');
// Resolve against PATH first, then the usual install locations, so the shim
// works from launch daemons and mod exec environments with a minimal PATH.
const candidates = {
  open: [process.env.OPENCODE_BIN, join(homedir(), '.opencode/bin/opencode'), '/usr/local/bin/opencode', '/opt/homebrew/bin/opencode', 'opencode'].filter(Boolean),
  app: [process.env.HERDR_APP_BIN, join(homedir(), '.local/bin/herdr-app'), 'herdr-app'].filter(Boolean),
  hc: [process.env.HERDR_CORE_BIN, join(homedir(), '.local/bin/herdr-core'), 'herdr-core'].filter(Boolean),
};
async function execFirst(list, args, opts) {
  let last;
  for (const file of list) {
    try { return await run(file, args, opts); } catch (error) {
      last = error;
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  throw last;
}

const json = (value) => JSON.stringify(value, null, 2);
const out = (value) => process.stdout.write(json(value) + '\n');
const fail = (message) => { process.stderr.write(json({ error: message }) + '\n'); process.exit(1); };

async function app(...args) {
  const { stdout } = await execFirst(candidates.app, ['do', ...args], { timeout: 15_000, maxBuffer: 8 * 1024 * 1024 });
  return JSON.parse(stdout);
}

async function appRaw(...args) {
  const { stdout } = await execFirst(candidates.app, args, { timeout: 15_000, maxBuffer: 8 * 1024 * 1024 });
  return JSON.parse(stdout);
}

async function hc(...args) {
  const { stdout } = await execFirst(candidates.hc, args, { timeout: 15_000, maxBuffer: 8 * 1024 * 1024 });
  return stdout.trim().startsWith('{') || stdout.trim().startsWith('[') ? JSON.parse(stdout) : stdout;
}

async function api(path) {
  const { stdout } = await execFirst(candidates.open, ['api', 'get', path], { timeout: 15_000, maxBuffer: 32 * 1024 * 1024 });
  return JSON.parse(stdout);
}

// ——— layout ————————————————————————————————————————————————————————————————

async function layout() {
  return appRaw('ls');
}

// terminals keyed by address, enriched with their current pane and space
async function terminals() {
  const tree = await layout();
  const found = [];
  for (const space of tree.spaces ?? []) {
    for (const tab of space.tabs ?? []) {
      for (const entry of tab.terminals ?? []) {
        let detail = null;
        try { detail = await hc('get', entry.terminal); } catch {}
        found.push({
          space, tab, entry, detail,
          paneId: entry.pane ?? null,
          terminalId: entry.terminal,
          workspaceId: space.id,
          directory: detail?.foreground?.cwd ?? detail?.cwd ?? detail?.last_cwd ?? space.folder ?? null,
          program: detail?.foreground?.name ?? null,
          state: detail?.state ?? null,
        });
      }
    }
  }
  return found;
}

// ——— OpenCode sessions ————————————————————————————————————————————————

async function opencodeSessions() {
  let sessions = [];
  let active = {};
  try {
    const listed = await api('/api/session');
    sessions = (listed?.data ?? listed ?? []).map(s => ({
      id: s.id,
      directory: s.location?.directory ?? s.directory ?? null,
      updatedAt: s.time?.updated ?? s.updatedAt ?? 0,
      // The TUI touches `viewed` for the session it is displaying — and worker
      // submissions never do, so this is the display signal that survives
      // delivery poisoning (updatedAt cannot be trusted for binding).
      viewed: s.time?.viewed ?? 0,
      title: s.title ?? null,
    }));
  } catch { /* OpenCode API unavailable: inventory reports terminals only */ }
  try {
    const running = await api('/api/session/active');
    active = running?.data ?? running ?? {};
  } catch { /* running map unavailable: sessions report idle */ }
  return { sessions, active };
}

// ——— herdr agent list —————————————————————————————————————————————————————
// Shape the plugin expects: {"result":{"agents":[{pane_id, terminal_id,
// workspace_id, cwd, agent, agent_status, name, agent_session:{...}}]}}

// Sticky pane→session bindings: the last *authoritative* pairing observed per
// pane. The server cannot see which session an idle TUI displays, so without
// this memory every agent-list call re-guesses — and after /new the guess
// self-sustains (deliveries bump the orphaned session's recency). Bindings are
// written only on authoritative signals (the TUI's 7501 title, the pane's own
// running turn, an unambiguous directory); a recency guess is flagged in the
// inventory and never memorised.
const BINDINGS_FILE = () => join(homedir(), '.local/state/supreme-consciousness/shim-bindings.json');

function loadBindings() {
  try { return JSON.parse(readFileSync(BINDINGS_FILE(), 'utf8')); } catch { return {}; }
}

function saveBindings(bindings) {
  try {
    mkdirSync(join(BINDINGS_FILE(), '..'), { recursive: true, mode: 0o700 });
    writeFileSync(BINDINGS_FILE(), JSON.stringify(bindings));
  } catch {}
}

const isAgentPane = (term) =>
  term.detail?.foreground?.name === 'opencode' || term.detail?.status?.app === 'opencode';

// Resolve which session a pane's TUI is displaying. Precedence: the TUI's
// transient 7501 title (authoritative while a turn runs) > the pane's own
// running turn (binds even untitled sessions) > the sticky binding >
// an unambiguous single candidate > a flagged recency guess.
function resolvePaneSession(term, candidates, active, bindings) {
  const title = term.detail?.status?.title;
  const working = term.detail?.status?.state === 'working';
  const running = candidates.filter(s => active[s.id]?.type === 'running');
  const sticky = candidates.find(s => s.id === bindings[term.paneId]);
  let picked, ambiguous;
  const titleMatch = title ? candidates.find(s => (s.title ?? '') === title) : undefined;
  if (titleMatch) {
    picked = titleMatch;
  } else if (working && running.length === 1) {
    picked = running[0];
  } else {
    // The TUI touches `viewed` for the session it displays, and nothing else
    // does — so the most-recently-viewed candidate IS what the pane shows,
    // even when sticky bindings and updatedAt point somewhere else (a /new
    // orphans the old session; worker submissions never touch viewed).
    const viewed = [...candidates].sort((a, b) => (b.viewed ?? 0) - (a.viewed ?? 0));
    if (viewed.length && (viewed[0].viewed ?? 0) > 0) {
      picked = viewed[0];
    } else if (sticky) {
      picked = sticky;
    } else if (candidates.length === 1) {
      picked = candidates[0];
    } else {
      picked = running[0] ?? [...candidates].sort((a, b) => b.updatedAt - a.updatedAt)[0];
      const horizon = Date.now() - 6 * 3600_000;
      ambiguous = candidates.filter(s => (s.updatedAt ?? 0) > horizon).length;
    }
  }
  return { picked, ambiguous };
}

async function agentList() {
  const [terms, { sessions, active }] = await Promise.all([terminals(), opencodeSessions()]);
  const byDirectory = new Map();
  for (const session of sessions) {
    if (!session.directory) continue;
    const list = byDirectory.get(session.directory) ?? [];
    list.push(session);
    byDirectory.set(session.directory, list);
  }
  // Only terminals actually running OpenCode are agents. A plain shell in the
  // same directory (e.g. where the test scripts run) must never be attributed
  // a session: the TUI reports itself via foreground process + OSC 7501 status.
  const agents_ = terms.filter(isAgentPane);
  const bindings = loadBindings();
  let dirty = false;
  const resolve = (term) => {
    const candidates = term.directory ? (byDirectory.get(term.directory) ?? []) : [];
    if (!candidates.length) return {};
    const { picked, ambiguous } = resolvePaneSession(term, candidates, active, bindings);
    if (picked && !(ambiguous > 1) && bindings[term.paneId] !== picked.id) {
      bindings[term.paneId] = picked.id;
      dirty = true;
    }
    return { picked, ambiguous };
  };
  // Same conversation attached in more than one pane: the store refuses to
  // serve a session from two panes, so surface the conflict to the human.
  const sessionPanes = new Map();
  for (const term of agents_) {
    const { picked } = resolve(term);
    if (picked) sessionPanes.set(picked.id, (sessionPanes.get(picked.id) ?? 0) + 1);
  }
  // Human-chosen nicknames live in the coordination store, keyed by session;
  // a missing or locked DB is an empty map, not an error.
  const nicknames = new Map();
  try { for (const row of await sqliteJson('SELECT sessionId, nickname FROM agents')) if (row.nickname) nicknames.set(row.sessionId, row.nickname); } catch {}
  const agents = [];
  for (const term of agents_) {
    const { picked, ambiguous } = resolve(term);
    if (!picked) continue;
    const panes = sessionPanes.get(picked.id) ?? 1;
    // Prefer the TUI's own OSC 7501 state; the server-side execution map
    // catches turns the TUI has not rendered yet (delivery-worker prompts).
    const tuiState = term.detail?.status?.state;
    const agent_status = tuiState === 'working' || active[picked.id]?.type === 'running'
      ? 'working'
      : (tuiState ?? (active[picked.id]?.type === 'running' ? 'working' : 'idle'));
    agents.push({
      pane_id: term.paneId,
      terminal_id: term.terminalId,
      workspace_id: term.workspaceId,
      cwd: term.directory,
      agent: 'opencode',
      agent_status,
      // The TUI's own OSC 7501 signal, reported separately so the mod can show
      // both truths: server-initiated turns (deliveries, nudges) run without
      // the TUI's status ever painting "working" — Herdr's native list reads
      // only this signal and goes blind exactly when coordination is active.
      tui_status: tuiState ?? null,
      name: term.tab.name ?? term.entry.name ?? picked.title ?? picked.id,
      ...(nicknames.get(picked.id) ? { nickname: nicknames.get(picked.id) } : {}),
      ...(panes > 1 ? { conflict: panes } : {}),
      ...(ambiguous > 1 ? { ambiguous } : {}),
      agent_session: { agent: 'opencode', kind: 'id', value: picked.id },
    });
  }
  // Prune bindings for panes that no longer exist, persist only on change.
  for (const paneId of Object.keys(bindings)) {
    if (!agents_.some(term => term.paneId === paneId)) { delete bindings[paneId]; dirty = true; }
  }
  if (dirty) saveBindings(bindings);
  return { result: { agents } };
}

function findPane(terms, paneId) {
  return terms.find(t => t.paneId === paneId) ?? null;
}

// ——— herdr pane get ————————————————————————————————————————————————————————

async function paneGet(paneId) {
  const terms = await terminals();
  const term = findPane(terms, paneId);
  if (!term) fail(`Unknown pane ${paneId}`);
  const { sessions, active } = await opencodeSessions();
  const session = sessions.filter(s => s.directory === term.directory)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  return { result: { pane: {
    pane_id: term.paneId,
    terminal_id: term.terminalId,
    workspace_id: term.workspaceId,
    cwd: term.directory,
    agent: 'opencode',
    agent_status: session && active[session.id]?.type === 'running' ? 'working' : session ? 'idle' : null,
    ...(session ? { agent_session: { agent: 'opencode', kind: 'id', value: session.id } } : {}),
  } } };
}

// ——— herdr pane list --workspace <id> ———————————————————————————————————————

async function paneList(workspaceId) {
  const terms = await terminals();
  return { result: { panes: terms.filter(t => t.workspaceId === workspaceId).map(term => ({
    pane_id: term.paneId,
    terminal_id: term.terminalId,
    workspace_id: term.workspaceId,
    cwd: term.directory,
  })) } };
}

// ——— herdr pane split ———————————————————————————————————————————————————————
// provision: herdr pane split <callerPane> --direction right --cwd <dest> --no-focus
// The GUI places relative to the focused pane, so the caller's pane is focused
// briefly; the new terminal keeps the requested folder.

async function paneSplit(paneId, direction, cwd) {
  const before = new Set((await terminals()).map(t => t.paneId).filter(Boolean));
  await app('pane.focus', JSON.stringify({ pane: paneId }));
  const reply = await app('terminal.open', JSON.stringify({ folder: cwd, place: direction, argv: ['/bin/zsh', '-l'] }));
  if (reply?.error) fail(reply.error);
  const terms = await terminals();
  const fresh = terms.find(t => t.paneId && !before.has(t.paneId) && t.directory === cwd);
  if (!fresh?.paneId) fail('Split did not produce a new pane');
  return { result: { pane: {
    pane_id: fresh.paneId,
    terminal_id: fresh.terminalId,
    workspace_id: fresh.workspaceId,
    cwd: fresh.directory,
  } } };
}

// ——— herdr pane close ———————————————————————————————————————————————————————

async function paneClose(paneId) {
  await app('pane.close', JSON.stringify({ pane: paneId }));
  return { result: {} };
}

// ——— herdr pane run —————————————————————————————————————————————————————————
// provision: herdr pane run <paneId> "<env … opencode --session …>"
// Typed into the pane's shell exactly as the TUI generation did.

async function paneRun(paneId, command) {
  const terms = await terminals();
  const term = findPane(terms, paneId);
  if (!term) fail(`Unknown pane ${paneId}`);
  await hc('send', term.terminalId, command);
  return { result: {} };
}

// ——— herdr pane report-metadata —————————————————————————————————————————————
// Sidebar tokens are display-only. The TUI generation consumed them natively;
// here they are written for the supreme-consciousness GUI mod to render.

async function reportMetadata(paneId, tokens, pluginRoot) {
  mkdirSync(METADATA_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(join(METADATA_DIR, `${paneId}.json`), json({
    paneId, source: 'supreme-consciousness', agent: 'opencode', tokens, updatedAt: Date.now(),
    ...(pluginRoot ? { pluginRoot } : {}),
  }), { mode: 0o600 });
  return { result: {} };
}

// ——— herdr pane-of-terminal <t> ——————————————————————————————————————————————
// Shell-profile helper: resolves a terminal address to its current pane id so
// HERDR_PANE_ID can be computed at shell start.

async function paneOfTerminal(terminalId) {
  const terms = await terminals();
  const term = terms.find(t => t.terminalId === terminalId);
  if (!term?.paneId) fail(`No pane for terminal ${terminalId}`);
  return { result: { pane: term.paneId } };
}

// Session hygiene: server-side sessions that no pane is bound to. A /new
// orphans the previous session; the server keeps it forever, and before
// sticky bindings deliveries could drift into it. Read-only listing —
// deletion stays the human's call via DELETE /api/session/{id}.
async function sessionOrphans() {
  const [terms, { sessions, active }] = await Promise.all([terminals(), opencodeSessions()]);
  const bindings = loadBindings();
  const bound = new Set(Object.values(bindings));
  const unverifiedDirectories = new Set();
  for (const term of terms.filter(isAgentPane)) {
    const candidates = term.directory ? sessions.filter(s => s.directory === term.directory) : [];
    if (!candidates.length) continue;
    const { picked, ambiguous } = resolvePaneSession(term, candidates, active, bindings);
    // Deletion safety: a pane whose binding is a recency guess makes every
    // session in its directory unverified — a wrong guess here once listed a
    // live pane session as an orphan. Only authoritative bindings (sticky,
    // title, running) may classify sessions as deletable.
    if (picked && ambiguous > 1) { unverifiedDirectories.add(term.directory); continue; }
    if (picked) bound.add(picked.id);
    else unverifiedDirectories.add(term.directory);
  }
  const orphans = sessions
    .filter(s => !bound.has(s.id) && !(s.directory && unverifiedDirectories.has(s.directory)))
    .map(s => ({
      id: s.id,
      title: s.title ?? null,
      directory: s.directory ?? null,
      updatedAt: s.updatedAt ?? null,
      running: active[s.id]?.type === 'running' ?? false,
    }))
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  const unverified = sessions
    .filter(s => s.directory && unverifiedDirectories.has(s.directory) && !bound.has(s.id))
    .map(s => ({ id: s.id, title: s.title ?? null, directory: s.directory ?? null, updatedAt: s.updatedAt ?? null }))
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  return { result: { orphans, count: orphans.length, unverified, unverifiedCount: unverified.length } };
}

// ——— herdr review ———————————————————————————————————————————————————————————
// Human-review view over the coordination store (read-only): what each agent
// asked the other to do, the outcome, and the lifecycle transitions. The store
// remains the source of truth; this only projects it for people.

const reviewDb = () => join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'opencode', 'supreme-consciousness', 'coordination.sqlite');

async function sqliteJson(sql) {
  const { stdout } = await execFirst(['sqlite3', '/usr/bin/sqlite3', '/opt/homebrew/bin/sqlite3'], ['-readonly', '-json', reviewDb(), sql], { timeout: 10_000, maxBuffer: 8 * 1024 * 1024 });
  const trimmed = stdout.trim();
  return trimmed ? JSON.parse(trimmed) : [];
}

async function review(limit = 20) {
  const projection = `SELECT r.id, r.kind, r.originSessionId AS origin, r.recipientId AS recipient,
      r.generation, r.createdAt, r.updatedAt, g.text AS brief, r.executionPolicy, r.idempotencyKey AS key,
      t.outcome, t.summary, t.validation, t.checks, t.risks,
      CASE WHEN r.cancelledAt IS NOT NULL THEN 'cancelled'
           WHEN t.outcome IS NOT NULL THEN t.outcome ELSE d.state END AS state
    FROM requests r
    JOIN generations g ON g.requestId = r.id AND g.generation = r.generation
    JOIN deliveries d ON d.requestId = r.id AND d.generation = r.generation
    LEFT JOIN results t ON t.requestId = r.id AND t.generation = r.generation
    ORDER BY r.updatedAt DESC LIMIT ${Number(limit) || 20}`;
  let requests = [];
  try { requests = await sqliteJson(projection); } catch (error) {
    return { result: { requests: [], processed: 0, counts: {}, error: `Coordination store unavailable: ${String(error?.message ?? error).slice(0, 120)}` } };
  }
  const ids = requests.map(r => `'${String(r.id).replace(/'/g, '')}'`).join(',');
  let agents = [];
  const transitions = {};
  if (ids) {
    try { agents = await sqliteJson('SELECT id, label, nickname, sessionId FROM agents'); } catch {}
    try {
      for (const row of await sqliteJson(`SELECT entityId, transition, sessionId, createdAt FROM audit_events WHERE entityId IN (${ids}) ORDER BY id`)) {
        (transitions[row.entityId] ??= []).push({ at: row.createdAt, transition: row.transition, session: row.sessionId, actor: null });
      }
    } catch {}
  }
  const labelOf = (agentId) => {
    if (String(agentId).startsWith('remote:')) return 'remote peer';
    const agent = agents.find(a => a.id === agentId || a.sessionId === agentId);
    return agent?.nickname || agent?.label || String(agentId).slice(0, 12);
  };
  const feed = [];
  for (const entry of requests) {
    for (const step of transitions[entry.id] ?? []) {
      step.actor = labelOf(step.session);
      feed.push({ at: step.at, request: entry.id, state: entry.state, transition: step.transition, actor: step.actor });
    }
    entry.originSession = entry.origin;
    entry.recipientSession = entry.recipient;
    entry.origin = labelOf(entry.origin);
    entry.recipient = labelOf(entry.recipient);
  }
  feed.sort((a, b) => b.at - a.at);
  const counts = {};
  for (const r of requests) if (r.outcome) counts[r.outcome] = (counts[r.outcome] ?? 0) + 1;
  const processed = Object.values(counts).reduce((sum, n) => sum + n, 0);
  return { result: {
    requests: requests.map(r => ({
      id: r.id, kind: r.kind, state: r.state, generation: r.generation, key: r.key ?? null,
      origin: r.origin, recipient: r.recipient, originSession: r.originSession, recipientSession: r.recipientSession,
      brief: r.brief, outcome: r.outcome ?? null, summary: r.summary ?? null,
      validation: r.validation ?? null, createdAt: r.createdAt, updatedAt: r.updatedAt,
      transitions: (transitions[r.id] ?? []).map(step => step.transition),
    })),
    feed: feed.slice(0, 12),
    processed,
    counts,
  } };
}

// ——— herdr mailbox <sessionId> ——————————————————————————————————————————————
// The per-agent mailbox the sidebar chips summarize: formal work orders both
// ways, plus the correspondence — delivered notices (receipts, results) as the
// origin session's inbound mail, handbacks (results written by the session) as
// its outbound mail — and remote operations as outbound placeholders. Read-only,
// same authority as `review`: the human inspecting their own store.

const mailboxProjection = `SELECT r.id, r.kind, r.originSessionId AS origin, r.recipientId AS recipient,
    r.generation, r.createdAt, r.updatedAt, g.text AS brief,
    CASE WHEN r.cancelledAt IS NOT NULL THEN 'cancelled'
         WHEN t.outcome IS NOT NULL THEN t.outcome ELSE d.state END AS state,
    t.summary, t.validation
  FROM requests r
  JOIN generations g ON g.requestId = r.id AND g.generation = r.generation
  JOIN deliveries d ON d.requestId = r.id AND d.generation = r.generation
  LEFT JOIN results t ON t.requestId = r.id AND t.generation = r.generation`;

async function mailboxLabels() {
  try { return await sqliteJson('SELECT id, label, nickname, sessionId FROM agents'); } catch { return []; }
}

// Same convention as review(): origin/recipient are display labels (nickname
// or label, falling back to an id prefix), originSession/recipientSession keep
// the raw store identities so callers can still join on them.
function mailboxLabelOf(agents, agentId) {
  if (String(agentId).startsWith('remote:')) return 'remote peer';
  const agent = agents.find(a => a.id === agentId || a.sessionId === agentId);
  return agent?.nickname || agent?.label || String(agentId).slice(0, 12);
}

function mailboxEntry(agents, row) {
  return { ...row, originSession: row.origin, recipientSession: row.recipient,
    origin: mailboxLabelOf(agents, row.origin), recipient: mailboxLabelOf(agents, row.recipient) };
}

async function mailboxListing(sessionId) {
  if (!/^[A-Za-z0-9_-]{6,80}$/.test(sessionId ?? '')) fail('herdr shim: mailbox <sessionId>');
  try {
    // Same composition as the store's mailbox(): the groups concatenate rather
    // than merge — a request delivered to the session AND announced back to it
    // is two pieces of mail, exactly what the chips count.
    const [inboxOrders, receipts] = await Promise.all([
      sqliteJson(`${mailboxProjection} WHERE r.recipientId IN (SELECT id FROM agents WHERE sessionId='${sessionId}') ORDER BY d.sequence`),
      sqliteJson(`${mailboxProjection} WHERE r.id IN (SELECT entityId FROM notifications WHERE sessionId='${sessionId}' AND state='delivered') ORDER BY d.sequence`),
    ]);
    const [outboxOrders, handbacks] = await Promise.all([
      sqliteJson(`${mailboxProjection} WHERE r.originSessionId='${sessionId}' ORDER BY d.sequence`),
      sqliteJson(`${mailboxProjection} WHERE EXISTS (SELECT 1 FROM results t2 WHERE t2.requestId=r.id AND t2.generation=r.generation AND t2.sessionId='${sessionId}') ORDER BY d.sequence`),
    ]);
    const remote = await sqliteJson(`SELECT id, state, createdAt, updatedAt,
        json_extract(payload,'$.peerId') AS peerId,
        json_extract(result,'$.history.request.id') AS remoteId,
        json_extract(payload,'$.args.text') AS brief,
        json_extract(result,'$.history.request.state') AS remoteState,
        json_extract(result,'$.history.results[0].summary') AS summary
      FROM operations WHERE kind='remote.request' AND originSessionId='${sessionId}' ORDER BY updatedAt DESC`);
    const agents = await mailboxLabels();
    const byNewest = (a, b) => b.updatedAt - a.updatedAt;
    return { result: {
      inbox: [...inboxOrders, ...receipts].sort(byNewest).map(row => mailboxEntry(agents, row)),
      outbox: [...outboxOrders, ...handbacks].sort(byNewest).map(row => mailboxEntry(agents, row)),
      remote: remote.map(op => ({ id: op.id, kind: 'remote', origin: sessionId, recipient: op.peerId ?? '',
        originSession: sessionId, recipientSession: '',
        generation: 0, createdAt: op.createdAt, updatedAt: op.updatedAt, brief: op.brief,
        state: op.remoteState ?? op.state, summary: op.summary, remoteRequest: op.remoteId ?? null })),
    } };
  } catch (error) {
    return { result: { inbox: [], outbox: [], remote: [], error: `Coordination store unavailable: ${String(error?.message ?? error).slice(0, 120)}` } };
  }
}

// ——— herdr request <id> ——————————————————————————————————————————————————————
// One mailbox item in full. Local requests read their store history; remote
// requests have no local row, so their latest cached SSH receipt is read from
// the origin operation instead of failing.

async function requestDetail(id) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id ?? '')) fail('herdr shim: request <uuid>');
  let request;
  try { request = (await sqliteJson(`${mailboxProjection} WHERE r.id='${id}'`))[0]; }
  catch (error) {
    return { result: { error: `Coordination store unavailable: ${String(error?.message ?? error).slice(0, 120)}` } };
  }
  if (request) {
    const [generations, deliveries, results, questions, audit, agents] = await Promise.all([
      sqliteJson(`SELECT generation, text, createdAt FROM generations WHERE requestId='${id}' ORDER BY generation`),
      sqliteJson(`SELECT id, generation, state, sessionId, attemptedAt, submittedAt, acceptedAt FROM deliveries WHERE requestId='${id}' ORDER BY generation`),
      sqliteJson(`SELECT generation, outcome, summary, validation, checks, risks, evidence, sessionId, createdAt FROM results WHERE requestId='${id}' ORDER BY generation`),
      sqliteJson(`SELECT id, generation, text, state, replyText, repliedAt FROM questions WHERE requestId='${id}' ORDER BY generation, createdAt`),
      sqliteJson(`SELECT transition, sessionId, createdAt FROM audit_events WHERE entityId='${id}' ORDER BY id`),
      mailboxLabels(),
    ]);
    for (const step of audit) step.actor = mailboxLabelOf(agents, step.sessionId);
    return { result: { request: mailboxEntry(agents, request), generations, deliveries, results, questions, audit } };
  }
  const ops = await sqliteJson(`SELECT id, state, payload, result FROM operations WHERE kind='remote.request'
    AND (json_extract(result,'$.history.request.id')='${id}' OR id='${id}')`);
  const op = ops[0];
  if (!op) return { result: { error: `Unknown request ${id}` } };
  const payload = JSON.parse(op.payload);
  const history = op.result ? (JSON.parse(op.result).history ?? null) : null;
  return { result: { remote: { peerId: payload.peerId, operationState: op.state, operationId: op.id }, history } };
}

// ——— herdr peers ————————————————————————————————————————————————————————————
// The plugin's refresh loop writes a name + counts snapshot of its configured
// SSH peers next to the pane metadata files (never tokens). The GUI mod reads
// it back here to render the Remote peers section; a missing file means "no
// peers configured" — the mod shows an empty section rather than an error.

const peersFile = () => join(METADATA_DIR, 'peers.json');

async function peers() {
  try {
    return { result: { peers: JSON.parse(readFileSync(peersFile(), 'utf8')) } };
  } catch {
    return { result: { peers: [] } };
  }
}

// ——— argv —————————————————————————————————————————————————————————————————————

const argv = process.argv.slice(2);
const [command, ...rest] = argv;
const flags = {};
const positional = [];
for (let i = 0; i < rest.length; i++) {
  const arg = rest[i];
  if (arg === '--token') { const [k, v] = (rest[++i] ?? '').split('='); flags.tokens = { ...(flags.tokens ?? {}), [k]: v }; continue; }
  if (arg.startsWith('--')) { flags[arg.slice(2)] = rest[++i]; continue; }
  positional.push(arg);
}

try {
  await (async () => {
    switch (command) {
      case 'agent':
        if (positional[0] === 'list') return out(await agentList());
        fail(`Unknown agent command: ${positional[0] ?? '(missing)'}`);
        break;
      case 'review':
        return out(await review(Number(positional[0]) || Number(flags.limit) || 20));
      case 'mailbox':
        return out(await mailboxListing(positional[0]));
      case 'request':
        return out(await requestDetail(positional[0]));
      case 'peers':
        return out(await peers());
      case 'session':
        if (positional[0] === 'orphans') return out(await sessionOrphans());
        fail('usage: herdr session orphans');
        return;
      case 'pane': {
        const target = positional[0];
        if (target === 'split') return out(await paneSplit(positional[1], flags.direction ?? 'right', flags.cwd));
        if (target === 'get') return out(await paneGet(positional[1]));
        if (target === 'list') return out(await paneList(flags.workspace));
        if (target === 'close') return out(await paneClose(positional[1]));
        if (target === 'run') return out(await paneRun(positional[1], positional[2]));
        if (target === 'report-metadata') return out(await reportMetadata(positional[1], flags.tokens ?? {}, flags['plugin-root']));
        if (target === 'of-terminal') return out(await paneOfTerminal(positional[1]));
        fail(`Unknown pane command: ${target ?? '(missing)'}`);
        break;
      }
      default:
        fail(`herdr shim: unsupported command "${command ?? '(missing)'}". Supported: agent list, peers, review, mailbox, request, session orphans, pane split|get|list|close|run|report-metadata|of-terminal`);
    }
  })();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
