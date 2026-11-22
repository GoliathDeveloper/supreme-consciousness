// opencode-herdr coordination panel.
//
// Presentation and interaction layer only: it renders the inbox/outbox/wait
// tokens published by the opencode-herdr plugin (via the `herdr` shim's
// metadata files), the plugin's agent inventory, live coordination activity
// (pending work and the transition feed), and a human-review history of what
// each agent asked another to do (read-only projection of the coordination
// store). Clicks only focus panes. It never changes coordination state — the
// plugin's SQLite store stays the source of truth.

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, exec, readTextFile, run, home, setBadge, checking } from "herdr";

const METADATA = () => `${home()}/.local/state/opencode-herdr/metadata`;

// token/state prefixes -> semantic theme colors (light and dark themes name the same colors)
const COLOR = {
  blocked: "blocked",
  active: "working",
  queued: "accent",
  done: "done",
  idle: "idle",
};
const STATE_COLOR = {
  completed: "done",
  failed: "blocked",
  paused: "blocked",
  accepted: "working",
  submitted: "working",
  unknown: "blocked",
  queued: "accent",
  cancelled: "idle",
};
const PENDING = new Set(["queued", "unknown", "submitted", "accepted"]);

const clip = (text, n) => {
  const s = String(text ?? "");
  return s.length > n ? `${s.slice(0, Math.max(0, n - 1))}…` : s;
};
const short = (label) => String(label ?? "").replace(/^OC \| /, "");
const clock = (ms, seconds) => {
  const d = new Date(Number(ms));
  if (isNaN(d)) return "";
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return seconds ? `${hm}:${String(d.getSeconds()).padStart(2, "0")}` : hm;
};

export default class CoordinationPanel extends View {
  init(props, cx) {
    this.tokens = {};
    this.agents = [];
    this.history = [];
    this.feed = [];
    this.processed = 0;
    this.counts = {};
    this.error = null;
    this.helloStatus = null;
    cx.spawn(async (cx) => {
      while (true) {
        await this.refresh();
        cx.notify();
        await cx.sleep(2000);
      }
    });
  }

  async refresh() {
    try {
      const listing = await exec("/bin/ls", ["-1", METADATA()]);
      const names = (listing.stdout || "").split("\n").filter((n) => n.endsWith(".json"));
      const tokens = {};
      for (const name of names) {
        const raw = await readTextFile(`${METADATA()}/${name}`);
        if (!raw) continue;
        try {
          const data = JSON.parse(raw);
          tokens[data.paneId ?? name.replace(/\.json$/, "")] = data.tokens ?? {};
        } catch {}
      }
      this.tokens = tokens;
      this.error = null;
    } catch {
      this.tokens = {};
      this.error = "Coordination metadata unavailable";
    }
    try {
      const inventory = await exec("herdr", ["agent", "list"]);
      if (inventory.code !== 0) {
        this.agents = [];
        this.error = `herdr shim failed (${inventory.code}): ${(inventory.stderr || "").slice(0, 200)}`;
      } else {
        this.agents = JSON.parse(inventory.stdout)?.result?.agents ?? [];
      }
    } catch (error) {
      this.agents = [];
      this.error = this.error ?? `Agent inventory unavailable: ${String(error).slice(0, 120)}`;
    }
    try {
      const review = await exec("herdr", ["review", "24"]);
      const parsed = JSON.parse(review.stdout || "{}")?.result;
      if (review.code === 0 && parsed) {
        this.history = parsed.requests ?? [];
        this.feed = parsed.feed ?? [];
        this.processed = parsed.processed ?? 0;
        this.counts = parsed.counts ?? {};
      } else {
        this.history = [];
        this.feed = [];
        this.processed = 0;
        this.counts = {};
      }
    } catch {
      this.history = [];
      this.feed = [];
      this.processed = 0;
      this.counts = {};
    }
    // Window badge: pending coordination work is visible even when this panel
    // is not on screen. Clear when nothing is owed.
    if (!checking()) {
      const pendingCount = Object.keys(this.pendingWork()).length;
      setBadge(pendingCount > 0 ? `⇄ ${pendingCount}` : null);
    }
  }

  // Pending coordination obligations per session: a queued/unknown/submitted
  // request means the prompt is on its way or the agent is acting; an accepted
  // task means it owes a handback. This is sticky where a session-execution
  // snapshot flickers, so people can see work the snapshots miss.
  pendingWork() {
    const pending = {};
    for (const entry of this.history ?? []) {
      if (!PENDING.has(entry.state)) continue;
      pending[entry.recipientSession] = { state: entry.state, brief: entry.brief, origin: entry.origin, id: entry.id };
    }
    return pending;
  }

  token(paneId, name) {
    const value = this.tokens?.[paneId]?.[name];
    return value ?? "idle 0";
  }

  chip(label, value) {
    const t = theme();
    const color = t[COLOR[String(value ?? "").split(" ")[0]] ?? "idle"];
    const rest = String(value ?? "").split(" ").slice(1).join(" ");
    return h_flex().gap(4).items_center().flex_none()
      .child(div().size(6).rounded(3).flex_none().bg(color))
      .child(div().text_color(t.muted).child(label))
      .child(div().text_color(color).child(rest));
  }

  tokenRow(label, value) {
    return this.chip(label, value);
  }

  agentRow(agent, pending) {
    const t = theme();
    const pane = agent.pane_id;
    const busy = agent.agent_status === "working";
    const work = pending[agent.sessionId ?? agent.agent_session?.value];
    const active = busy || Boolean(work);
    const conflict = Number(agent.conflict ?? 0) > 1;
    const ambiguous = Number(agent.ambiguous ?? 0) > 1;
    // Two status sources, shown when they disagree: the merged truth (TUI
    // signal + server execution map) and the TUI's own 7501 signal, which
    // stays idle for server-initiated turns — Herdr's native list reads only
    // that signal, which is why the two UIs disagree during coordination.
    const tuiIdle = agent.agent_status === "working" && agent.tui_status && agent.tui_status !== "working";
    const statusText = tuiIdle ? `working · tui reports ${agent.tui_status}` : work && !busy ? "coordination" : agent.agent_status ?? "unknown";
    const workLine = work
      ? div().text_color(t.working).child(clip(`↳ ${work.state === "accepted" ? "owed handback" : work.state}: ${work.brief}`, 120))
      : null;
    const conflictLine = conflict
      ? div().text_color(t.blocked).child(`⚠ this conversation is open in ${agent.conflict} panes — close the duplicate; coordination pauses until then`)
      : null;
    const ambiguousLine = ambiguous
      ? div().text_color(t.blocked).child(`⚠ ${agent.ambiguous} recent sessions share this pane's directory — the binding is a guess until its next turn re-binds it (or remove the orphaned session)`)
      : null;
    return v_flex().id(`agent-${pane}`).gap(4).p(8).rounded(6).bg(t.canvas)
      .on_click(() => run("agent.focus", { terminal: agent.terminal_id }))
      .child(h_flex().gap(6).items_center()
        .child(div().size(7).rounded(4).flex_none().bg(active ? t.working : t.idle))
        .child(div().flex_1().text_color(t.foreground).child(short(agent.name || agent.cwd || pane)))
        .child(div().text_color(active ? t.working : t.dim).child(statusText)))
      .when(Boolean(conflictLine), el => el.child(conflictLine))
      .when(Boolean(ambiguousLine), el => el.child(ambiguousLine))
      .when(Boolean(workLine), el => el.child(workLine))
      .child(h_flex().gap(12)
        .child(this.tokenRow("in", this.token(pane, "herdr_inbox")))
        .child(this.tokenRow("out", this.token(pane, "herdr_outbox")))
        .child(this.tokenRow("wait", this.token(pane, "herdr_wait"))));
  }

  historyRow(entry, liveBySession) {
    const t = theme();
    const color = t[STATE_COLOR[entry.state] ?? "idle"] ?? t.idle;
    const originAgent = liveBySession.get(entry.originSession);
    return v_flex().id(`hist-${entry.id?.slice(0, 8)}`).gap(3).p(8).rounded(6).bg(t.canvas)
      .on_click(() => { if (originAgent) run("agent.focus", { terminal: originAgent.terminal_id }); })
      .child(h_flex().gap(5).items_center()
        .child(div().size(6).rounded(3).flex_none().bg(color))
        .child(div().text_color(t.dim).flex_none().child(clock(entry.updatedAt)))
        .child(h_flex().gap(3).items_center().flex_1()
          .child(div().text_color(t.foreground).child(clip(short(entry.origin), 20)))
          .child(div().text_color(t.dim).child("→"))
          .child(div().text_color(t.foreground).child(clip(short(entry.recipient), 20))))
        .child(div().text_color(color).flex_none().child(entry.state)))
      .child(div().text_color(t.muted).child(clip(entry.brief, 170)))
      .when(Boolean(entry.summary), el => el.child(div().text_color(color).child(clip(`→ ${entry.summary}`, 170))))
      .child(div().text_color(t.dim).text_size(10.5).child((entry.transitions ?? []).join(" → ")));
    return row;
  }

  // ——— Hello test: round-robin greeting across all live agents ———
  //
  // The ▶ button shells out to scripts/hello-test.mjs (the mod itself never
  // mutates the store); the watch below renders the legs of the latest run
  // live from the same review projection, keyed on idempotencyKey "hello-*".

  runHello() {
    const t = theme();
    this.helloStatus = { text: "starting hello round…", color: t.dim };
    exec("node", [`${home()}/Projects/Herdr-A2A/scripts/hello-test.mjs`]).then((res) => {
      const lines = (res.stdout || "").split("\n").filter(Boolean);
      if (res.code === 0) {
        this.helloStatus = { text: clip(lines[1] ?? lines[0] ?? "hello round enqueued", 150), color: t.done };
      } else {
        const reason = (res.stderr || "").split("\n").find((l) => l.startsWith("Refusing")) ?? (res.stderr || "").split("\n").find(Boolean) ?? `exit ${res.code}`;
        this.helloStatus = { text: clip(reason, 150), color: t.blocked };
      }
    }).catch((error) => {
      this.helloStatus = { text: clip(`hello test failed: ${String(error).slice(0, 130)}`, 150), color: t.blocked };
    });
  }

  // Clear every in-flight hello leg so the guard allows a fresh round. Shells
  // out to scripts/hello-cancel.mjs — the mod never touches the store itself.
  cancelHello() {
    const t = theme();
    this.helloStatus = { text: "cancelling in-flight hello legs…", color: t.dim };
    exec("node", [`${home()}/Projects/Herdr-A2A/scripts/hello-cancel.mjs`]).then((res) => {
      const lines = (res.stdout || "").split("\n").filter(Boolean);
      const colour = res.code === 0 ? t.done : t.blocked;
      this.helloStatus = { text: clip(lines.find((l) => /cancelled|nothing|failed/.test(l)) ?? lines[0] ?? `exit ${res.code}`, 150), color: colour };
    }).catch((error) => {
      this.helloStatus = { text: clip(`cancel failed: ${String(error).slice(0, 130)}`, 150), color: t.blocked };
    });
  }

  // Legs of the newest hello run plus a one-line verdict. Grouping key is the
  // idempotencyKey prefix "hello-<run>-leg<n>"; runs sort by their base36 stamp.
  helloRun() {
    const legs = (this.history ?? [])
      .filter((e) => typeof e.key === "string" && e.key.startsWith("hello-"))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    if (!legs.length) return null;
    const run = legs[legs.length - 1].key.replace(/-leg\d+$/, "");
    const round = legs.filter((e) => e.key.startsWith(`${run}-leg`)).map((e) => ({
      ...e, n: Number(e.key.match(/-leg(\d+)$/)?.[1] ?? 0), total: Number(run.match(/^hello-/) ? legs.filter(l => l.key.startsWith(`${run}-leg`)).length : 0),
    }));
    const total = round.length;
    // A 'completed' leg with rejected validation is a failed hop: the handback
    // was published untrusted (a claimed relay that never fired).
    const completed = round.filter((l) => l.state === "completed" && l.validation !== "rejected").length;
    const inFlight = round.find((l) => PENDING.has(l.state));
    const failed = round.find((l) => ["failed", "cancelled"].includes(l.state) || (l.state === "completed" && l.validation === "rejected"));
    // Legs 2+ exist only once earlier hops relay them, so the round's full
    // size is taken from the briefs ("leg n/N"), never from what's visible yet.
    const expected = Math.max(...round.map((l) => Number(l.brief?.match(/leg \d+\/(\d+)/)?.[1] ?? 0)), total);
    let verdict = { text: `run ${run.replace(/^hello-/, "")}: leg ${Math.min(completed + 1, expected)}/${expected}`, color: theme().working };
    if (completed >= expected && expected > 0) verdict = { text: `run ${run.replace(/^hello-/, "")}: all ${expected} agents greeted each other ✓`, color: theme().done };
    else if (failed) verdict = failed.state === "cancelled"
      ? { text: `run ${run.replace(/^hello-/, "")}: leg ${failed.n} cancelled — press ▶ for a fresh round`, color: theme().dim }
      : failed.validation === "rejected"
        ? { text: `run ${run.replace(/^hello-/, "")}: leg ${failed.n} handback unverified — the claimed relay never fired`, color: theme().blocked }
        : { text: `run ${run.replace(/^hello-/, "")}: leg ${failed.n} failed — see History for the reason`, color: theme().blocked };
    else if (inFlight) verdict = { text: `run ${run.replace(/^hello-/, "")}: leg ${inFlight.n}/${expected} in flight (${inFlight.state})`, color: theme().working };
    return { run, legs: round, verdict };
  }

  helloSection() {
    const t = theme();
    const run = this.helloRun();
    const header = h_flex().gap(6).items_center().pt(4)
      .child(div().font_weight(600).text_color(t.foreground).child("Hello test"))
      .child(div().flex_1())
      .child(div().id("hello-cancel").px(8).py(3).rounded(5).bg(t.canvas).text_color(t.dim)
        .on_click(() => this.cancelHello())
        .child("✕ cancel"))
      .child(div().id("hello-run").px(8).py(3).rounded(5).bg(t.canvas).text_color(t.foreground)
        .on_click(() => this.runHello())
        .child("▶ say hello"));
    const status = this.helloStatus
      ? div().text_color(this.helloStatus.color).child(this.helloStatus.text)
      : div().text_color(t.dim).child("round-robin greeting across all live agents — click to run");
    return v_flex().id("hello-test").gap(4)
      .child(header)
      .child(status)
      .when(Boolean(run), (el) => el.child(div().text_color(run.verdict.color).child(run.verdict.text)))
      .when(Boolean(run), (el) => el.children(run.legs.map((leg) => {
        const color = t[STATE_COLOR[leg.state] ?? "idle"] ?? t.idle;
        return v_flex().id(`hello-${leg.id?.slice(0, 8)}`).gap(2).p(6).rounded(5).bg(t.canvas)
          .child(h_flex().gap(5).items_center()
            .child(div().size(6).rounded(3).flex_none().bg(color))
            .child(div().text_color(t.dim).flex_none().child(clock(leg.updatedAt, true)))
            .child(div().text_color(t.foreground).flex_1().child(`leg ${leg.n}: ${clip(short(leg.origin), 22)} → ${clip(short(leg.recipient), 22)}`))
            .child(div().text_color(color).flex_none().child(leg.state)))
          .when(Boolean(leg.summary), (row) => row.child(div().text_color(color).child(clip(`→ ${leg.summary}`, 130))));
      })));
  }

  // One broken section must not take the whole panel down: the caught error
  // renders inline so the failure is visible instead of a frozen frame.
  safe(label, build) {
    try { return build(); } catch (error) {
      const stack = String(error?.stack ?? error).replace(/\n+/g, " | ").slice(0, 260);
      return div().text_color(theme().blocked).child(`${label}: ${stack}`);
    }
  }

  render() {
    const t = theme();
    const list = this.agents ?? [];
    const history = this.history ?? [];
    const feed = this.feed ?? [];
    const pending = this.pendingWork();
    const liveBySession = new Map(list.map(a => [a.agent_session?.value, a]).filter(([session]) => Boolean(session)));
    const countText = Object.entries(this.counts ?? {}).map(([k, v]) => `${k} ${v}`).join(" · ") || "nothing yet";
    const header = h_flex().gap(6).items_center()
      .child(div().font_weight(600).text_color(t.foreground).child("Coordination"))
      .child(div().flex_1())
      .child(div().text_color(t.dim).child(`${list.length} agent${list.length === 1 ? "" : "s"} · processed ${this.processed ?? 0}`));

    return v_flex().id("coordination-panel").size_full().overflow_y_scroll().p(10).gap(8).bg(t.surface).text_size(11.5)
      .child(header)
      .when(Boolean(this.error), (el) => el.child(div().text_color(t.blocked).child(this.error)))
      .when(list.length === 0 && !this.error, (el) => el.child(div().text_color(t.dim).child("No OpenCode agents reported by the herdr shim")))
      .when(list.length > 0, (el) => el.children(list.map(a => this.safe(`agentRow ${a.pane_id?.slice(0, 8)}`, () => this.agentRow(a, pending)))))
      .child(h_flex().gap(6).items_center().pt(4)
        .child(div().font_weight(600).text_color(t.foreground).child("Now"))
        .child(div().flex_1())
        .child(div().text_color(t.dim).child("live transitions")))
      .when(feed.length === 0, (el) => el.child(div().text_color(t.dim).child("Nothing yet — transitions appear as agents coordinate")))
      .when(feed.length > 0, (el) => el.children(feed.slice(0, 6).map(step => this.safe(`feed ${step.transition}`, () => h_flex().gap(5).items_center()
        .child(div().text_color(t.dim).flex_none().child(clock(step.at, true)))
        .child(div().text_color(t.muted).flex_1().child(clip(short(step.actor), 26)))
        .child(div().text_color(t.foreground).child(step.transition))
        .child(div().text_color(t.dim).flex_none().child(step.request?.slice(0, 8) ?? ""))))))
      .child(this.safe("hello", () => this.helloSection()))
      .child(h_flex().gap(6).items_center().pt(4)
        .child(div().font_weight(600).text_color(t.foreground).child("History"))
        .child(div().flex_1())
        .child(div().text_color(t.dim).child(`${countText} · ${history.length} shown`)))
      .when(history.length === 0, (el) => el.child(div().text_color(t.dim).child("No requests recorded yet")))
      .when(history.length > 0, (el) => el.children(history.map(e => this.safe(`history ${e.id?.slice(0, 8)}`, () => this.historyRow(e, liveBySession)))))
      .child(h_flex().gap(4).items_center().child(div().text_color(t.dim).child("Click an agent, a transition or a history entry to focus its pane")));
  }
}
