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

## Multi-turn chain tests (4 and 6 hops)

Two ready-made relay chains test **multiple turns of sending and receiving**.
One command seeds leg 1; each hop's brief carries the next leg verbatim, so the
chain propagates through the agents themselves, and every hop hands the received
summary back up — the handback cascade ends at the starter.

```sh
# 4 sends: you → arcadedb → ICM → myenergi → you (acknowledgement leg)
node scripts/chain-test.mjs --hops 4

# 6 sends: you → arcadedb → ICM → myenergi → you → arcadedb → ICM (final ack)
node scripts/chain-test.mjs --hops 6

# Inspect the generated briefs without queueing anything
node scripts/chain-test.mjs --hops 6 --dry
```

What you should see:

1. The **Now** feed grows hop by hop: `enqueue:1` for each leg as each agent
   sends onward, interleaved with `accept`/`finish:1:completed` as handbacks
   cascade back down the chain.
2. **Processed** increments once per completed leg (4 for a clean 4-chain).
3. The final handback notice to your pane summarises the whole relay:
   `hop 1 (arcadedb): ICM replied: hop 2 … myenergi replied: chain hop 4 acknowledged…`
4. `node scripts/watch-store.mjs` shows every leg with its own idempotency key
   (`chain4-leg1` … `chain4-leg4`), so retries are safe: replaying the chain
   reuses the same keys and deduplicates.

Routes are **linear by design**: no agent ever receives a second leg while it
still holds an open task, so no hop can deadlock the store's one-pending-per-
agent queue. Intermediate holds queue and dispatch in order.

## The hello test (all agents greet each other)

A round-robin greeting across **every live OpenCode pane**: origin greets the
first agent, who greets the next, … and the last greeting lands back on the
origin, closing the circle. Each participant receives exactly one hello.

```sh
node scripts/hello-test.mjs                # seed the round from "Herdr-A2A"
node scripts/hello-test.mjs --dry          # print the leg briefs only
```

The Coordination panel's **Hello test** section does this with one click —
**▶ say hello** runs the script (the mod itself never mutates the store) and
then watches the round live: each leg appears with its state
(`queued → submitted → accepted → completed`), the greeter's handback summary,
and a verdict line (`leg 2/4 in flight`, `all 4 agents greeted each other ✓`,
or a blocked note naming the leg to cancel).

Design notes:

- Legs use fresh idempotency keys per run (`hello-<stamp>-legN`), so every
  click starts a **new** round.
- The script **refuses to start** while a previous round still has legs in
  flight (the one-pending-per-agent queue would muddle both runs). It names
  the blocking legs and the cancel command; `--force` overrides.
- Legs are compact by design (~300–500 characters) so 1.7B-class local models
  can copy them verbatim — a gentler relay test than the 4/6-hop chains.

**Model requirements.** Each intermediate agent must copy the next leg's text
verbatim — nested briefs grow with hop count (~600 characters for a 4-hop,
~900 for a 6-hop). Capable models handle this; a 1.7B-class local model may
mangle the relay text, and the chain stalls at that hop — the Now feed shows
exactly where it stopped. Idempotency keys are fixed, so you can re-run the
same chain command after fixing a stalled hop without creating duplicates:

```sh
# inspect where the chain stalled, then clear in-flight legs if needed
node scripts/watch-store.mjs
node scripts/cancel-request.mjs --id <legId> --from "<that pane>"
```

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

Real-world note: long-lived panes (900+ messages, compaction churn) are
**unreliable actors regardless of model** — their turns end without the tool
call. For self-tests, open a **fresh tab** for the test agent, wait for it to
appear in `herdr agent list`, and send the test there.

**Recipient loops on misfired tool calls.** A distinct 1.7B-class failure:
the model *intends* to call `read_task` but the harness executes `read` with
`path: ""` over and over — its own reasoning says "I need to issue the
read_task call directly" while every emitted call maps to the wrong tool.
The request stays `submitted` while the pane burns turns. This is a tool-
emission capability limit, not a pipeline fault: the same briefs complete on
capable models. Remedy: switch the relay panes to a stronger model (e.g.
`openrouter/z-ai/glm-5.3-flash`, or start LM Studio for
`qwen2.5-coder-14b-instruct`), cancel the stuck leg, and press ▶ again.

**Hallucinated handback (structurally rejected).** A leg once handbacked
"leg 4/4: all 4 agents said hello — all 4 agents greeted each other" while
legs 2–4 had never been created: the summary was prose, and nothing verified
it. The protocol now does. A brief that instructs a relay (`request_agent
… key "K"`) makes the agent promise request K exists — `hand_back` verifies
that and publishes the result with `validation: "rejected"` plus a risk
naming the missing relay when the promise is unmet. History renders it as
"Validation rejected" and the completion notice carries the risk. Only the
*direct* instruction counts (nested relay briefs travel JSON-escaped inside
the text and bind nobody at that hop), and an agent can never self-approve:
`rejected` is the sole caller-supplied validation value.

**Your second request shows `queued`.** The store allows **one pending request
per agent**; a stalled head blocks everything else to that pane. Cancel the
head (above) and the queued request delivers within seconds. Short request ids
(8 characters, as shown by `watch-store`) work everywhere — scripts resolve
them to the full id for you.

**Delivery swallowed by compaction.** If the model entry a session uses
declares a limit near the plugin overhead (~8k tokens of system prompt and
tool schemas), OpenCode compacts constantly — and a freshly delivered
coordination prompt can be compacted away **before any turn runs**. The
request then sticks at `submitted` forever, no activity appears anywhere
(no turn ever ran — Herdr's native idle was truthful), while the panel's
"coordination" badge still shows the store obligation. Seen when an entry
was declared at 6000. Rules: any `llama-local` tier entry must declare
**≥ ~10k** or sessions on it cannot host coordination at all (the 8K tier
is a known trap); and the panel's "coordination" badge means *an obligation
exists in the store*, not that a turn is running. The **default model**
must likewise be a ≥32k tier — every new session inherits it at birth, and
a fresh session on an under-declared default is starved before its first
turn (the "did /new and then nothing" signature).

**Free OpenRouter models 429.** Daily free-tier limit — use local models
(`llama-local/lfm3-opencode`) or a paid model for the test window.

**Local model says "Context size has been exceeded".** OpenCode's system prompt
plus the coordination plugins' tool schemas is ~8k tokens **before any
conversation**, so an 8192-token context window can never fit — not even a
fresh session. Two knobs must agree:

```sh
# server side — Llama.app's user override file takes over from its ctx picker
# (~/.config/llama/models.user.ini, [LiquidAI/LFM3-1.7B-GGUF:Q8_0] section):
#   ctx-size = 32768        # model is trained for 262k; extra window is cheap
# then restart the Llama app (not opencode) and verify:
curl -s http://127.0.0.1:9931/v1/models | python3 -c \
  "import json,sys; print(json.load(sys.stdin)['data'][0]['meta']['n_ctx'])"

# opencode side — ~/.config/opencode/opencode.jsonc must declare the same
# window ("limit": { "context": 32768, ... } on the lfm3-opencode-8k entry);
# the running service hot-reloads this — verify with `opencode api get /api/model`
```


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

## Mesh etiquette: panes belong to their humans

An agent (or a test script) **never reconfigures another pane** — no model
switches, no agent changes, no settings writes. A stalled hello leg is a
*finding*, reported through the watch; the pane's human decides whether to
bring in a different model. Two hard facts that make this non-negotiable:

- **Session size outlives model choice.** A pane whose session has grown
  large (e.g. 532K tokens) cannot run on a small-window local model at all —
  every turn overflows and auto-compaction dies at its tiny output cap
  (LFM3's 2048-token output killed a compaction that GLM would pass). Which
  model a pane needs is dictated by its session, not by the test at hand.
- **Switching is not restoring.** Re-applying "the model it had before"
  after a config rename re-applies ids that no longer resolve
  (`(unavailable)`), and mid-round switches clobber choices made in the
  pane. The delivery adapter now respects whatever the session chose
  (switches only when blank) — agents must extend it the same courtesy.

