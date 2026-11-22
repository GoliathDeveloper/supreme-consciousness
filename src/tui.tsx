/** @jsxImportSource @opentui/solid */
import { createSignal, For, Show, onCleanup } from "solid-js";
import { Plugin } from "@opencode/plugin/tui";
import { configPath, formatBinding, loadShortcuts, type Shortcuts } from "./shortcuts.js";
import { Store } from "./store.js";
import { Mailbox } from "./mailbox.jsx";
import { remoteOutbox } from "./remote.js";
import type { ThemeColours, TuiApi } from "./sidebar.js";

// The V2 theme resolves nested semantic tokens whose paths have changed across
// releases; the projections speak the old flat palette. Map defensively — the
// first string found wins, so older runtimes keep working.
function flatColours(theme: unknown): ThemeColours {
  const pick = (...paths: string[][]): string => {
    for (const path of paths) {
      let value: unknown = theme;
      for (const key of path) value = (value as Record<string, unknown> | undefined)?.[key];
      if (typeof value === "string") return value;
    }
    return "";
  };
  return {
    text: pick(["text", "base"], ["base", "text", "base"], ["text"]),
    textMuted: pick(["text", "muted"], ["base", "text", "muted"], ["textMuted"]),
    primary: pick(["text", "action", "primary", "base"], ["base", "text", "action", "primary", "base"], ["primary"]),
    accent: pick(["text", "action", "secondary", "base"], ["accent"]),
    warning: pick(["text", "feedback", "warning", "base"], ["base", "feedback", "warning", "base"], ["warning"]),
    error: pick(["text", "feedback", "error", "base"], ["error"]),
    success: pick(["text", "feedback", "success", "base"], ["success"]),
  };
}

function Coordination(props: { api: TuiApi; sessionID: string }) {
  let store: Store;
  try { store = new Store(); }
  catch { return <text fg={props.api.theme.current.warning}>Coordination store unavailable</text>; }
  onCleanup(() => store.close());
  return <Mailbox api={props.api} sessionID={props.sessionID} store={{
    list: sessionID => { const local = store.list(sessionID); return { ...local, outbox: [...local.outbox, ...remoteOutbox(store, sessionID)] }; },
    history: (id, sessionID) => {
      const op = store.operations(sessionID).find(op => op.kind === "remote.request" && (op.result?.request as { id?: string } | undefined)?.id === id);
      return op ? { peerId: op.payload.peerId, state: op.state, request: op.result?.request, note: "Remote receipt. Use inspect_request with peerId for full live history." } : store.history(id, sessionID);
    },
  }} />;
}

function Sidebar(props: { api: TuiApi; shortcuts?: Shortcuts }) {
  const [expanded, setExpanded] = createSignal(false);
  const theme = () => props.api.theme.current;
  return <box flexDirection="column">
    <text fg={theme().text} onMouseUp={() => setExpanded((value) => !value)}>
      <b>{expanded() ? "\u25be" : "\u25b8"} Herdr shortcuts</b>
    </text>
    <Show when={expanded()}>
      <Show when={props.shortcuts} fallback={<text fg={theme().warning}>Cannot read Herdr config. Check config.toml and restart OpenCode.</text>}>
        {(shortcuts) => <>
          <text fg={theme().textMuted}>Prefix: <b>{formatBinding(shortcuts().prefix)}</b></text>
          <For each={shortcuts().groups}>{(group) => {
            const [open, setOpen] = createSignal(false);
            return <box flexDirection="column">
              <text fg={theme().text} onMouseUp={() => setOpen((value) => !value)}>
                <b>{open() ? "\u25be" : "\u25b8"} {group.title}</b>
              </text>
              <Show when={open()}>
                <For each={group.shortcuts}>{(shortcut) => <text fg={theme().textMuted}>
                  <span style={{ fg: theme().primary }}>{formatBinding(shortcut.binding)}</span>{":\t"}{shortcut.label}
                </text>}</For>
              </Show>
            </box>;
          }}</For>
        </>}
      </Show>
    </Show>
  </box>;
}

export default Plugin.define({
  id: "supreme-consciousness.shortcuts",
  setup: async (context) => {
    if (process.env.HERDR_ENV !== "1") return;
    const options = context.options as { configPath?: unknown; coordination?: unknown };
    if (options.configPath !== undefined && (typeof options.configPath !== "string" || !options.configPath)) {
      throw new Error("supreme-consciousness: configPath must be a non-empty string");
    }
    let shortcuts: Shortcuts | undefined;
    try {
      shortcuts = await loadShortcuts((options.configPath as string | undefined) ?? configPath());
    } catch {
      // A broken/unreadable config must not present defaults as the user's keys.
    }
    const api: TuiApi = {
      theme: { current: flatColours(context.theme) },
      ui: { dialog: {
        alert: (input) => void context.ui.dialog.alert(input),
        select: async (input) => await context.ui.dialog.select(input as Parameters<typeof context.ui.dialog.select>[0]),
      } },
    };
    context.ui.slot({
      append: "sidebar.content",
      render: ({ sessionID }) => <box flexDirection="column" gap={1}>
        <Show when={options.coordination !== false}><Coordination api={api} sessionID={sessionID} /></Show>
        <Sidebar api={api} shortcuts={shortcuts} />
      </box>,
    });
  },
});
