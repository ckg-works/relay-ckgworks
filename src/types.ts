// ── Relay WebSocket Protocol Messages ────────────────────────────────────────

/** Relay → Agent: incoming event from an app */
export type RelayEventMessage = {
  type: "event"
  event_id: string
  app_id: string
  thread_id: string
  session_key: string // relay:{app_id}:{thread_id}
  payload: unknown
}

/** Agent → Relay: streaming token */
export type RelayTokenMessage = {
  type: "token"
  event_id: string
  token: string
}

/** Agent → Relay: final reply */
export type RelayReplyMessage = {
  type: "reply"
  event_id: string
  content: string
  metadata: {
    tokens_used?: number
    model?: string
    latency_ms?: number
  }
}

/** Agent → Relay: error */
export type RelayErrorMessage = {
  type: "error"
  event_id: string
  error: string
  code: string // AGENT_ERROR, AGENT_TIMEOUT, etc.
}

/** Relay → Agent: heartbeat */
export type RelayPing = { type: "ping" }

/** Agent → Relay: heartbeat response */
export type RelayPong = { type: "pong" }

export type RelayInboundMessage = RelayEventMessage | RelayPing
export type RelayOutboundMessage = RelayTokenMessage | RelayReplyMessage | RelayErrorMessage | RelayPong

// ── Plugin Config ────────────────────────────────────────────────────────────

export type RelayPluginConfig = {
  token: string // rla_ agent token
  wsUrl: string // wss://api.relay.ckgworks.com/v1/ws/agent
}

// ── Event Context (in-memory state) ──────────────────────────────────────────

export type RelayEventContext = {
  eventId: string
  sessionKey: string
  appId: string
  threadId: string
  payload: unknown
  tokensUsed: number
  createdAt: number
}
