# Testing agent-to-agent communication yourself

You do not need a model to cooperate to trigger a test — the request travels
through the coordination store, and the recipient pane receives it as a prompt
whenever it is idle. Three tools, all in this repository:

| Script | What it does |
| --- | --- |
| `scripts/send-request.mjs` | Queue a task or instruction for an agent (same call `request_agent` makes) |
| `scripts/cancel-request.mjs` | Cancel your outgoing request |
| `scripts/watch-store.mjs` | Read-only live view: every request, delivery state, audit trail |

The **Coordination panel** in the Herdr sidebar shows the same thing visually:
the **Now** feed (live transitions), per-agent tokens (`in/out/wait`), the
**processed** count, and **History** with the full briefs and results.

## Prerequisites (30-second health check)

```sh
opencode plugin list        # opencode-herdr must be listed
~/.local/bin/herdr agent list   # must report your OpenCode panes with session ids
```

If the plugin is missing or the shim errors: `npm run build` in this repo, then
`opencode service restart` (needed once after environment changes).

## The 60-second test

```sh
cd /Users/phil/Projects/Herdr-A2A

# 1. Queue an instruction for another pane (a substring of its pane label works)
node scripts/send-request.mjs --to "arcadedb" --from "Herdr-A2A" --kind instruction \
  --key mytest-1 "Self-test: call read_task with the exact values from the bracketed line above to acknowledge this instruction."

# 2. Watch it move
node scripts/watch-store.mjs
```

Expected states, in order:

```
queued → attempt (delivery claimed) → submitted (receipt verified in the pane)
→ accepted (the recipient called read_task — instruction acknowledged, done)
```

The recipient's pane receives the prompt automatically. For a **task**, the
recipient also calls `hand_back`, and the result is delivered back to your pane
as a notice — watch `wait` drop to 0 and `processed` increment.

## Triggering from inside a pane (no scripts)

In any OpenCode pane, just ask your agent:

> Use list_agents, then request_agent to send the agent called "arcadedb-claude"
> a task: ask it to report its machine id. Wait for the handback notice, then
> report it back to me.

The agent resolves the identity, queues the request, and the delivery worker
does the rest. `list_requests` shows the inbox/outbox from the pane's side;
`inspect_request` reads the full receipt of your own requests.

## The full two-leg chain (relay pattern)

Agent A asks agent B, which asks agent C:

```sh
node scripts/send-request.mjs --to "arcadedb" --from "Herdr-A2A" --kind task \
  --key relay-1 'Step 1: call request_agent with the identity of the agent
  named "Intelligent context manager" (use list_agents to get it), kind task,
  a fresh idempotencyKey, and text asking it in one sentence what its plugin
  does — tell it to hand_back with that sentence. Step 2: poll list_requests
  until that outgoing request shows completed. Step 3: hand_back for THIS task
  with summary "ICM says: <the sentence>".'
```

See `docs/live-bridge-demo.md` for a recorded run of exactly this pattern with
the audit trail.

## What the states mean

| Delivery state | Meaning |
| --- | --- |
| `queued` | waiting for the recipient to be idle |
| `unknown` | prompt attempted, receipt not yet proven |
| `submitted` | receipt verified in the recipient's session |
| `accepted` | recipient called `read_task` |
| `cancelled` | you cancelled it |

Request-level outcomes (`completed`/`paused`/`failed`) come from `hand_back`.
One request is pending per agent at a time — a stuck one blocks that agent's
queue until resolved or cancelled.

## Troubleshooting

**Stuck at `submitted` (the recipient never accepts).** The prompt was
delivered and verified, but the recipient's model did not call `read_task`.
Happens with small local models or very long sessions (the test pane had 892
messages and compacted mid-turn). Remedies, in order:

```sh
# 1. Cancel the stuck request so the queue unblocks
node scripts/cancel-request.mjs --id <requestId> --from "Herdr-A2A"

# 2. Re-prompt that pane directly: "Check list_requests and handle your
#    pending coordination request."  — or use a fresh, short pane for the
#    test: capable models (or fresh sessions for small local models)
#    accept reliably.
```

**Free OpenRouter models 429.** Daily free-tier limit — use local models
(`llama-local/lfm3-opencode`) or a paid model for the test window.

**Nothing is delivered.** Check `herdr agent list` shows the target pane with
a session id, and that the recipient is not already mid-turn. After any
`~/.zshrc` environment change, `opencode service restart` once.

**Privacy boundary.** `inspect_request` works only on your own requests (origin
or recipient). The full trail for any request is readable via
`scripts/watch-store.mjs` (owner path) or the History section of the panel.

## Cleanup

```sh
node scripts/cancel-request.mjs --id <requestId> --from "<your pane>"
node scripts/watch-store.mjs        # confirm it shows cancelled
```
