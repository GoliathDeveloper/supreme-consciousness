// opencode-herdr coordination panel.
//
// Presentation and interaction layer only: it renders the inbox/outbox/wait
// tokens published by the opencode-herdr plugin (via the `herdr` shim's
// metadata files), the plugin's agent inventory, and a human-review history
// of what each agent asked another to do (read-only projection of the
// coordination store). Clicks only focus panes. It never changes
// coordination state — the plugin's SQLite store stays the source of truth.

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, exec, readTextFile, run, home } from "herdr";

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

const clip = (text, n) => {
  const s = String(text ?? "");
  return s.length > n ? `${s.slice(0, Math.max(0, n - 1))}…` : s;
};
const short = (label) => String(label ?? "").replace(/^OC \| /, "");
const clock = (ms) => {
  const d = new Date(Number(ms));
  return isNaN(d) ? "" : `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

export default class CoordinationPanel extends View {
  init(props, cx) {
    this.tokens = {};
    this.agents = [];
    this.history = [];
    this.processed = 0;
    this.counts = {};
    this.error = null;
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
      const review = await exec("herdr", ["review", "12"]);
      const parsed = JSON.parse(review.stdout || "{}")?.result;
      if (review.code === 0 && parsed) {
        this.history = parsed.requests ?? [];
        this.processed = parsed.processed ?? 0;
        this.counts = parsed.counts ?? {};
      } else {
        this.history = [];
        this.processed = 0;
        this.counts = {};
      }
    } catch {
      this.history = [];
      this.processed = 0;
      this.counts = {};
    }
  }

  token(paneId, name) {
    const value = this.tokens?.[paneId]?.[name];
    return value ?? "idle 0";
  }

  chip(label, value, colorName) {
    const t = theme();
    const color = t[colorName ?? COLOR[String(value ?? "").split(" ")[0]] ?? "idle"];
    const rest = String(value ?? "").split(" ").slice(1).join(" ");
    return h_flex().gap(4).items_center().flex_none()
      .child(div().size(6).rounded(3).flex_none().bg(color))
      .child(div().text_color(t.muted).child(label))
      .child(div().text_color(color).child(rest));
  }

  tokenRow(label, value) {
    const text = String(value ?? "idle 0");
    return this.chip(label, text);
  }

  agentRow(agent) {
    const t = theme();
    const pane = agent.pane_id;
    const status = agent.agent_status === "working" ? t.working : t.idle;
    return v_flex().id(`agent-${pane}`).gap(4).p(8).rounded(6).bg(t.canvas)
      .on_click(() => run("agent.focus", { terminal: agent.terminal_id }))
      .child(h_flex().gap(6).items_center()
        .child(div().size(7).rounded(4).flex_none().bg(status))
        .child(div().flex_1().text_color(t.foreground).child(short(agent.name || agent.cwd || pane)))
        .child(div().text_color(t.dim).child(agent.agent_status ?? "unknown")))
      .child(h_flex().gap(12)
        .child(this.tokenRow("in", this.token(pane, "herdr_inbox")))
        .child(this.tokenRow("out", this.token(pane, "herdr_outbox")))
        .child(this.tokenRow("wait", this.token(pane, "herdr_wait"))));
  }

  historyRow(entry) {
    const t = theme();
    const colorName = STATE_COLOR[entry.state] ?? "idle";
    const color = t[colorName] ?? t.idle;
    const agent = (this.agents ?? []).find(a => a.agent_session?.value && entry.origin && a.agent_session.value === undefined);
    // focus the origin pane when its session is live in the inventory
    const originAgent = (this.agents ?? []).find(a => a.agent_session?.value === (this.originSession?.[entry.id] ?? null));
    const counts = this.counts ?? {};
    return v_flex().id(`hist-${entry.id?.slice(0, 8)}`).gap(3).p(8).rounded(6).bg(t.canvas)
      .when(Boolean(originAgent), el => el.on_click(() => run("agent.focus", { terminal: originAgent.terminal_id })))
      .child(h_flex().gap(5).items_center()
        .child(div().size(6).rounded(3).flex_none().bg(color))
        .child(div().text_color(t.dim).flex_none().child(clock(entry.updatedAt)))
        .child(h_flex().gap(3).items_center().flex_1()
          .child(div().text_color(t.foreground).child(clip(short(entry.origin), 22)))
          .child(div().text_color(t.dim).child("→"))
          .child(div().text_color(t.foreground).child(clip(short(entry.recipient), 22))))
        .child(div().text_color(color).flex_none().child(entry.state)))
      .child(div().text_color(t.muted).child(clip(entry.brief, 150)))
      .when(Boolean(entry.summary), el => el.child(div().text_color(color).child(clip(`→ ${entry.summary}`, 160))))
      .child(div().text_color(t.dim).text_size(10.5).child((entry.transitions ?? []).join(" → ")));
  }

  render() {
    const t = theme();
    const list = this.agents ?? [];
    const history = this.history ?? [];
    const counts = this.counts ?? {};
    const countText = Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(" · ") || "nothing yet";
    const header = h_flex().gap(6).items_center()
      .child(div().font_weight(600).text_color(t.foreground).child("Coordination"))
      .child(div().flex_1())
      .child(div().text_color(t.dim).child(`${list.length} agent${list.length === 1 ? "" : "s"} · processed ${this.processed ?? 0}`));

    return v_flex().id("coordination-panel").size_full().overflow_y_scroll().p(10).gap(8).bg(t.surface).text_size(11.5)
      .child(header)
      .when(Boolean(this.error), (el) => el.child(div().text_color(t.blocked).child(this.error)))
      .when(list.length === 0 && !this.error, (el) => el.child(div().text_color(t.dim).child("No OpenCode agents reported by the herdr shim")))
      .when(list.length > 0, (el) => el.children(list.map(a => this.agentRow(a))))
      .child(h_flex().gap(6).items_center().pt(4)
        .child(div().font_weight(600).text_color(t.foreground).child("History"))
        .child(div().flex_1())
        .child(div().text_color(t.dim).child(`${countText} · ${history.length} shown`)))
      .when(history.length === 0, (el) => el.child(div().text_color(t.dim).child("No requests recorded yet")))
      .when(history.length > 0, (el) => el.children(history.map(e => this.historyRow(e))))
      .child(h_flex().gap(4).items_center().child(div().text_color(t.dim).child("Click an agent or a history entry to focus its pane")));
  }
}
