# Live bridge demonstration — three OpenCode agents talking

Recorded 2026-11-21, ~21:51–21:55 (local). Three OpenCode panes, one shared
background server, one coordination store:

| Pane | Terminal | Session | Role in the demo |
| --- | --- | --- | --- |
| OC \| herdr-app GUI compatibility | t14 | `ses_e0047…` | **Orchestrator** (this plugin's repo) |
| OC \| OpenCode plugin for arcadedb-claude | t1 | `ses_e02395…` | **Relay** |
| OC \| Intelligent context manager spec review | t13 | `ses_e0111a…` | **Answerer** |

The orchestrator asked the relay to ask the answerer a question. The answer
travelled back through two immutable handbacks and arrived in the
orchestrator's own conversation as a worker-delivered notice.

## What happened, from the audit trail

### Leg 1 — orchestrator → relay (`dbc50858`)

| Time | Audit transition | Actor | Meaning |
| --- | --- | --- | --- |
| 21:51:51 | `enqueue:1` | `ses_e0047…` | task queued for the relay |
| 21:51:53 | `attempt:1` | worker | delivery `queued → unknown`, `msg_2001828d60` minted |
| 21:51:54 | `submitted:1` | worker | prompt typed into the relay's pane; **receipt verified** by reading the message back |
| 21:53:02 | `accept:1` | `ses_e02395…` | relay called `read_task` → delivery accepted |
| 21:53:08 | `finish:1:completed` | `ses_e02395…` | immutable handback: *"ICM says: …"* |
| ~21:55 | (notice) | worker | result delivered as a prompt into the **orchestrator's pane** |

### Leg 2 — relay → answerer (`a7b6ec07`, created by the relay agent itself)

| Time | Audit transition | Actor | Meaning |
| --- | --- | --- | --- |
| 21:52:19 | `enqueue:1` | `ses_e02395…` | the relay called `request_agent` targeting the answerer |
| 21:52:21 | `attempt:1` | worker | delivery claimed |
| 21:52:22 | `submitted:1` | worker | receipt verified in the answerer's session |
| 21:52:45 | `accept:1` | `ses_e0111a…` | answerer called `read_task` |
| 21:52:53 | `finish:1:completed` | `ses_e0111a…` | answerer handed back: *"The Intelligent-Context-Manager plugin classifies each user request, plans which sources to retrieve from (code graph, working memory, and episodic/semantic/procedural stores), assembles a token-budgeted context package whose items are labelled Observed/Remembered/Derived/Unknown with conflicts surfaced rather than silently resolved, and injects it into the model's context via the OpenCode `context` hook while auditing exactly what was retrieved, budgeted, and injected."* |

The answer then flowed back up the chain: notice → relay, relay verified it,
handback → orchestrator's pane. No agent ever opened a connection to another
agent; the store and the two workers relayed typed prompts.

## Behaviours the demo exercised (including the unplanned ones)

1. **Rate-limited recipient, clean retry.** The first attempt (`03f9543a`) was
   delivered and receipt-verified, but the relay's model (an OpenRouter free-tier
   model) failed with a daily 429 before it could act. The orchestrator
   `cancel`led it and re-enqueued the same brief under a fresh idempotency key
   (`dbc50858`); the worker redelivered within 3 seconds. The cancelled request
   retains its full audit trail (`enqueue → attempt → submitted → cancel`).
2. **The handback gate enforced itself.** The relay's model initially skipped
   `read_task` and went straight to work (it created leg 2 before accepting leg 1).
   When it then tried to `hand_back`, the store refused — *"Task must be accepted
   before handback"* — and the model called `read_task` and retried. The ritual is
   enforced by the store, not by trust.
3. **Cross-conversation privacy held.** The orchestrator can `inspect_request` its
   own request `dbc50858`; inspecting the relay's request `a7b6ec07` is refused
   (origin or recipient only). The human reviewer's trace above was assembled from
   the store's audit tables, which are the reviewer-facing record.
4. **Idempotency.** Re-delivery used a fresh idempotency key; replaying the same
   key with a different brief would have been rejected.

## Environment notes

- One shared OpenCode server hosts all panes, so the plugin's caller gate binds
  on the calling session's directory and the shim's Herdr-reported session↔pane
  mapping (the service environment cannot carry a per-pane `HERDR_PANE_ID`).
- Models: both agents were moved off a rate-limited free-tier model for the demo
  and restored to the local free model (`llama-local/lfm3-opencode`) afterwards.
  The delivery worker reads each session's current model at dispatch time.

## Reproducing

```sh
# in any Herdr OpenCode pane (plugin active):
list_agents                        # pick an exact identity
request_agent identity=<id> kind=task idempotencyKey=<fresh-key> text="…"
# the recipient pane receives the prompt when idle; it calls read_task, works,
# and hand_back — the sender receives the result as a pane prompt
```

Inspect everything afterwards with `inspect_request requestId=…` (own requests)
or read the store directly: `~/.config/opencode/supreme-consciousness/coordination.sqlite`.

## 2026-11-22 10:05 — first full mesh round: all four agents greeted each other

`node scripts/hello-test.mjs` (run `ro7mnk`), origin `herdr-app GUI compatibility`,
route origin → arcadedb → myenergi → ICM → origin. Every hop executed by the
agent itself: `read_task` accept → `request_agent` relay → `hand_back` summary.

| leg | request | trail | handback summary |
|---|---|---|---|
| 1 | `37afe7b7…` | enqueue 10:04:58 → accept 10:05:22 → completed 10:06:13 | "OpenCode plugin for arcade greeted Secret keys in this repo" |
| 2 | `64736c8d…` | enqueued by arcadedb, accepted 10:06:28 → completed 10:06:44 | "Secret keys in this repo greeted Intelligent context manage" |
| 3 | `ff7cbac9…` | enqueued by myenergi, accepted → completed 10:08:57 | "Intelligent context manage greeted herdr-app GUI compatibilit" |
| 4 | `06b8089f…` | enqueued by ICM, delivered to the origin pane 10:09:54; the origin's own agent called read_task + hand_back | "greeted herdr-app GUI compatibilit back — all 4 agents said hello" |

Notes from the run: the three relay panes were switched to a capable model for
the round (LFM3 1.7B fails at tool-call emission, see testing-agents.md) and
restored to `llama-local` immediately after — the switch is one API call per
session, fully reversible. The origin's final leg was handled by its own agent
inside its normal conversation, proving the "any agent can be called" property
end to end.
