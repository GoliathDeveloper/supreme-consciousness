import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
// The desktop generation's plugin host does not inherit the login-shell PATH
// (no ~/.local/bin), so a bare execFile("herdr") fails with ENOENT even when
// the shim is installed. Resolve it absolutely; HERDR_SHIM overrides.
export const shimPath = () => process.env.HERDR_SHIM ?? join(homedir(), ".local", "bin", "herdr");
import { createSidebarPublisher } from "./sidebar.js";
import { remoteOutbox } from "./remote.js";
const run = promisify(execFile);
// The identity the store pins at observation time; a live inventory entry must
// match it exactly before the worker serves or dispatches to that agent.
const IDENTITY_KEYS = ["id", "machineId", "sessionId", "socket", "paneId", "terminalId", "workspaceId", "directory"];
export const messageId = () => `msg_${(BigInt(Date.now()) * 0x1000n & 0xffffffffffffn).toString(16).padStart(12, "0")}${randomBytes(7).toString("hex")}`;
// Lease lifetime for agent claiming: far longer than the 2-second tick so a
// live worker never loses an agent mid-cycle, short enough that a wedged owner
// is taken over within a minute. The 45-second tick watchdog bounds the worst
// single serve; the lease deliberately covers a full worst-case serve.
export const LEASE_TTL = 30_000;
export const requestPrompt = (r) => `[supreme-consciousness request ${r.id} generation ${r.generation}] ` +
    `Call accept_delivery with requestId="${r.id}", generation=${r.generation}, deliveryId="${r.deliveryId}". ` +
    (r.kind === "instruction" ? "This is an instruction. Reading accepts it. Do not hand back a result." :
        "This is a task alongside your existing work. Call hand_back with the same requestId and generation when finished. " +
            "Do not commit, discard, merge or clean up resources unless separately authorised.");
export async function inventory(store, env = process.env, runner = run) {
    // The TUI generation set HERDR_ENV/HERDR_SOCKET_PATH in every pane. The
    // desktop generation's shared server daemons inherit neither — and processes
    // that do inherit them (service vs mod-exec'd scripts) must never disagree:
    // the socket is part of the binding identity, and a per-env value made every
    // button-launched script pin a different binding than the serving worker.
    // The shim itself is the Herdr signal here, so the socket identity is one
    // stable symbolic value for every process in this generation.
    if (env.HERDR_ENV !== undefined && env.HERDR_ENV !== "1")
        return [];
    const socket = "herdr-core:local";
    const response = await runner(shimPath(), ["agent", "list"], { timeout: 5000, maxBuffer: 4 * 1024 * 1024, env }).catch(() => null);
    if (!response)
        return [];
    const panes = JSON.parse(response.stdout).result?.agents;
    if (!Array.isArray(panes))
        throw new Error("Invalid Herdr inventory");
    const agents = [];
    const conflicts = new Set();
    for (const pane of panes) {
        if (pane.agent !== "opencode" || pane.agent_session?.agent !== "opencode" || pane.agent_session.kind !== "id")
            continue;
        if (![pane.pane_id, pane.terminal_id, pane.workspace_id, pane.cwd, pane.agent_session.value].every((s) => typeof s === "string" && s))
            continue;
        try {
            agents.push(store.observeAgent({ sessionId: pane.agent_session.value, socket,
                paneId: pane.pane_id, terminalId: pane.terminal_id, workspaceId: pane.workspace_id, directory: pane.cwd,
                label: pane.name || pane.terminal_title || pane.agent_session.value, state: pane.agent_status || "unknown", lastSeen: Date.now() }));
        }
        catch (error) {
            if (error instanceof Error && error.message === "Agent binding changed; refusing to rebind an existing conversation")
                conflicts.add(pane.agent_session.value);
            else
                throw error;
        }
    }
    return agents.filter(agent => !conflicts.has(agent.sessionId));
}
export class DeliveryWorker {
    store;
    client;
    discover;
    publish;
    stopped = false;
    active;
    timer;
    nextErrorAt = 0;
    // This worker instance's lease identity. The coordination store is
    // machine-wide, so every OpenCode server on the machine observes and serves
    // every Herdr-reported agent regardless of project directory; leases make
    // that safe by letting exactly one live worker act on each agent.
    owner = randomUUID();
    constructor(store, client, discover = () => inventory(store), publish = createSidebarPublisher()) {
        this.store = store;
        this.client = client;
        this.discover = discover;
        this.publish = publish;
    }
    start() {
        if (this.stopped || this.timer)
            return;
        this.timer = setInterval(() => void this.tick(), 2000);
        this.timer.unref();
        void this.tick();
    }
    async dispose() { this.stopped = true; clearInterval(this.timer); await this.active; this.store.releaseLeases(this.owner); }
    async receipt(agent, id, expected) {
        const response = await this.client.session.message({ path: { id: agent.sessionId, messageID: id }, query: { directory: agent.directory }, signal: AbortSignal.timeout(5000) });
        if (response.response.status === 404)
            return false;
        if (response.error || !response.data)
            throw new Error("Message readback unavailable");
        return response.data.info.id === id && response.data.info.sessionID === agent.sessionId && response.data.info.role === "user" &&
            response.data.parts.some(p => p.type === "text" && p.text === expected);
    }
    options(agent) {
        return { query: { directory: agent.directory }, signal: AbortSignal.timeout(5000), throwOnError: true };
    }
    async conversation(agent) {
        const conversation = await this.client.session.get({ ...this.options(agent), path: { id: agent.sessionId } });
        if (conversation.data?.id !== agent.sessionId || conversation.data.directory !== agent.directory)
            throw new Error("Conversation binding mismatch");
        return conversation.data;
    }
    async idle(agent) {
        const status = await this.client.session.status(this.options(agent));
        // The status endpoint omits idle sessions. An absent response is not an idle session.
        return !!status.data && (!status.data[agent.sessionId] || status.data[agent.sessionId].type === "idle");
    }
    async settings(agent) {
        const conversation = await this.conversation(agent);
        if (!await this.idle(agent))
            return;
        const nonblank = (value) => typeof value === "string" && !!value.trim();
        const object = (value) => {
            if (!value || typeof value !== "object" || Array.isArray(value))
                throw new Error("Invalid session settings");
            return value;
        };
        // The plugin's v1 SDK omits these fields; the runtime/v2 session schema includes them.
        const current = object(conversation);
        let persona;
        let model;
        let variant;
        if (current.agent !== undefined) {
            if (!nonblank(current.agent))
                throw new Error("Invalid session agent");
            persona = current.agent;
        }
        if (current.model !== undefined) {
            const selected = object(current.model);
            if (!nonblank(selected.providerID) || !nonblank(selected.id) ||
                (selected.variant !== undefined && typeof selected.variant !== "string"))
                throw new Error("Invalid session model");
            model = { providerID: selected.providerID, modelID: selected.id };
            variant = selected.variant;
        }
        if (!persona || !model) {
            const messages = await this.client.session.messages({ ...this.options(agent), path: { id: agent.sessionId } });
            if (!messages.data)
                throw new Error("Message history unavailable");
            const user = [...messages.data].reverse().find(m => m.info.role === "user")?.info;
            if (user?.role === "user") {
                if (!persona && nonblank(user.agent))
                    persona = user.agent;
                if (!model) {
                    const selected = object(user.model);
                    const selectedVariant = selected.variant ?? object(user).variant;
                    if (!nonblank(selected.providerID) || !nonblank(selected.modelID) ||
                        (selectedVariant !== undefined && typeof selectedVariant !== "string"))
                        throw new Error("Invalid message model");
                    model = { providerID: selected.providerID, modelID: selected.modelID };
                    variant = selectedVariant;
                }
            }
            else if (!model && persona) {
                const config = await this.client.config.get(this.options(agent));
                const configured = config.data?.model;
                const slash = configured?.indexOf("/") ?? -1;
                if (configured && slash > 0 && slash < configured.length - 1) {
                    model = { providerID: configured.slice(0, slash), modelID: configured.slice(slash + 1) };
                }
            }
        }
        // A pane label is not a persona. Empty legacy sessions need an explicit host agent.
        if (!persona || !model)
            throw new Error("Session agent/model unavailable");
        return { agent: persona, model, variant };
    }
    async live(expected) {
        if (this.stopped || (process.env.HERDR_ENV !== undefined && process.env.HERDR_ENV !== "1"))
            return;
        // Same stable socket identity as inventory() — see the comment there.
        const socket = "herdr-core:local";
        const agents = await this.discover();
        const agent = agents.find(a => a.socket === socket &&
            IDENTITY_KEYS.every(key => a[key] === expected[key]));
        if (!agent || agent.machineId !== this.store.machineId ||
            agents.filter(a => a.socket === socket && (a.sessionId === agent.sessionId || a.terminalId === agent.terminalId)).length !== 1)
            return;
        return agent;
    }
    report() {
        if (Date.now() < this.nextErrorAt)
            return;
        this.nextErrorAt = Date.now() + 30_000;
        // Transport errors can contain prompts or credentials. Never log their payloads.
        console.error("supreme-consciousness: reconciliation deferred; binding, settings or transport unavailable");
    }
    tick() {
        if (this.stopped)
            return Promise.resolve();
        if (this.active)
            return this.active;
        // A hung client call inside scan() must not freeze the worker forever:
        // the guard releases after 45 seconds so the next tick can run (attempts
        // are claimed atomically, so overlap is safe). The abandoned scan's own
        // rejection is swallowed — it reported through report() if it failed.
        const scanning = this.scan();
        scanning.catch(() => { });
        this.active = Promise.race([
            scanning,
            new Promise(resolve => { const t = setTimeout(resolve, 45_000); if (typeof t.unref === 'function')
                t.unref(); }),
        ]).catch(() => this.report())
            .finally(() => { this.active = undefined; });
        return this.active;
    }
    async scan() {
        if (process.env.HERDR_ENV !== undefined && process.env.HERDR_ENV !== "1")
            return;
        // Same stable socket identity as inventory() — see the comment there.
        const socket = "herdr-core:local";
        const agents = await this.discover();
        if (this.stopped)
            return;
        // The coordination store is machine-wide: this worker serves every
        // Herdr-reported agent on the shared server, in every project directory —
        // the point of the tool is coordinating agents working in different
        // projects. Scoping to the plugin's own directory left agents in other
        // projects queued forever. Two guards keep that safe: per-agent identity
        // pinning in serve(), and a store lease so that with several OpenCode
        // servers on one machine exactly one live worker acts on each agent
        // (claiming here also renews the lease every tick).
        const local = agents.filter(a => a.socket === socket);
        for (const agent of local) {
            if (this.stopped)
                return;
            if (agents.filter(a => a.socket === socket && (a.sessionId === agent.sessionId || a.terminalId === agent.terminalId)).length !== 1)
                continue;
            if (!this.store.claimAgent(agent.id, this.owner, Date.now(), LEASE_TTL))
                continue;
            await this.serve(agent);
        }
    }
    // Sidebar publication, then at most one queue action per agent, then notices
    // only while the agent has no pending request.
    async serve(agent) {
        if (agent.machineId !== this.store.machineId)
            return;
        let pinned;
        try {
            pinned = this.store.agent(agent.id);
        }
        catch {
            return;
        }
        if (IDENTITY_KEYS.some(key => agent[key] !== pinned[key]))
            return;
        try {
            const local = this.store.mailbox(agent.sessionId);
            await this.publish(agent.paneId, agent.sessionId, { ...local, outbox: [...local.outbox, ...remoteOutbox(this.store, agent.sessionId)] });
        }
        catch {
            this.report();
        }
        const request = this.store.pending(agent.id);
        if (request) {
            const target = this.store.history(request.id, agent.sessionId).deliveries.find(d => d.id === request.deliveryId)?.target;
            if (!target || Object.keys(target).some(key => target[key] !== agent[key]))
                return;
        }
        if (request?.messageId && request.state === "unknown") {
            await this.conversation(agent);
            if (await this.receipt(agent, request.messageId, requestPrompt(request)))
                this.store.submitted(request.id, request.messageId);
            return;
        }
        else if (request?.state === "queued" && ["idle", "done"].includes(agent.state)) {
            const settings = await this.settings(agent);
            const current = settings && await this.live(agent);
            if (current && ["idle", "done"].includes(current.state) && await this.idle(agent) && !this.stopped) {
                const id = messageId();
                if (this.store.attempt(request.id, request.generation, id)) {
                    const text = requestPrompt(request);
                    await this.client.session.promptAsync({ path: { id: agent.sessionId }, query: { directory: agent.directory },
                        body: { ...settings, messageID: id, parts: [{ type: "text", text }] }, signal: AbortSignal.timeout(15000), throwOnError: true });
                    if (await this.receipt(agent, id, text))
                        this.store.submitted(request.id, id);
                }
            }
            // Even a lost claim belongs to a competing worker's turn, not the notice outbox.
            return;
        }
        for (const notice of this.store.notices(agent.sessionId)) {
            if (notice.directory !== agent.directory)
                continue;
            if (notice.state === "unknown" && notice.messageId) {
                await this.conversation(agent);
                if (await this.receipt(agent, notice.messageId, notice.text))
                    this.store.noticeDelivered(notice.id, notice.messageId);
                return;
            }
            else if (notice.state === "pending" && ["idle", "done"].includes(agent.state) && !this.stopped) {
                const settings = await this.settings(agent);
                const current = settings && await this.live(agent);
                if (!current || !["idle", "done"].includes(current.state) || !await this.idle(agent) || this.stopped)
                    return;
                const id = messageId();
                if (!this.store.noticeAttempt(notice.id, id))
                    return;
                await this.client.session.promptAsync({ path: { id: agent.sessionId }, query: { directory: agent.directory },
                    body: { ...settings, messageID: id, parts: [{ type: "text", text: notice.text }] }, signal: AbortSignal.timeout(15000), throwOnError: true });
                if (await this.receipt(agent, id, notice.text))
                    this.store.noticeDelivered(notice.id, id);
                break;
            }
        }
    }
}
