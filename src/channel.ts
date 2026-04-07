/**
 * Relay channel plugin — the ChannelPlugin object registered with OpenClaw.
 *
 * One WebSocket connection per agent. Events from Relay are dispatched
 * into OpenClaw sessions. Agent responses stream back as tokens + final reply.
 */

import type { RelayPluginConfig } from "./types.js"
import type { RelayPluginState } from "./state.js"
import type { RelayWebSocket } from "./relay-ws.js"
import { isRelaySessionKey } from "./session-keys.js"
import { getRelayRuntime } from "./runtime.js"

const waitUntilAbort = (signal: AbortSignal, cleanup?: () => void): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) {
      cleanup?.()
      resolve()
      return
    }
    signal.addEventListener("abort", () => {
      cleanup?.()
      resolve()
    }, { once: true })
  })

export const createRelayPlugin = (
  config: RelayPluginConfig,
  state: RelayPluginState,
  ws: RelayWebSocket,
) => ({
  id: "relay",

  meta: {
    id: "relay",
    label: "Relay",
    selectionLabel: "Relay (CKG Works) — AI messaging bridge for your apps.",
    blurb: "Connect apps to AI agents via Relay's WebSocket bridge.",
    order: 40,
  },

  capabilities: {
    chatTypes: ["direct"],
    media: false,
    threads: false,
    reactions: false,
    polls: false,
    edit: false,
    quoting: false,
  },

  reload: { configPrefixes: ["channels.relay"] },

  config: {
    listAccountIds: () => ["relay"],
    resolveAccount: () => ({
      accountId: "relay",
      enabled: Boolean(config.token),
      wsUrl: config.wsUrl,
    }),
    defaultAccountId: () => "relay",
  },

  setup: {
    applyAccountConfig: ({ cfg, input }: { cfg: any; accountId: string; input: any }) => {
      const token = input.token ?? ""

      cfg.channels = cfg.channels ?? {}
      cfg.channels.relay = {
        ...cfg.channels.relay,
        token: token || cfg.channels.relay?.token,
      }

      return cfg
    },
    validateInput: ({ input }: { cfg: any; accountId: string; input: any }) => {
      const token = input.token ?? ""
      if (token && !token.startsWith("rla_")) {
        return "Token must start with rla_"
      }
      return null
    },
  },

  onboarding: {
    channel: "relay",
    getStatus: async ({ cfg }: any) => {
      const relayCfg = cfg?.channels?.relay
      const configured = Boolean(relayCfg?.token)
      return {
        channel: "relay",
        configured,
        statusLines: configured
          ? ["Connected to Relay"]
          : ["Not configured — run setup to connect your agent to Relay"],
        selectionHint: "Connect your AI agent to apps via Relay",
      }
    },
    configure: async ({ cfg }: any) => ({ cfg }),
    configureInteractive: async ({ cfg, prompter }: any) => {
      const token = await prompter.text({
        message: "Enter your Relay agent token (rla_...)",
        validate: (v: string) => v.startsWith("rla_") ? null : "Token must start with rla_",
      })

      cfg.channels = cfg.channels ?? {}
      cfg.channels.relay = { token }

      return { cfg, accountId: "relay" }
    },
  },

  outbound: (() => {
    return {
      deliveryMode: "gateway",
      textChunkLimit: 4000,
      sendText: async ({ to, text }: { to: string; text: string }) => {
        // Streaming: send each text chunk as a token to Relay
        const evtCtx = state.getBySession(to)
        if (!evtCtx) return

        ws.send({
          type: "token",
          event_id: evtCtx.eventId,
          token: text,
        })
      },
      sendMedia: async ({ to, text, mediaUrl }: { to: string; text: string; mediaUrl: string }) => {
        const evtCtx = state.getBySession(to)
        if (!evtCtx) return

        ws.send({
          type: "token",
          event_id: evtCtx.eventId,
          token: `${text}\n${mediaUrl}`,
        })
      },
    }
  })(),

  gateway: {
    startAccount: async (ctx: any) => {
      if (!config.token) {
        ctx.log?.warn?.("[relay] Missing token — gateway not starting")
        return
      }

      // Set up the event handler: when Relay sends an event, dispatch into OpenClaw
      const handleEvent = async (event: any) => {
        const { event_id, app_id, thread_id, session_key, payload } = event

        // Store event context for hooks
        state.setEvent({
          eventId: event_id,
          sessionKey: session_key,
          appId: app_id,
          threadId: thread_id,
          payload,
          tokensUsed: 0,
          createdAt: Date.now(),
        })

        // Dispatch into OpenClaw session
        const rt = getRelayRuntime()
        const currentCfg = await rt.config.loadConfig()

        const message = typeof payload === "object" && payload !== null && "message" in (payload as any)
          ? (payload as any).message
          : JSON.stringify(payload)

        const msgCtx = rt.channel.reply.finalizeInboundContext({
          Body: message,
          RawBody: message,
          CommandBody: message,
          From: `relay:${session_key}`,
          To: `relay:${session_key}`,
          SessionKey: session_key,
          AccountId: "relay",
          OriginatingChannel: "relay",
          OriginatingTo: `relay:${session_key}`,
          ChatType: "direct",
          Provider: "relay",
          Surface: "relay",
          Timestamp: Date.now(),
          CommandAuthorized: true,
        })

        await rt.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
          ctx: msgCtx,
          cfg: currentCfg,
          dispatcherOptions: {
            deliver: async (deliverPayload: { text?: string; body?: string }) => {
              const text = deliverPayload?.text ?? deliverPayload?.body
              if (!text) return

              const evtCtx = state.getBySession(session_key)
              if (!evtCtx) return

              ws.send({
                type: "token",
                event_id: evtCtx.eventId,
                token: text,
              })
            },
          },
        })
      }

      // Connect WebSocket (relay-ws handles reconnection)
      // Replace the onEvent callback
      ;(ws as any).onEvent = handleEvent
      ws.connect()

      state.startCleanup()

      ctx.log?.info?.("[relay] Gateway started — connected to Relay")

      return waitUntilAbort(ctx.abortSignal, () => {
        ws.close()
        state.stopCleanup()
        ctx.log?.info?.("[relay] Gateway stopped")
      })
    },
  },

  directory: {
    self: async () => null,
    listPeers: async () => [],
    listGroups: async () => [],
  },
})
