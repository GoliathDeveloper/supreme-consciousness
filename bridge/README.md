# Bridge — Herdr desktop generation adapters

Canonical copies of the two installed bridge components. Install = copy:

```sh
cp bridge/herdr-shim.mjs ~/.local/bin/herdr && chmod +x ~/.local/bin/herdr
cp -R bridge/mods/supreme-consciousness ~/.config/herdr-app/mods/
```

## `herdr` shim (`~/.local/bin/herdr`)

Translates the plugin's Herdr TUI-generation calls onto the installed
desktop generation (`herdr-app` / `herdr-core`) plus OpenCode's HTTP API:

- `agent list` — pane/session inventory from `herdr-app ls`, `hc get`,
  `/api/session` + `/api/session/active`
- `pane split|get|list|close|run` — layout commands
- `pane report-metadata` — writes sidebar tokens for the mod
- `pane of-terminal <t>` — resolves `HERDR_PANE_ID` for `~/.zshrc`
- `review [limit]` — **human-review projection of the coordination store**
  (read-only `sqlite3`): who asked whom, the briefs, outcomes, lifecycle
  transitions, and processed counts
- `mailbox <sessionId>` — **the mailbox one agent session sees** (read-only
  `sqlite3`): the exact items the in/out chips count — work orders both ways,
  delivered receipts as inbound mail, handbacks as outbound mail, remote
  operations as outbound placeholders
- `request <id>` — **one mailbox item in full** (read-only `sqlite3`):
  generations, deliveries, results, questions and audit trail; for a remote
  request, its latest cached SSH receipt instead of a local row

## Mod (`~/.config/herdr-app/mods/supreme-consciousness/`)

Presentation layer only: agent list with status dots, the
`$herdr_inbox/outbox/wait` tokens, a **processed** count, and clickable
in/out chips that open the agent's **mailbox** inline (items and detail
cards via `herdr mailbox` / `herdr request`) — all read-only, refreshed
every 2 s. Clicks focus panes or read the store; nothing here mutates
coordination state.
