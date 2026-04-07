# PLAN — openclaw-relay-plugin

## Overview

This is the complete, accurate implementation plan for the `openclaw-relay-plugin` — a native OpenClaw **channel plugin** that connects OpenClaw AI agents to the Relay messaging infrastructure.

This plan supersedes the original draft. It is grounded in the actual source code of `@openclaw/flow` (the closest comparable plugin), the OpenClaw core framework, and the WeCom community plugin.

---

## What "Channel Plugin" Actually Means

OpenClaw treats every messaging surface (Telegram, Slack, WeCom, Flow) as a "channel". A channel plugin registers with `api.registerChannel()` and implements a set of adapters. OpenClaw manages sessions, routing, AI invocation, and streaming — the plugin just handles:

1. **Gateway** — Receiving inbound messages (WebSocket, webhook, long-poll, etc.)
2. **Outbound** — Sending responses back to the external service
3. **Context** — Injecting relevant data into the agent's prompt

This plugin makes Relay one more channel. Apps sending events to Relay look like users sending messages on a messaging platform.

---

## Architecture

### Core Insight: One OpenClaw = One Agent

One OpenClaw instance is one AI agent identity. The channel registers exactly one account (`"relay"`):

- The `rla_` token is stored directly under `channels.relay.token`
- `gateway.startAccount(ctx)` is called once for the `"relay"` account
- One persistent WebSocket opens to Relay, authenticated with the token
- The **server URL is hardcoded**: `wss://api.relay.ckgworks.com/v1/ws/agent`

### Dispatch Flow

```
Relay WebSocket (inbound event)
  └── gateway.startAccount → WS message handler
        └── rt.channel.reply.finalizeInboundContext(...)  → msgCtx
              └── rt.channel.reply.dispatchReplyWithBufferedBlockDispatcher(...)
                    └── OpenClaw session (created or resumed by session_key)
                          └── before_prompt_build hook → inject payload as context
                                └── Agent runs (LLM + tools)
                                      └── llm_output hook → accumulate tokens_used
                                            └── dispatcherOptions.deliver(chunk)
                                                  └── Plugin sends { type: "token" } to Relay WS
                                agent_end hook
                                  └── Plugin sends { type: "reply" } to Relay WS
                                        └── state.removeEvent(session_key)
```

### No Build Step

OpenClaw loads plugins via **jiti** — a runtime TypeScript executor. There is no `tsup`, no `dist/`, no compile step. You write TypeScript and OpenClaw runs it directly. This is how `@openclaw/flow` works.

---

## Directory Structure

```
openclaw-relay-plugin/
├── index.ts                   ← Entry: definePluginEntry({ register(api) })
├── channel.ts                 ← createRelayPlugin() → full ChannelPlugin object
├── relay-ws.ts                ← RelayWebSocketManager: per-agent WS lifecycle
├── state.ts                   ← RelayPluginState: in-memory Map + TTL cleanup
├── config.ts                  ← resolveRelayConfig(): OpenClaw config + env vars
├── session-keys.ts            ← buildRelaySessionKey(), parseRelaySessionKey()
├── runtime.ts                 ← setRelayRuntime() / getRelayRuntime()
├── hooks.ts                   ← before_prompt_build, llm_output, agent_end
├── types.ts                   ← All TypeScript interfaces
├── package.json
├── openclaw.plugin.json
├── tsconfig.json
├── vitest.config.ts
├── tests/
│   ├── config.test.ts
│   ├── session-keys.test.ts
│   ├── state.test.ts
│   ├── relay-ws.test.ts
│   └── hooks.test.ts
└── docs/
    └── design.md              ← This file's source (architecture decisions)
```

---

## TypeScript Types (types.ts)

```typescript
// Config resolved from OpenClaw config file
// URL is hardcoded in the plugin — never user-facing
export const RELAY_WS_URL = "wss://api.relay.ckgworks.com/v1/ws/agent";

export type RelayPluginConfig = {
  token: string;                        // rla_ prefixed agent token
  reconnect: {
    enabled: boolean;                   // default: true
    maxRetries: number;                 // default: 5
    baseDelayMs: number;                // default: 1000
    maxDelayMs: number;                 // default: 60000
  };
};
// Note: No agents map — one OpenClaw = one agent. No ttl_days — session
// TTL is owned by OpenClaw framework (session.idleMinutes, default 60 min).

// Inbound from Relay WebSocket
export type RelayInboundEvent = {
  type: "event";
  event_id: string;
  app_id: string;
  thread_id: string;
  session_key: string;                  // "relay:{app_id}:{thread_id}"
  payload: unknown;
};

export type RelayPing = { type: "ping" };
export type RelayInboundMessage = RelayInboundEvent | RelayPing;

// Outbound to Relay WebSocket
export type RelayTokenMessage = {
  type: "token";
  event_id: string;
  token: string;
};

export type RelayReplyMessage = {
  type: "reply";
  event_id: string;
  tokens_used: number;
  final_reply: string;
};

export type RelayErrorMessage = {
  type: "error";
  event_id: string;
  error: string;
};

export type RelayPong = { type: "pong" };

export type RelayOutboundMessage =
  | RelayTokenMessage
  | RelayReplyMessage
  | RelayErrorMessage
  | RelayPong;

// Per-event state (in-memory)
export type RelayEventContext = {
  eventId: string;         // Current event_id — used to route tokens/reply back
  sessionKey: string;      // relay:{app_id}:{thread_id}
  payload: unknown;        // Original payload — injected into prompt
  tokensUsed: number;      // Accumulated from llm_output hook
  createdAt: number;       // Timestamp for internal cleanup (not user-configurable)
  finalReply: string;      // Accumulated full text for final reply message
};
// Note: agentId removed — one OpenClaw = one agent = no need to track which account
```

---

## Module: runtime.ts

Stores the OpenClaw runtime reference so it can be accessed from anywhere in the plugin without passing it through every function. Mirrors `@openclaw/flow/src/runtime.ts` exactly.

```typescript
let relayRuntime: any = null;

export const setRelayRuntime = (rt: any): void => {
  relayRuntime = rt;
};

export const getRelayRuntime = (): any => {
  if (!relayRuntime) throw new Error("[relay] Runtime not initialized");
  return relayRuntime;
};
```

---

## Module: config.ts

Resolves the plugin config from OpenClaw's config object. Only reads `token` — URL is hardcoded. Supports `${VAR}` env var interpolation in the token value.

```typescript
export const resolveRelayConfig = (cfg: any): RelayPluginConfig => {
  const relay = cfg?.channels?.relay ?? {};
  const rawToken = relay.token ?? "";

  if (!rawToken) {
    throw new Error("[relay] No token configured. Run: openclaw channels setup relay");
  }

  return {
    token: resolveEnvVar(rawToken),
    reconnect: {
      enabled: relay.reconnect?.enabled ?? true,
      maxRetries: relay.reconnect?.maxRetries ?? 5,
      baseDelayMs: relay.reconnect?.baseDelayMs ?? 1000,
      maxDelayMs: relay.reconnect?.maxDelayMs ?? 60000,
    },
  };
};

// Interpolates ${VAR_NAME} from process.env (optional — token is usually stored directly)
const resolveEnvVar = (value: string): string => {
  return value.replace(/\$\{([^}]+)\}/g, (_, name) => {
    const resolved = process.env[name];
    if (!resolved) throw new Error(`[relay] Missing env var: ${name}`);
    return resolved;
  });
};
```

---

## Module: session-keys.ts

Session key helpers. Relay sends `session_key: "relay:{app_id}:{thread_id}"`. We pass this directly to OpenClaw — no transformation needed. These helpers are for validation and parsing only.

```typescript
// "relay:portal:task-123"
export const isRelaySessionKey = (key: string): boolean =>
  key.startsWith("relay:");

export const parseRelaySessionKey = (key: string): { appId: string; threadId: string } | null => {
  const parts = key.split(":");
  if (parts.length < 3 || parts[0] !== "relay") return null;
  return { appId: parts[1], threadId: parts.slice(2).join(":") };
};
```

---

## Module: state.ts

In-memory state management for active events. Mirrors `@openclaw/flow/src/state.ts`.

```typescript
const TTL_MS = 24 * 60 * 60 * 1000;       // 24 hours default
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // Run cleanup hourly

export class RelayPluginState {
  private events = new Map<string, RelayEventContext>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  // Keyed by sessionKey (not event_id) — one active event per session
  setEvent(sessionKey: string, ctx: RelayEventContext): void {
    this.events.set(sessionKey, ctx);
  }

  getEvent(sessionKey: string): RelayEventContext | undefined {
    return this.events.get(sessionKey);
  }

  removeEvent(sessionKey: string): void {
    this.events.delete(sessionKey);
  }

  updateTokens(sessionKey: string, added: number, text: string): void {
    const ctx = this.events.get(sessionKey);
    if (!ctx) return;
    ctx.tokensUsed += added;
    ctx.finalReply += text;
  }

  evictExpired(ttlMs = TTL_MS): void {
    const now = Date.now();
    for (const [key, ctx] of this.events.entries()) {
      if (now - ctx.createdAt > ttlMs) {
        this.events.delete(key);
      }
    }
  }

  startCleanup(): void {
    this.cleanupTimer = setInterval(() => this.evictExpired(), CLEANUP_INTERVAL_MS);
  }

  stopCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }
}
```

---

## Module: relay-ws.ts

Per-agent WebSocket manager. Handles connection, reconnection with exponential backoff, ping/pong, and inbound message dispatch.

```typescript
type RelayWsOptions = {
  agentId: string;
  url: string;
  token: string;
  reconnect: RelayPluginConfig["reconnect"];
  onEvent: (event: RelayInboundEvent) => Promise<void>;
  log?: any;
};

export class RelayWebSocketManager {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private stopped = false;

  constructor(private opts: RelayWsOptions) {}

  async start(abortSignal: AbortSignal): Promise<void> {
    abortSignal.addEventListener("abort", () => {
      this.stopped = true;
      this.ws?.close();
    }, { once: true });

    await this.connect();
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;

    const { url, token, agentId, log } = this.opts;

    return new Promise((resolve) => {
      const ws = new WebSocket(url, {
        headers: { Authorization: `Bearer ${token}` },
      });

      ws.on("open", () => {
        log?.info?.(`[relay:${agentId}] Connected`);
        this.attempt = 0;
      });

      ws.on("message", async (data: Buffer) => {
        try {
          const msg: RelayInboundMessage = JSON.parse(data.toString());
          if (msg.type === "ping") {
            this.send({ type: "pong" });
          } else if (msg.type === "event") {
            await this.opts.onEvent(msg);
          }
        } catch (err) {
          log?.error?.(`[relay:${agentId}] Message parse error: ${err}`);
        }
      });

      ws.on("close", () => {
        log?.warn?.(`[relay:${agentId}] Disconnected`);
        this.ws = null;
        if (!this.stopped) {
          this.scheduleReconnect(resolve);
        } else {
          resolve();
        }
      });

      ws.on("error", (err: Error) => {
        log?.error?.(`[relay:${agentId}] WS error: ${err.message}`);
      });

      this.ws = ws;
    });
  }

  private scheduleReconnect(resolve: () => void): void {
    const { reconnect, agentId, log } = this.opts;
    if (!reconnect.enabled) { resolve(); return; }

    if (this.attempt >= reconnect.maxRetries) {
      log?.error?.(`[relay:${agentId}] Max retries reached. Giving up.`);
      resolve();
      return;
    }

    const delay = Math.min(
      reconnect.baseDelayMs * Math.pow(2, this.attempt),
      reconnect.maxDelayMs
    );
    // Add ±10% jitter to prevent thundering herd
    const jitter = delay * (0.9 + Math.random() * 0.2);
    this.attempt++;

    log?.info?.(`[relay:${agentId}] Reconnecting in ${Math.round(jitter)}ms (attempt ${this.attempt})`);
    setTimeout(() => this.connect().then(resolve), jitter);
  }

  send(msg: RelayOutboundMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }
}
```

---

## Module: hooks.ts

Three hooks that integrate with OpenClaw's agent lifecycle.

### before_prompt_build

Injects the Relay event payload as structured context so the agent knows what it's responding to.

```typescript
export const createBeforePromptBuildHook = (state: RelayPluginState) => {
  return (_event: any, ctx: any) => {
    const { sessionKey } = ctx;
    if (!sessionKey || !isRelaySessionKey(sessionKey)) return undefined;

    const eventCtx = state.getEvent(sessionKey);
    if (!eventCtx) return undefined;

    const parsed = parseRelaySessionKey(sessionKey);

    return {
      prependContext: [
        `## Relay Event`,
        `App: ${parsed?.appId ?? "unknown"}`,
        `Thread: ${parsed?.threadId ?? "unknown"}`,
        `Event ID: ${eventCtx.eventId}`,
        ``,
        `## Payload`,
        "```json",
        JSON.stringify(eventCtx.payload, null, 2),
        "```",
        ``,
        `Respond to this event. Your response will be streamed back to the app.`,
      ].join("\n"),
    };
  };
};
```

### llm_output

Tracks token usage per session so we can include it in the final `reply` message.

```typescript
export const createLlmOutputHook = (state: RelayPluginState) => {
  return (event: any, ctx: any) => {
    const { sessionKey } = ctx;
    if (!sessionKey || !isRelaySessionKey(sessionKey)) return;

    const outputTokens = event.usage?.output ?? 0;
    const assistantText = (event.assistantTexts ?? []).join("");

    if (outputTokens > 0 || assistantText) {
      state.updateTokens(sessionKey, outputTokens, assistantText);
    }
  };
};
```

### agent_end

Sends the final `reply` message to Relay and cleans up state.

```typescript
export const createAgentEndHook = (
  state: RelayPluginState,
  wsManager: RelayWebSocketManager   // single agent — no Map needed
) => {
  return async (event: any, ctx: any) => {
    const { sessionKey } = ctx;
    if (!sessionKey || !isRelaySessionKey(sessionKey)) return;

    const eventCtx = state.getEvent(sessionKey);
    if (!eventCtx) return;

    try {
      if (event.success) {
        wsManager.send({
          type: "reply",
          event_id: eventCtx.eventId,
          tokens_used: eventCtx.tokensUsed,
          final_reply: eventCtx.finalReply,
        });
      } else {
        wsManager.send({
          type: "error",
          event_id: eventCtx.eventId,
          error: event.error ?? "Agent turn failed",
        });
      }
    } catch (err) {
      // Swallow — don't crash the agent lifecycle
    }

    state.removeEvent(sessionKey);
  };
};
```

---

## Module: channel.ts

The full ChannelPlugin object. This is the heart of the plugin.

```typescript
export const createRelayPlugin = (
  config: RelayPluginConfig,
  state: RelayPluginState,
  wsManagers: Map<string, RelayWebSocketManager>,
) => ({
  id: "relay",

  meta: {
    id: "relay",
    label: "Relay (@ckgworks)",               // shown in channel list
    selectionLabel: "Relay (@ckgworks)",
    blurb: "Connect this OpenClaw agent to apps via the Relay AI messaging backbone.",
    order: 60,
  },

  capabilities: {
    chatTypes: ["direct"],  // All Relay events are direct-style
    media: false,
    threads: false,
    reactions: false,
    polls: false,
    edit: false,
    quoting: false,
  },

  reload: { configPrefixes: ["channels.relay"] },

  config: {
    // Single account — one OpenClaw instance = one agent
    listAccountIds: () => ["relay"],
    resolveAccount: (accountId: string) => {
      if (accountId !== "relay") return null;
      return {
        accountId: "relay",
        enabled: Boolean(config.token),
        token: config.token,
        url: RELAY_WS_URL,           // hardcoded — never user-facing
      };
    },
    defaultAccountId: () => "relay",
  },

  outbound: {
    deliveryMode: "gateway",
    textChunkLimit: 500,           // Small chunks → more token-like streaming
    sendText: async ({ to, text }: { to: string; text: string }) => {
      const eventCtx = state.getEvent(to);
      if (!eventCtx) return;

      const wsManager = wsManagers.get(eventCtx.agentId);
      wsManager?.send({
        type: "token",
        event_id: eventCtx.eventId,
        token: text,
      });
    },
  },

  gateway: {
    startAccount: async (ctx: any) => {
      const { accountId, log } = ctx;   // accountId === "relay"

      if (!config.token) {
        log?.warn?.(`[relay] No token configured — run: openclaw channels setup relay`);
        return;
      }

      // The deliver function dispatches an inbound event into OpenClaw
      const deliver = async (sessionKey: string, message: string, isNew: boolean) => {
        const rt = getRelayRuntime();
        const currentCfg = await rt.config.loadConfig();

        const msgCtx = rt.channel.reply.finalizeInboundContext({
          Body: message,
          RawBody: message,
          CommandBody: message,
          From: `relay:${sessionKey}`,
          To: `relay:${sessionKey}`,
          SessionKey: sessionKey,
          AccountId: accountId,
          OriginatingChannel: "relay",
          OriginatingTo: `relay:${sessionKey}`,
          ChatType: "direct",
          Provider: "relay",
          Surface: "relay",
          Timestamp: Date.now(),
          CommandAuthorized: true,
        });

        await rt.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
          ctx: msgCtx,
          cfg: currentCfg,
          dispatcherOptions: {
            deliver: async (payload: { text?: string; body?: string }) => {
              const text = payload?.text ?? payload?.body;
              if (text) {
                const eventCtx = state.getEvent(sessionKey);
                if (eventCtx) {
                  wsManagers.get(accountId)?.send({
                    type: "token",
                    event_id: eventCtx.eventId,
                    token: text,
                  });
                }
              }
            },
          },
        });
      };

      // Event handler: called when Relay sends us an event
      const onEvent = async (msg: RelayInboundEvent) => {
        const { event_id, session_key, payload } = msg;

        // Check for duplicate (in-flight event for same session)
        const existing = state.getEvent(session_key);
        if (existing && existing.eventId !== event_id) {
          log?.warn?.(`[relay:${accountId}] Dropping event ${event_id} — session busy`);
          return;
        }

        // Store event context
        state.setEvent(session_key, {
          agentId: accountId,
          eventId: event_id,
          sessionKey: session_key,
          payload,
          tokensUsed: 0,
          finalReply: "",
          createdAt: Date.now(),
        });

        // Dispatch into OpenClaw
        const isNew = !existing;
        const message = JSON.stringify(payload);
        await deliver(session_key, message, isNew);
      };

      // Start WebSocket manager for this agent
      const wsManager = new RelayWebSocketManager({
        agentId: accountId,
        url: RELAY_WS_URL,            // hardcoded — same for all agents
        token: config.token,
        reconnect: config.reconnect,
        onEvent,
        log,
      });
      wsManagers.set(accountId, wsManager);

      state.startCleanup();

      return wsManager.start(ctx.abortSignal).finally(() => {
        state.stopCleanup();
        wsManagers.delete(accountId);
      });
    },
  },

  directory: {
    self: async () => null,
    listPeers: async () => [],
    listGroups: async () => [],
  },
});
```

---

## Entry Point: index.ts

```typescript
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { setRelayRuntime } from "./runtime.js";
import { resolveRelayConfig } from "./config.js";
import { RelayPluginState } from "./state.js";
import { RelayWebSocketManager } from "./relay-ws.js";
import { createRelayPlugin } from "./channel.js";
import {
  createBeforePromptBuildHook,
  createLlmOutputHook,
  createAgentEndHook,
} from "./hooks.js";

export default definePluginEntry({
  id: "relay",
  name: "Relay",
  description: "Channel plugin connecting OpenClaw agents to apps via Relay",

  register(api: any) {
    setRelayRuntime(api.runtime);

    const config = resolveRelayConfig(api.config);
    const state = new RelayPluginState();
    const wsManagers = new Map<string, RelayWebSocketManager>();

    api.registerChannel({
      plugin: createRelayPlugin(config, state, wsManagers)
    });

    api.on("before_prompt_build", createBeforePromptBuildHook(state));
    api.on("llm_output", createLlmOutputHook(state));
    api.on("agent_end", createAgentEndHook(state, wsManagers));
  },
});
```

---

## package.json

```json
{
  "name": "@openclaw/relay",
  "version": "0.1.0",
  "description": "OpenClaw Relay channel plugin",
  "type": "module",
  "openclaw": {
    "extensions": ["./index.ts"],
    "channel": {
      "id": "relay",
      "label": "Relay",
      "selectionLabel": "Relay — AI messaging backbone",
      "blurb": "Connect OpenClaw agents to apps via the Relay AI messaging platform.",
      "order": 60
    }
  },
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "eslint .",
    "format": "prettier --write ."
  },
  "dependencies": {
    "ws": "^8.17.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "@types/ws": "^8.5.10",
    "typescript": "^5.4.0",
    "vitest": "^1.5.0"
  }
}
```

Note: No `@sinclair/typebox` needed (no tools in Phase 1). No `tsup` — OpenClaw uses jiti for direct TS loading. `openclaw` is NOT in deps; it's available at runtime.

---

## openclaw.plugin.json

```json
{
  "id": "relay",
  "channels": ["relay"],
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "required": ["token"],
    "properties": {
      "token": {
        "type": "string",
        "description": "Relay agent token (rla_...)"
      },
      "reconnect": { "type": "object" }
    }
  }
}
```

Note: `url` is not in the schema — it is hardcoded in the plugin. No `agents` key — one token per OpenClaw instance. No `ttl_days` — session TTL is OpenClaw framework responsibility.

---

## tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": ".",
    "declaration": true
  },
  "include": ["**/*.ts"],
  "exclude": ["node_modules", "dist"]
}
```

---

## Testing Strategy

Tests use `vitest`. No live Relay or OpenClaw connection needed — runtime and WS are mocked.

### config.test.ts
- Valid config resolves correctly with all defaults applied
- `${VAR}` is interpolated from process.env
- Missing env var throws with the var name
- Missing agents object returns empty agents map
- `resolveRelayConfig` handles missing `channels.relay` gracefully

### session-keys.test.ts
- `isRelaySessionKey("relay:portal:task-1")` → true
- `isRelaySessionKey("flow:direct:run-1")` → false
- `parseRelaySessionKey("relay:portal:task-1")` → `{ appId: "portal", threadId: "task-1" }`
- Thread IDs with colons parse correctly
- Invalid format returns null

### state.test.ts
- `setEvent` / `getEvent` / `removeEvent` round-trip correctly
- `updateTokens` accumulates correctly across multiple calls
- `evictExpired` removes entries older than TTL
- `evictExpired` keeps entries within TTL
- `startCleanup` / `stopCleanup` manage the interval timer

### relay-ws.test.ts
- Sends `pong` in response to `ping`
- Calls `onEvent` when a `{ type: "event" }` message arrives
- Schedules reconnect after WS close (mock timers)
- Stops reconnecting after `maxRetries`
- Applies jitter to reconnect delay
- Does not reconnect if `stopped = true` (abortSignal fired)
- `send()` is a no-op when WS is not open

### hooks.test.ts
- `before_prompt_build` returns undefined for non-relay session keys
- `before_prompt_build` returns structured context block for relay session keys
- `before_prompt_build` returns undefined if no event context in state
- `llm_output` accumulates `tokensUsed` and `finalReply`
- `llm_output` ignores non-relay sessions
- `agent_end` sends `reply` message on success
- `agent_end` sends `error` message on failure
- `agent_end` removes event from state after sending
- `agent_end` swallows errors (doesn't throw)

---

## Build Phases

### Phase 2a — Scaffold (Day 1)

- [ ] `npm init` with correct package.json (no tsup, no build scripts)
- [ ] Install `ws`, `@types/ws`, `typescript`, `vitest`
- [ ] Create `tsconfig.json`
- [ ] Create `openclaw.plugin.json`
- [ ] Create `src/types.ts` with all interfaces
- [ ] Create `src/runtime.ts`
- [ ] Confirm TypeScript compiles with no errors (`tsc --noEmit`)

### Phase 2b — Config & Session Keys (Day 1)

- [ ] Implement `src/config.ts` with env var interpolation
- [ ] Implement `src/session-keys.ts`
- [ ] Write and pass `tests/config.test.ts`
- [ ] Write and pass `tests/session-keys.test.ts`

### Phase 2c — State (Day 1)

- [ ] Implement `src/state.ts` with TTL cleanup
- [ ] Write and pass `tests/state.test.ts`

### Phase 2d — WebSocket Manager (Day 2)

- [ ] Implement `src/relay-ws.ts` (connect, ping/pong, reconnect, send)
- [ ] Write and pass `tests/relay-ws.test.ts` (mock WebSocket)

### Phase 2e — Hooks (Day 2)

- [ ] Implement `src/hooks.ts` (before_prompt_build, llm_output, agent_end)
- [ ] Write and pass `tests/hooks.test.ts`

### Phase 2f — Channel Plugin (Day 3)

- [ ] Implement `src/channel.ts` with all adapters
  - `meta`, `capabilities`, `config`, `outbound`, `gateway`, `directory`
  - `gateway.startAccount` with the full `deliver` + `onEvent` pipeline
- [ ] Wire everything in `index.ts`
- [ ] Verify TypeScript compiles with no errors

### Phase 2g — Integration Test Against Relay (Day 4)

Requires Phase 1 (Relay API) to be live.

- [ ] Register test agent in Relay dashboard → get `rla_` token
- [ ] Set token in `.env` → `RELAY_ATHENA_TOKEN=rla_...`
- [ ] Configure `~/.openclaw/openclaw.json` with `channels.relay.agents.athena`
- [ ] Install plugin via `openclaw plugins install ./` (local path)
- [ ] Confirm agent appears "connected" in Relay dashboard
- [ ] Send test event from a test app
- [ ] Confirm event is received in OpenClaw (check OpenClaw logs)
- [ ] Confirm `before_prompt_build` injected payload correctly
- [ ] Confirm token chunks arrive back at the test app
- [ ] Confirm final `reply` message arrives
- [ ] Confirm event appears in Relay dashboard event log
- [ ] Kill OpenClaw → confirm agent appears "offline" in Relay dashboard
- [ ] Restart OpenClaw → confirm reconnect and agent comes back online

### Phase 2h — Onboarding + Polish (Day 4)

- [ ] Implement onboarding adapter in `channel.ts`:
  - `openclaw channels setup relay` → single prompt: **Relay agent token** (`rla_` placeholder shown)
  - Token input is **visible as typed** — no masking
  - On submit: open a test WebSocket to `RELAY_WS_URL`, send auth, wait for ack
  - On success: write `{ channels: { relay: { token } } }` to config, print ✓ Connected as {agentName}
  - On existing config detected: show **Rotate token / Cancel** choice first
  - `openclaw configure` channel list shows **Relay (@ckgworks)** as the entry name
- [ ] Review all error messages for clarity
- [ ] Review all log messages (prefix `[relay:{agentId}]` consistently)
- [ ] Update this PLAN.md with anything discovered during build

---

## Error Handling Matrix

| Scenario | Behavior |
|---|---|
| Bad agent token | Relay closes WS with 4001. `RelayWebSocketManager` sees close → schedules reconnect. After `maxRetries`, logs fatal and stops. |
| Relay unreachable at startup | First connect attempt fails → exponential backoff retry. |
| Relay drops mid-session | WS close event → reconnect. In-flight event context stays in state until TTL. |
| Max retries exceeded | Log error. That agent's WS stops reconnecting. Others unaffected. |
| OpenClaw throws during deliver | Exception propagates from `dispatchReplyWithBufferedBlockDispatcher`. Catch in `onEvent` → send `{ type: "error" }` to Relay. |
| `agent_end` WS not open | `wsManager.send()` is a no-op. Log warning. State cleaned up anyway. |
| Duplicate event (same session, new event before reply) | Log warning, drop new event. This protects from Relay retries while agent is busy. |
| Payload too large | Relay rejects before delivery (>64KB). Plugin never sees it. |
| Session TTL expired | Old context evicted. Next event for same session_key creates fresh context. OpenClaw resumes session by key as usual. |
| Config missing token | `gateway.startAccount` logs warn and returns early. That account doesn't connect. |
| Missing env var | `resolveRelayConfig` throws at startup. OpenClaw logs error. |

---

## Key Lessons from Studying Existing Plugins

These patterns are drawn directly from `@openclaw/flow` and `openclaw-plugin-wecom` source code.

1. **Use `definePluginEntry`** — not a plain object export. It's the correct OpenClaw SDK wrapper.
2. **Store runtime in a module-level ref** (`runtime.ts`) — the `register(api)` callback is called once; the runtime is needed inside async handlers long after registration.
3. **`gateway.startAccount` is the main entrypoint** — it receives `ctx.abortSignal` and returns a Promise that resolves when the account shuts down. Use `waitUntilAbort(signal, cleanup)` or equivalent.
4. **`rt.channel.reply.finalizeInboundContext` + `dispatchReplyWithBufferedBlockDispatcher`** — this is the real dispatch mechanism, not a simple function call. Copy the exact shape from flow plugin.
5. **`deliveryMode: "gateway"` with `textChunkLimit`** — controls how OpenClaw batches agent output before calling `sendText`. Lower `textChunkLimit` = more frequent, smaller chunks = more token-like behavior.
6. **Deduplication is important** — Flow plugin checks `existing && !existing.completeCalled`. Relay should check for in-flight events before processing a new one for the same session.
7. **TTL cleanup must be started in `startAccount` and stopped on abort** — otherwise you leak intervals across restarts.
8. **Swallow errors in `agent_end`** — the hook must never throw. It would crash the agent lifecycle.
9. **No `openclaw` in package.json deps** — it's provided by the runtime. Only `ws` and dev deps go in the manifest.
10. **`configPrefixes` in `reload`** — tells OpenClaw which config paths should trigger a reload of this channel.

---

## Out of Scope for Phase 2

- Health check HTTP endpoint
- Automatic token rotation on auth failure (manual rotation via `setup relay` is in scope)
- Multiple concurrent events per session (queue)
- Redis-backed session persistence
- Cross-session state or agent-to-agent messaging
- ClawHub publishing
- Streaming improvements (Phase 7)

---

## Dependencies on Other Phases

| Dependency | Phase | Notes |
|---|---|---|
| Relay API WebSocket endpoint live | Phase 1 | Required for Phase 2g integration test |
| `rla_` agent tokens issued via dashboard | Phase 1 + 3 | Phase 1 for API, Phase 3 for UI |
| OpenClaw 22+ installed on machine | User env | Required for all phases |

All unit tests (Phases 2a–2f) can be completed without Phase 1 being live.

---

*Status: Architecture finalized. Single-agent model. Hardcoded URL. Onboarding in scope (Phase 2h).*
*Last updated: 2026-04-07 — v2: token-only config, RELAY_WS_URL constant, Relay (@ckgworks) label*
