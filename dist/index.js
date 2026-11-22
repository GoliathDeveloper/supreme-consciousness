import { Plugin } from "@opencode/plugin";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Store } from "./store.js";
import { DeliveryWorker, inventory, requestPrompt } from "./delivery.js";
import { Provisioner } from "./provision.js";
import { readRemoteConfig, RemoteTransport, remoteOutbox } from "./remote.js";
import { verifyRelay } from "./verify.js";
const json = (value) => JSON.stringify(value, null, 2);
// JSON Schema building blocks replacing the V1 tool.schema helpers.
const text = { type: "string", minLength: 1 };
const integer = { type: "integer", minimum: 1 };
const strings = { type: "array", items: { type: "string" } };
const enumerable = (...values) => ({ type: "string", enum: values });
function tool(definition) {
    return { ...definition, execute: (input, context) => definition.execute(input, context) };
}
export default Plugin.define({
    id: "supreme-consciousness",
    async setup(ctx) {
        const store = new Store();
        const directory = ctx.location.directory;
        let configured = false;
        // ——— V1 client emulation over the V2 plugin context ——————————————————————
        // The V1 SDK returned {data, error, response} envelopes and recorded
        // agent/model per user message; V2 returns bare values and models state
        // through switch messages and session fields. These adapters translate.
        const running = new Set();
        const events = new AbortController();
        void (async () => {
            for await (const event of ctx.event.subscribe({ types: ["session.status"], signal: events.signal })) {
                if (event.type !== "session.status")
                    continue;
                if (event.data.status.type === "idle")
                    running.delete(event.data.sessionID);
                else
                    running.add(event.data.sessionID);
            }
        })().catch(() => { });
        const messageParts = (message) => message.type === "user" && typeof message.text === "string" ? [{ type: "text", text: message.text }] : [];
        const legacyClient = {
            session: {
                async message({ path }) {
                    try {
                        const messages = await ctx.session.context({ sessionID: path.id });
                        const message = messages.find(m => m.id === path.messageID);
                        if (!message)
                            return { error: { name: "NotFoundError" }, response: { status: 404 }, data: undefined };
                        const info = { id: message.id, sessionID: path.id, role: message.type };
                        return { data: { info, parts: messageParts(message) }, response: { status: 200 } };
                    }
                    catch (error) {
                        return { error, response: { status: 0 }, data: undefined };
                    }
                },
                async get({ path }) {
                    const session = await ctx.session.get({ sessionID: path.id });
                    return { data: { ...session, directory: session.location?.directory } };
                },
                // V1 exposed the running-session map; absent sessions are idle. V2
                // derives the same truth from each session's busy/idle execution times
                // plus the live status event stream (covers sessions outside this list page).
                async status() {
                    const page = await ctx.session.list({ directory, limit: 500 });
                    const data = {};
                    for (const session of page.data) {
                        const time = session.time ?? {};
                        const executing = time.busy !== undefined && (time.idle === undefined || time.busy > time.idle);
                        data[session.id] = { type: executing || running.has(session.id) ? "busy" : "idle" };
                    }
                    for (const sessionID of running)
                        if (!data[sessionID])
                            data[sessionID] = { type: "busy" };
                    return { data };
                },
                // V1 recorded agent/model on each user message; V2 records them as
                // switch messages in the timeline. Rebuild that timeline so the worker's
                // settings fallback sees the same fields (modelID key preserved).
                async messages({ path }) {
                    const messages = await ctx.session.context({ sessionID: path.id });
                    let agent;
                    let model;
                    const data = messages.map(message => {
                        if (message.type === "agent-switched")
                            agent = message.agent;
                        if (message.type === "model-switched") {
                            const ref = message.model;
                            if (ref)
                                model = { providerID: ref.providerID, modelID: ref.id, ...(ref.variant !== undefined ? { variant: ref.variant } : {}) };
                        }
                        const info = { id: message.id, sessionID: path.id, role: message.type, agent, ...(model ? { model } : {}) };
                        return { info, parts: messageParts(message) };
                    });
                    return { data };
                },
                async promptAsync({ path, body }) {
                    // Assert persona/model only when the session has none. Re-asserting
                    // on every delivery clobbered mid-flight pane choices and re-applied
                    // stale ids after a config rename (sessions then pointed at an
                    // unresolvable model and showed "(unavailable)"). A session that
                    // already chose keeps its choice — including an unresolvable one,
                    // which must fail visibly rather than be silently "fixed".
                    const session = await ctx.session.get({ sessionID: path.id });
                    const blank = (v) => v === undefined || v === null || (typeof v === "string" && !v.trim());
                    if (body.agent && blank(session.agent))
                        await ctx.session.switchAgent({ sessionID: path.id, agent: body.agent });
                    if (body.model && blank(session.model?.providerID) && blank(session.model?.id)) {
                        await ctx.session.switchModel({ sessionID: path.id, model: { providerID: body.model.providerID, id: body.model.modelID, ...(body.variant !== undefined ? { variant: body.variant } : {}) } });
                    }
                    const text = body.parts.filter(part => part?.type === "text" && typeof part.text === "string").map(part => part.text).join("\n");
                    await ctx.session.prompt({ sessionID: path.id, id: body.messageID, text });
                    return { response: { status: 200 } };
                },
                async create({ query, body }) {
                    return { data: await ctx.session.create({ title: body?.title, location: { directory: query?.directory ?? directory } }) };
                },
            },
            config: {
                async get() {
                    const selected = await ctx.model.default();
                    const info = selected.data;
                    return { data: info ? { model: `${info.providerID}/${info.id}` } : {} };
                },
            },
        };
        const client = legacyClient;
        const worker = new DeliveryWorker(store, client, directory);
        const provisioner = new Provisioner(store, undefined, process.env, client);
        let peers = [];
        try {
            peers = readRemoteConfig().peers;
        }
        catch (error) {
            if (error.code !== "ENOENT") {
                store.close();
                throw new Error("Invalid supreme-consciousness peers.json; remote configuration must be private and valid");
            }
        }
        const remote = new RemoteTransport(store, peers);
        const origins = new Set();
        let stopped = false;
        let reconciliation;
        const caller = async (sessionID) => {
            if (!configured)
                throw new Error("Coordination is disabled until configuration passes its Envoy conflict check");
            if (!sessionID || sessionID.startsWith("remote:"))
                throw new Error("A local host-authenticated conversation is required");
            // Every plugin instance registers the same tool names, so a call may run
            // through any instance; bind on the calling session's own directory (the
            // session record), not on the instance location.
            const sessionDirectory = await ctx.session.get({ sessionID }).then(s => s.location?.directory ?? null).catch(() => null);
            const live = await inventory(store);
            // The TUI generation bound a tool call to HERDR_PANE_ID from a per-pane
            // server environment. The desktop generation shares one server across
            // panes, so the service environment cannot carry the calling pane; the
            // shim's session↔pane binding from Herdr's live layout is the pane
            // authority here. The conversation must be reported exactly once.
            const matches = live.filter(a => a.sessionId === sessionID && (sessionDirectory === null || a.directory === sessionDirectory));
            if (matches.length > 1)
                throw new Error("Conversation is reported in more than one Herdr pane; close the duplicate and refresh");
            if (matches.length === 0)
                throw new Error("Current conversation is not reported by Herdr. Install Herdr's OpenCode session integration and refresh.");
            origins.add(sessionID);
            return matches[0];
        };
        const refresh = () => {
            if (stopped || !configured || reconciliation)
                return;
            reconciliation = (async () => {
                const live = await inventory(store);
                for (const agent of live)
                    if (agent.paneId === process.env.HERDR_PANE_ID && agent.directory === directory)
                        origins.add(agent.sessionId);
                for (const origin of origins) {
                    await provisioner.reconcile(origin);
                    for (const peer of peers) {
                        await remote.sync(peer.id, origin);
                    }
                }
                await publishPeers();
            })().catch(() => console.error("supreme-consciousness: operation reconciliation deferred"))
                .finally(() => { reconciliation = undefined; });
        };
        // Remote peers for the GUI's Remote peers section. Written next to the
        // per-pane metadata files the mod already watches; the shim's `herdr
        // peers` command reads it back. Tokens never leave this file — it is a
        // name + counts snapshot, mode 0600, and a missing peer degrades to an
        // error row instead of vanishing.
        const metaDir = join(process.env.XDG_STATE_HOME || join(homedir(), ".local/state"), "supreme-consciousness", "metadata");
        const peersFile = join(metaDir, "peers.json");
        let lastPeers;
        const publishPeers = async () => {
            const statuses = [];
            for (const peer of peers) {
                try {
                    const agents = await remote.list(peer.id);
                    statuses.push({ id: peer.id, sshTarget: peer.sshTarget, machineId: peer.expectedMachineId, agents: agents.length, checkedAt: Date.now() });
                }
                catch (error) {
                    statuses.push({ id: peer.id, sshTarget: peer.sshTarget, machineId: peer.expectedMachineId, error: String(error?.message ?? error).slice(0, 200), checkedAt: Date.now() });
                }
            }
            const serialised = JSON.stringify(statuses, null, 2);
            if (serialised === lastPeers)
                return;
            try {
                mkdirSync(metaDir, { recursive: true, mode: 0o700 });
                writeFileSync(peersFile, serialised, { mode: 0o600 });
                lastPeers = serialised;
            }
            catch { /* display availability must never change lifecycle state */ }
        };
        const target = async (identity) => {
            const live = await inventory(store);
            const agent = live.find(a => a.id === identity);
            if (!agent)
                throw new Error("No exact live local agent. Refresh list_agents. Remote targets require peerId.");
            return agent;
        };
        // V1 ToolContext emulation for the domain modules: session-scoped fields
        // from the tool call, location from the plugin instance, permission via
        // the V2 assert API.
        const toolContext = (context) => ({
            sessionID: context.sessionID,
            messageID: context.messageID,
            agent: context.agent,
            directory,
            worktree: directory,
            abort: context.signal,
            metadata: () => { },
            ask: async (input) => {
                await ctx.permission.assert({
                    sessionID: context.sessionID,
                    agent: context.agent,
                    source: { type: "tool", messageID: context.messageID, id: context.id },
                    action: input.permission,
                    resources: input.patterns,
                    save: input.always,
                    metadata: input.metadata,
                });
            },
        });
        // Envoy conflict check — two queue implementations must not share these tools.
        const loaded = await ctx.plugin.list();
        if (loaded.data.some(plugin => /herdr-envoy|envoy-dist/.test(JSON.stringify(plugin)))) {
            store.close();
            throw new Error("Retire or disable the Envoy server plugin before enabling supreme-consciousness coordination. Two queue implementations must not share these tools.");
        }
        configured = true;
        await ctx.tool.transform((editor) => {
            editor.add(tool({
                name: "list_agents",
                description: "List exact local OpenCode agent identities, or configured remote peer identities. Discovery does not confer resource authority. Remote observations can be stale.",
                input: { type: "object", properties: { peerId: text }, additionalProperties: false },
                async execute(input, context) {
                    await caller(context.sessionID);
                    return { content: json(input.peerId ? await remote.list(input.peerId, context.sessionID) : await inventory(store)) };
                },
            }));
            editor.add(tool({
                name: "list_machines",
                description: "List this machine's persistent coordination identity and explicitly configured SSH peers. Does not return tokens.",
                input: { type: "object", properties: {}, additionalProperties: false },
                async execute(_, context) {
                    await caller(context.sessionID);
                    return { content: json({ local: store.machineId, peers: peers.map(({ id, expectedMachineId }) => ({ id, machineId: expectedMachineId })) }) };
                },
            }));
            editor.add(tool({
                name: "request_agent",
                description: "Queue a task or instruction for an exact agent. Tasks require handback. Instructions release their queue slot when accepted. Does not transfer resources or interrupt work. Reuse the idempotency key only for identical retries.",
                input: { type: "object", properties: { identity: text, kind: enumerable("task", "instruction"), text, executionPolicy: enumerable("advisory", "code_change"), idempotencyKey: text, peerId: text }, required: ["identity", "text", "idempotencyKey"], additionalProperties: false },
                async execute(input, context) {
                    await caller(context.sessionID);
                    const { identity, peerId, kind, executionPolicy, ...rest } = input;
                    if (!peerId)
                        await target(identity);
                    const request = { ...rest, kind: kind ?? "task", executionPolicy: executionPolicy ?? "advisory", recipientId: identity, originSessionId: context.sessionID, originDirectory: directory };
                    return { content: json(peerId ? await remote.request(peerId, request) : store.enqueue(request)) };
                },
            }));
            editor.add(tool({
                name: "read_task",
                description: "Accept and read the exact request delivery from your prompt. Requires requestId, generation and deliveryId. Preserves existing work. Instruction acceptance does not require handback.",
                input: { type: "object", properties: { requestId: text, generation: integer, deliveryId: text }, required: ["requestId", "generation", "deliveryId"], additionalProperties: false },
                async execute(input, context) {
                    const self = await caller(context.sessionID);
                    const request = store.request(input.requestId);
                    if (request.recipientId !== self.id || request.generation !== input.generation || request.deliveryId !== input.deliveryId)
                        throw new Error("Request does not match this conversation and generation");
                    if (!request.messageId || !await worker.receipt(context.sessionID, request.messageId, requestPrompt(request)))
                        throw new Error("Cannot confirm the delivery message");
                    return { content: json({ request: store.accept(input.requestId, input.generation, input.deliveryId, context.sessionID), questions: store.questions(input.requestId, context.sessionID),
                            policy: request.executionPolicy === "advisory" ? "Analyse and report only. Do not edit files or commit." : "Make scoped code changes. Do not commit, merge, discard or clean resources without separate authorisation." }) };
                },
            }));
            editor.add(tool({
                name: "hand_back",
                description: "Publish an immutable result for an accepted task generation. Completed does not commit, merge, close or delete anything. Pause keeps the task resumable. Instructions cannot hand back.",
                input: { type: "object", properties: { requestId: text, generation: integer, outcome: enumerable("completed", "paused", "failed"), summary: text, checks: strings, risks: strings, evidence: strings }, required: ["requestId", "generation", "outcome", "summary"], additionalProperties: false },
                async execute(input, context) {
                    await caller(context.sessionID);
                    const outcome = { outcome: input.outcome, summary: input.summary, checks: input.checks ?? [], risks: input.risks ?? [], evidence: input.evidence ?? [] };
                    // Relay integrity: a completed handback whose brief promised a relay
                    // (request_agent with an idempotency key) is untrusted when the
                    // promised request was never created — publish it rejected rather
                    // than trust the prose (a leg once announced "all 4 agents said
                    // hello" while legs 2-4 had never been created).
                    if (input.outcome === "completed") {
                        const missing = verifyRelay(store.request(input.requestId).text, key => store.byKey(key));
                        if (missing.length) {
                            outcome.validation = "rejected";
                            outcome.risks = [...outcome.risks, `Promised relay request(s) not created: ${missing.join(", ")} — the handback summary is unverified`];
                        }
                    }
                    return { content: json(store.finish(input.requestId, input.generation, context.sessionID, outcome)) };
                },
            }));
            editor.add(tool({
                name: "inspect_request",
                description: "Read authorised request history, immutable results, questions and delivery evidence. Does not accept queued work.",
                input: { type: "object", properties: { requestId: text, peerId: text }, required: ["requestId"], additionalProperties: false },
                async execute(input, context) {
                    await caller(context.sessionID);
                    return { content: json(input.peerId ? await remote.inspect(input.peerId, input.requestId, context.sessionID) : store.history(input.requestId, context.sessionID)) };
                },
            }));
            editor.add(tool({
                name: "list_requests",
                description: "Read this conversation's inbox and outbox. Unknown delivery is not failure. Accepted instructions do not await a result.",
                input: { type: "object", properties: {}, additionalProperties: false },
                async execute(_, context) {
                    await caller(context.sessionID);
                    const local = store.list(context.sessionID);
                    return { content: json({ ...local, outbox: [...local.outbox, ...remoteOutbox(store, context.sessionID)] }) };
                },
            }));
            editor.add(tool({
                name: "cancel_request",
                description: "Cancel your outgoing queue obligation. Does not retract an attempted prompt, interrupt an agent or remove resources. Already-submitted work may continue.",
                input: { type: "object", properties: { requestId: text, peerId: text }, required: ["requestId"], additionalProperties: false },
                async execute(input, context) {
                    await caller(context.sessionID);
                    return { content: json(input.peerId ? await remote.cancel(input.peerId, input.requestId, context.sessionID) : store.cancel(input.requestId, context.sessionID)) };
                },
            }));
            editor.add(tool({
                name: "resume_request",
                description: "Resume your paused task with an immutable continuation brief and fresh queue position. Does not recreate an agent or worktree.",
                input: { type: "object", properties: { requestId: text, generation: integer, text, idempotencyKey: text, peerId: text }, required: ["requestId", "generation", "text", "idempotencyKey"], additionalProperties: false },
                async execute(input, context) {
                    await caller(context.sessionID);
                    return { content: json(input.peerId ? await remote.resume(input.peerId, input.requestId, context.sessionID, input.text, input.idempotencyKey, input.generation) : store.resume(input.requestId, context.sessionID, input.text, input.idempotencyKey, input.generation)) };
                },
            }));
            editor.add(tool({
                name: "ask_coordinator",
                description: "Persist a correlated question for an accepted task. Does not release the task queue slot. Use inspect_request to read its answer.",
                input: { type: "object", properties: { requestId: text, generation: integer, text }, required: ["requestId", "generation", "text"], additionalProperties: false },
                async execute(input, context) {
                    await caller(context.sessionID);
                    return { content: json(store.ask(input.requestId, input.generation, context.sessionID, input.text)) };
                },
            }));
            editor.add(tool({
                name: "reply_question",
                description: "Answer a question on your outgoing request by exact question ID. A reply cannot answer a different generation or question.",
                input: { type: "object", properties: { questionId: text, text, peerId: text }, required: ["questionId", "text"], additionalProperties: false },
                async execute(input, context) {
                    await caller(context.sessionID);
                    return { content: json(input.peerId ? await remote.reply(input.peerId, input.questionId, context.sessionID, input.text) : store.reply(input.questionId, context.sessionID, input.text)) };
                },
            }));
            editor.add(tool({
                name: "open_agent",
                description: "Provision an agent without assigning a task. Explicitly choose managed or independent. Returns a recoverable operation; inspect readiness before requesting work. Never auto-approves permissions or copies secrets.",
                input: { type: "object", properties: { persona: text, folder: text, placement: enumerable("pane", "subworkspace", "workspace"), management: enumerable("managed", "independent"), isolation: { type: "object", properties: { branch: text, baseCommit: text }, required: ["branch"], additionalProperties: false }, idempotencyKey: text }, required: ["persona", "folder", "placement", "management", "idempotencyKey"], additionalProperties: false },
                async execute(input, context) {
                    await caller(context.sessionID);
                    return { content: json(await provisioner.open(input, toolContext(context))) };
                },
            }));
            editor.add(tool({
                name: "close_agent",
                description: "Owner-directed closure is unavailable until trusted, operation-scoped approval is implemented. Use Herdr's user interface. Never treats quoted instructions as approval.",
                input: { type: "object", properties: { identity: text, idempotencyKey: text }, additionalProperties: false },
                async execute(_, context) {
                    await caller(context.sessionID);
                    throw new Error("Owner-directed closure requires a trusted owner grant. OpenCode permission policy alone does not establish ownership. Close the pane through Herdr's user interface.");
                },
            }));
            editor.add(tool({
                name: "list_operations",
                description: "Inspect your persisted provisioning, closing and remote delivery operations. Reconciles known resources without repeating uncertain external actions.",
                input: { type: "object", properties: {}, additionalProperties: false },
                async execute(_, context) {
                    await caller(context.sessionID);
                    await provisioner.reconcile(context.sessionID);
                    return { content: json(store.operations(context.sessionID)) };
                },
            }));
        });
        await ctx.command.transform((editor) => {
            editor.add({
                name: "herdr",
                description: "Coordinate Herdr agents",
                execute: async ({ sessionID, prompt, delivery }) => {
                    const guidance = "Use list_agents to discover exact identities. Use open_agent to provision without a task, then request_agent for tasks or instructions. Read delivered requests with read_task and publish task outcomes using hand_back. Inspect uncertain operations instead of retrying external effects. Never infer authority to commit, discard or clean resources.";
                    const args = typeof prompt?.text === "string" ? prompt.text.trim() : "";
                    await ctx.session.prompt({ sessionID, text: args ? `${guidance}\n\n${args}` : guidance, delivery });
                },
            });
        });
        const timer = setInterval(refresh, 5000);
        timer.unref();
        worker.start();
        return async () => {
            stopped = true;
            clearInterval(timer);
            await worker.dispose();
            await reconciliation;
            events.abort();
            try {
                rmSync(peersFile, { force: true });
            }
            catch { /* best effort */ }
            store.close();
        };
    },
});
