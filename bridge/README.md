# Bridge — Herdr desktop generation adapters

Canonical copies of the two installed bridge components. Install = copy:

```sh
cp bridge/herdr-shim.mjs ~/.local/bin/herdr && chmod +x ~/.local/bin/herdr
cp -R bridge/mods/opencode-herdr ~/.config/herdr-app/mods/
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

## Mod (`~/.config/herdr-app/mods/opencode-herdr/`)

Presentation layer only: agent list with status dots, the
`$herdr_inbox/outbox/wait` tokens, a **processed** count, and the reviewer's
**History** view (briefs, results, audit trails) — all read-only, refreshed
every 2 s. Clicks focus panes; nothing here mutates coordination state.
