import { execFile } from "node:child_process";
import { promisify } from "node:util";
export function requestPresentation(request) {
    const validation = typeof request.validation === "object" && request.validation !== null && "status" in request.validation
        ? request.validation.status : request.validation;
    switch (request.state) {
        case "queued": return { label: "Queued", colour: "primary", prefix: "queued" };
        case "submitted": return { label: "Submitted", colour: "primary", prefix: "active" };
        case "unknown": return { label: "Delivery unknown", colour: "warning", prefix: "blocked" };
        case "paused": return { label: "Paused", colour: "warning", prefix: "blocked" };
        case "failed": return { label: "Failed", colour: "error", prefix: "blocked" };
        case "cancelled": return { label: "Cancelled", colour: "textMuted", prefix: "idle" };
        case "accepted": return request.kind === "instruction"
            ? { label: "Acknowledged", colour: "accent", prefix: "done" }
            : { label: "Awaiting result", colour: "accent", prefix: "active" };
        case "completed":
            if (validation === "pending")
                return { label: "Needs review", colour: "warning", prefix: "blocked" };
            if (validation === "rejected")
                return { label: "Validation rejected", colour: "error", prefix: "blocked" };
            return { label: "Completed", colour: "success", prefix: "done" };
    }
}
export function queueTokens({ inbox, outbox }) {
    const token = (requests) => {
        const states = new Set(requests.map((request) => requestPresentation(request).prefix));
        const priority = ["blocked", "active", "queued", "done", "idle"];
        const prefix = priority.find((state) => states.has(state)) ?? "idle";
        return `${prefix} ${requests.length}`;
    };
    // Only accepted tasks await a result. Instructions never create a handback obligation.
    const waiting = outbox.filter((request) => request.kind === "task" && request.state === "accepted");
    return { herdr_inbox: token(inbox), herdr_outbox: token(outbox), herdr_wait: token(waiting) };
}
/** Call from the host's poll loop. Unchanged tokens refresh after 10 seconds. */
export function createSidebarPublisher(run = promisify(execFile)) {
    const published = new Map();
    const inFlight = new Set();
    return async (paneId, sessionId, projection) => {
        if (!paneId || !sessionId || inFlight.has(paneId))
            return false;
        const tokens = queueTokens(projection);
        const serialised = JSON.stringify(tokens);
        const previous = published.get(paneId);
        if (previous?.sessionId === sessionId && previous.tokens === serialised && Date.now() - previous.at < 10_000)
            return true;
        inFlight.add(paneId);
        try {
            await run("herdr", [
                "pane", "report-metadata", paneId,
                "--source", "opencode-herdr", "--agent", "opencode",
                "--applies-to-source", "herdr:opencode", "--ttl-ms", "30000",
                ...Object.entries(tokens).flatMap(([name, value]) => ["--token", `${name}=${value}`]),
            ], { timeout: 2_000 });
            published.set(paneId, { sessionId, tokens: serialised, at: Date.now() });
            return true;
        }
        catch {
            // Display availability must never change request or agent lifecycle state.
            return false;
        }
        finally {
            inFlight.delete(paneId);
        }
    };
}
