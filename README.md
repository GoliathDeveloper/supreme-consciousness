# opencode-herdr

An OpenCode **V2** plugin for agent-to-agent coordination, built to run inside the
[Herdr](https://herdr.dev) desktop app. Agents discover each other, queue tasks and
instructions, hand work back with immutable receipts, and publish live queue state
to Herdr's sidebar — with a persistent SQLite store as the single source of truth.

> **Runtime note.** The original design targeted the Herdr TUI generation
> (`herdr` CLI, `bun:sqlite`, V1 plugin API). This build runs on today's stack:
> OpenCode 2.3.2 (V2 plugin API), the Herdr desktop generation
> (`herdr-app` / `herdr-core`), and Node or Bun interchangeably.
> The previous design is preserved in [README-old.md](README-old.md).

## Architecture — three separate responsibilities

| Layer | Responsibility | Rule |
| --- | --- | --- |
| **Plugin** (`src/`, loaded by OpenCode) | Agent communication: messages, questions, replies, results, decisions, delivery | The only authority. Owns the SQLite coordination store. |
| **`herdr` shim** (`~/.local/bin/herdr`) | Compatibility bridge: translates the plugin's Herdr calls onto `herdr-app` / `herdr-core` and OpenCode's HTTP API | Stateless translator. Writes sidebar tokens for the mod. |
| **Herdr mod** (`~/.config/herdr-app/mods/opencode-herdr/`) | Visibility: agent list, status dots, inbox/outbox/wait tokens; click-to-focus | Presentation and interaction only. Never changes coordination state. |

The GUI is a presentation layer, **not** the source of truth for collaboration.

## Components

### 1. The plugin (this repository)

Registered in `opencode.jsonc` as a package directory:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    { "package": "/Users/phil/Projects/Herdr-A2A" }
  ]
}
```

The V2 server part (`Plugin.define`) registers 13 tools and a `/herdr` command:

| Tool | Purpose |
| --- | --- |
| `list_agents` | Exact local agent identities, or a remote peer's. Discovery grants no authority. |
| `list_machines` | This machine's coordination identity + configured SSH peers. |
| `request_agent` | Queue a task or instruction for an exact agent. Idempotent by key. |
| `read_task` | Accept and read an exact delivery (requestId + generation + deliveryId). |
| `hand_back` | Publish an immutable result for an accepted task generation. |
| `inspect_request` | Authorised history: generations, deliveries, results, questions, audit. |
| `list_requests` | This conversation's inbox and outbox. |
| `cancel_request` | Cancel your outgoing request. Already-submitted work may continue. |
| `resume_request` | Resume a paused task with an immutable continuation brief. |
| `ask_coordinator` / `reply_question` | Correlated questions on an accepted task, answered by its owner. |
| `open_agent` / `close_agent` | Provisioning (pane/worktree/workspace, managed or independent). Closure requires a trusted owner grant. |
| `list_operations` | Inspect persisted provisioning/closing/remote operations; reconciles uncertainty. |

### 2. The SQLite store (`src/store.ts`)

Every request, generation, delivery, result, question, notice and operation lives in
`~/.config/opencode/opencode-herdr/coordination.sqlite` (WAL, STRICT tables, deferred
foreign keys, audit triggers). Two drivers behind one interface:

- **Bun** (OpenCode's plugin host, coordination tests): native `bun:sqlite`
- **Node** (CLI smoke tests, standalone tooling): the built-in `node:sqlite`
  (`DatabaseSync`) through an adapter that reproduces bun's `exec/query/transaction`
  surface, including savepoint-nested transactions

Key invariants (all test-enforced): canonical-JSON idempotency, immutable generations
and results, delivery state machines (`queued → unknown → submitted → accepted`),
close reservations that survive failure reports until reconciliation, and
compare-and-swap operation claims that exclude concurrent closes and in-flight dispatch.

### 3. The `herdr` shim (installed at `~/.local/bin/herdr`)

The plugin shells out to a `herdr` CLI (the TUI generation's surface). The shim
translates to the installed desktop generation:

| Plugin call | Shim translation |
| --- | --- |
| `herdr agent list` | `herdr-app ls` + `hc get` (panes, cwd) + OpenCode `/api/session` + `/api/session/active` (session identity + running state) |
| `herdr pane split/get/list/close/run` | `herdr-app do pane.*` / `terminal.open` / `hc send` |
| `herdr pane report-metadata` | Writes sidebar tokens to `~/.local/state/opencode-herdr/metadata/<pane>.json` for the mod |
| `herdr pane of-terminal <t>` | Helper used by `~/.zshrc` to resolve `HERDR_PANE_ID` from `HC_TERMINAL_ID` |

It resolves its binaries against `PATH` and then the usual install locations, so it
works from launch daemons and minimal environments. OpenCode session identity comes
from OpenCode itself; the shim prefers the *running* session in a terminal's directory
and otherwise the most recently updated one.

### 4. The Herdr mod (installed at `~/.config/herdr-app/mods/opencode-herdr/`)

A gpui-kit panel that renders, every 2 seconds:

- every OpenCode agent reported by the shim, with a live status dot (`working` / `idle`)
- the `$herdr_inbox`, `$herdr_outbox`, `$herdr_wait` tokens published by the plugin's
  delivery worker, colour-coded with Herdr's semantic theme colors
  (blue = queued, accent = active, yellow = blocked/needs review, green = done, red = failed)

Clicking an agent row focuses its pane (`agent.focus`). It never mutates coordination
state. Token semantics: only accepted **tasks** count toward `wait`; instructions
release their queue slot on acceptance.

## Setup

```sh
# 1. Build the plugin
cd /Users/phil/Projects/Herdr-A2A
npm install
npm run build        # emits dist/ (server: dist/index.js)

# 2. Register the plugin (package directory, not a file path)
#    ~/.config/opencode/opencode.jsonc:
#      "plugins": [{ "package": "/Users/phil/Projects/Herdr-A2A" }]

# 3. Shim + mod are already installed at:
#    ~/.local/bin/herdr
#    ~/.config/herdr-app/mods/opencode-herdr/
#    Show the panel: clone a layout, add a block with {"mod": "opencode-herdr"},
#    then layout.switch — or toggle it as an overlay with mod.open.

# 4. Environment (~/.zshrc) — Herdr sets HC_TERMINAL_ID/HC_TERMINAL_SOCKET per terminal
export HERDR_ENV=1
export HERDR_SOCKET_PATH="$HOME/.local/state/herdr-core/default/default.sock"
if [ -n "$HC_TERMINAL_ID" ] && [ -z "$HERDR_PANE_ID" ]; then
  export HERDR_PANE_ID="$("$HOME/.local/bin/herdr" pane of-terminal "$HC_TERMINAL_ID" 2>/dev/null | /usr/bin/sed -n 's/.*"pane": *"\([^"]*\)".*/\1/p' | head -1)"
fi

# 5. Restart the shared OpenCode service so it inherits the environment
opencode service restart   # or test with `opencode --standalone` in a Herdr terminal
```

**Activation check:** `opencode plugin list` must show `opencode-herdr`, and the
mod's sidebar panel should list your agent panes with status dots.

## Using it

Run OpenCode in two Herdr panes, then:

1. `list_agents` — discover exact identities (session ↔ pane binding is verified
   against the live Herdr inventory; a session that Herdr does not report is refused)
2. `request_agent` — queue a task (`hand_back` required) or an instruction
   (acknowledgement only) with an idempotency key
3. The recipient's pane receives the prompt automatically when idle (the delivery
   worker), shows `in` tokens in the sidebar, and calls `read_task` to accept
4. `hand_back` — the recipient publishes an immutable result; the sender's `out`
   tokens update, and `wait` decrements
5. `ask_coordinator` / `reply_question` for mid-task questions;
   `resume_request` for paused tasks; `list_operations` to reconcile uncertain
   provisioning effects

Agents that are reserved for closure refuse new work; a close operation keeps its
reservation even when the caller reports failure, until reconciliation confirms it.

## Testing

```sh
npm run typecheck            # tsc, strict
npm run test                 # node --test test/*.test.mjs (shortcut/TUI contracts)
npm run test:coordination    # bun --conditions=browser: store, delivery, provision,
                             # remote, mailbox, workflows — the full behavioural spec
npm run test:sqlite-host     # bun:sqlite inside real OpenCode plugin processes
node test/smoke              # see below: Node driver smoke test
```

The coordination suite is the specification: idempotency conflicts, delivery state
machines, audit rollback under injected SQLite failures, claim exclusivity, close
reservations, remote cache/snapshot validation and notice lifecycle are all
covered. Test fixtures resolve tmpdir through `realpathSync` (macOS `/var/folders`
is a symlink chain; production code checks paths the way real project folders arrive).

## Known limitations

- **Service environment** — the shared OpenCode service must be restarted after env
  changes; the plugin refuses tools until the session is reported by Herdr with a
  matching pane/socket/directory.
- **Session correlation** — the shim maps one OpenCode session per terminal
  (running session preferred, else most recent in that directory). Multiple OpenCode
  instances in the *same directory* can be ambiguous; distinct directories are exact.
- **TUI part** — `dist/tui.jsx` is still a V1 TUI plugin; the desktop mod covers the
  sidebar role on this machine. A V2 TUI port is future work.
- **Provisioning panes** — `open_agent` places new panes relative to the caller's
  pane and may briefly move focus (the desktop generation has no "split beside a
  non-focused pane" primitive yet).
- The old TUI generation's native sidebar (`herdr pane report-metadata`) is replaced
  by the shim + mod pipeline described above.

## Layout of this repository

```
src/
  index.ts        V2 plugin entry: tools, /herdr command, V1↔V2 adapters (only boundary)
  store.ts        SQLite coordination store (dual driver, full behavioural spec)
  delivery.ts     DeliveryWorker: prompt delivery, receipts, notice dispatch, sidebar publisher
  provision.ts    Provisioner: open/close agents, checkpoints, binding, reconciliation
  remote.ts       SSH peer transport + remote request cache/failure semantics
  mailbox.jsx     Mailbox TUI component
  sidebar.ts      Token projection ($herdr_inbox/outbox/wait) + metadata publisher
  shortcuts.ts    Herdr keybinding hints
  tui.tsx         V1 TUI sidebar (see limitations)
test/             Behavioural specification (bun) + contract tests (node)
docs/             Original design documents (TUI generation)
README-old.md     The original README (pre-V2, pre-bridge)
```
