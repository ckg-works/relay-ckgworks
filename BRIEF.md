# BRIEF — openclaw-relay-plugin

## What This Is

`openclaw-relay-plugin` is a **native OpenClaw channel plugin** that connects Relay to OpenClaw agents. It makes Relay look like a messaging channel — the same way Telegram or Slack are channels — so OpenClaw agents can receive events from any app connected to Relay and stream responses back in real-time.

**Relay** is the AI messaging backbone for CKG Works / Smiling Group apps. Apps connect via WebSocket, send events when they need AI help, and Relay routes those to agents. This plugin is the agent-side bridge.

## Where It Fits

```
App (e.g. Portal)
  └── WebSocket (rlk_ token)
        → Relay
          └── WebSocket (rla_ token)
                → openclaw-relay-plugin  ← THIS
                      └── OpenClaw session + agent
                            └── token stream → Relay → App
```

**One OpenClaw instance = one agent.** Each OpenClaw install is a single AI agent identity. The plugin registers one persistent WebSocket connection to Relay using the agent's `rla_` token.

## How It Works (End-to-End)

1. Plugin starts → `gateway.startAccount` fires for each configured agent
2. Each agent opens a WebSocket to Relay, authenticated with its `rla_` token
3. Relay sends `{ type: "event", event_id, session_key, payload }` to the agent's WS
4. Plugin calls `rt.channel.reply.dispatchReplyWithBufferedBlockDispatcher(...)` to route the event into the correct OpenClaw session
5. OpenClaw runs the agent (with payload injected as context via `before_prompt_build` hook)
6. As the agent streams, OpenClaw calls `dispatcherOptions.deliver(chunk)` repeatedly
7. Plugin sends each chunk to Relay as `{ type: "token", event_id, token }`
8. When agent finishes, `agent_end` hook sends `{ type: "reply", event_id, tokens_used, final_reply }`

## Plugin Architecture (OpenClaw Channel Pattern)

This plugin follows the exact same channel pattern as `@openclaw/flow`. It does NOT bundle or compile — OpenClaw loads it directly via jiti at runtime.

```
openclaw-relay-plugin/
├── index.ts              ← Entry point: register(api) → channel + hooks
├── channel.ts            ← ChannelPlugin object with all adapters
├── relay-ws.ts           ← WebSocket manager per agent (connect/reconnect/send)
├── state.ts              ← In-memory event context store + TTL cleanup
├── config.ts             ← Config resolver from OpenClaw config + env vars
├── session-keys.ts       ← Session key builders and parsers
├── runtime.ts            ← Runtime reference holder (setRelayRuntime / getRelayRuntime)
├── hooks.ts              ← before_prompt_build + agent_end + llm_output hooks
├── types.ts              ← All TypeScript interfaces
├── package.json          ← openclaw field for plugin discovery
└── openclaw.plugin.json  ← Plugin manifest + config schema
```

## Registration Pattern (index.ts)

```typescript
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

export default definePluginEntry({
  id: "relay",
  name: "Relay",
  register(api) {
    setRelayRuntime(api.runtime);
    const config = resolveRelayConfig(api.config);
    const state = new RelayPluginState();

    api.registerChannel({ plugin: createRelayPlugin(config, state) });
    api.on("before_prompt_build", createBeforePromptBuildHook(state));
    api.on("llm_output",          createLlmOutputHook(state));
    api.on("agent_end",           createAgentEndHook(state));
  }
});
```

## Channel: Single Agent per Instance

One OpenClaw install = one agent identity. The channel uses a single account (`"relay"`):

- `listAccountIds()` → `["relay"]`
- `resolveAccount("relay")` → `{ token: "rla_...", url: "wss://api.relay.ckgworks.com/v1/ws/agent" }`
- `gateway.startAccount(ctx)` → opens one persistent WebSocket to Relay

The **server URL is hardcoded** in the plugin — `wss://api.relay.ckgworks.com/v1/ws/agent`. Every agent uses the same endpoint. No user needs to know or configure it.

## Config Location

Config lives in OpenClaw's `~/.openclaw/openclaw.json` under `channels.relay`. After running `openclaw channels setup relay`, only the token is stored:

```json
{
  "channels": {
    "relay": {
      "token": "rla_live_a8f2k9m3p7x1q5n6..."
    }
  }
}
```

That's it. No URL, no agent list, no TTL. The setup wizard asks for one thing: the `rla_` token.

Session TTL is managed by OpenClaw at the framework level (`session.idleMinutes`, default 60 min). The plugin does not configure it.

Env var interpolation (`${VAR}`) is supported by the config resolver if needed, but the onboarding flow prompts for the token directly.

## Key Relay WebSocket Protocol

**Inbound (Relay → Plugin):**
```json
{
  "type": "event",
  "event_id": "evt_k9p2m",
  "app_id": "portal",
  "thread_id": "task-123",
  "session_key": "relay:portal:task-123",
  "payload": { ... }
}
```

**Outbound tokens (Plugin → Relay, streaming):**
```json
{ "type": "token", "event_id": "evt_k9p2m", "token": "Hello" }
```

**Outbound reply (Plugin → Relay, final):**
```json
{
  "type": "reply",
  "event_id": "evt_k9p2m",
  "tokens_used": 1500,
  "final_reply": "The complete response..."
}
```

**Keep-alive:**
```json
// Relay → Plugin
{ "type": "ping" }
// Plugin → Relay
{ "type": "pong" }
```

## Session Key Mapping

Relay sends `session_key: "relay:portal:task-123"`. The plugin passes this directly into OpenClaw's session dispatch — no transformation needed. OpenClaw uses it to resume or create the correct session.

## State (In-Memory, TTL-Evicted)

Each active event is tracked in memory:

```typescript
type RelayEventContext = {
  agentId: string;       // Which agent account received this
  eventId: string;       // Current event_id (for sending tokens/reply)
  sessionKey: string;    // relay:{app_id}:{thread_id}
  payload: unknown;      // Original payload (injected as context)
  tokensUsed: number;    // Accumulated from llm_output hook
  createdAt: number;     // For TTL eviction
};
```

Sessions expire per `ttl_days` config (per-agent). Cleanup runs every hour.

## Hooks

| Hook | Purpose |
|---|---|
| `before_prompt_build` | Inject Relay payload as structured context into agent prompt |
| `llm_output` | Accumulate `tokens_used` from usage data |
| `agent_end` | Send final `{ type: "reply" }` to Relay; clean up state |

## Tech Stack

| Layer | Stack |
|---|---|
| Language | TypeScript (ES module, loaded via jiti — no build step) |
| Runtime | Node.js 22+ (OpenClaw requirement) |
| WebSocket client | `ws` npm package |
| Peer dep | OpenClaw (loaded at runtime) |
| Testing | vitest |
| No build tool | jiti handles TS loading directly |

## Key Differences from What Was Originally Planned

The first version of this plan assumed a standalone npm package with tsup build, a `RelayPlugin` class extending EventEmitter, and a separate `npm install openclaw-relay-plugin` install flow. That was wrong. The correct model is:

- **No build step.** OpenClaw's jiti loader handles TypeScript directly.
- **Channel plugin, not a class.** Registers via `api.registerChannel()` exactly like `@openclaw/flow`.
- **Multi-account = multi-agent.** Each agent token is a channel "account" in OpenClaw's model.
- **Dispatch via OpenClaw runtime.** Events route through `rt.channel.reply.dispatchReplyWithBufferedBlockDispatcher()`, not directly via session keys.
- **No EventEmitter.** Observability is via OpenClaw's hook system.

## Phase Context

| Phase | What | Status |
|---|---|---|
| 1 | Relay API (Foundation) | Planning |
| 2 | **openclaw-relay-plugin** | **← Here** |
| 3 | Relay Dashboard | Pending |
| 4 | Developer Docs | Pending |
| 5 | Portal Integration | Pending |
| 6 | Flow Migration | Pending |
| 7 | Streaming Polish | Pending |

## Team

| Role | Name | Email |
|---|---|---|
| Project Owner | Katrina | katrina@shadstone.com |
| Tech Lead | Christian | christian@ckgworks.com |

---

*Status: Architecture finalized. Config simplified (token-only, URL hardcoded). Ready to build.*
*Last updated: 2026-04-07 — v2: single-agent, hardcoded URL, Relay (@ckgworks) branding*
