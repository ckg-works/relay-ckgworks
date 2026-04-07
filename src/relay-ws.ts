/**
 * Relay WebSocket Manager — persistent connection with auto-reconnect.
 *
 * Opens one WebSocket to Relay per agent. Handles:
 * - Auth via query param (?token=rla_...)
 * - Heartbeat (ping/pong)
 * - Exponential backoff reconnection (1s → 60s)
 * - Message routing to onEvent callback
 */

import WebSocket from "ws"
import type { RelayEventMessage, RelayOutboundMessage, RelayPluginConfig } from "./types.js"

const BASE_DELAY_MS = 1000
const MAX_DELAY_MS = 60000
const JITTER_MS = 500

type OnEventFn = (event: RelayEventMessage) => void

export class RelayWebSocket {
  private ws: WebSocket | null = null
  private reconnectAttempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private closed = false
  private logger: any

  public onEvent: OnEventFn

  constructor(
    public config: RelayPluginConfig,
    onEvent: OnEventFn,
    logger?: any,
  ) {
    this.onEvent = onEvent
    this.logger = logger ?? console
  }

  connect(): void {
    if (this.closed) return

    const url = `${this.config.wsUrl}?token=${this.config.token}`
    this.ws = new WebSocket(url)

    this.ws.on("open", () => {
      this.reconnectAttempt = 0
      this.logger.info?.("[relay] WebSocket connected")
    })

    this.ws.on("message", (raw: WebSocket.RawData) => {
      try {
        const data = JSON.parse(raw.toString())
        this.handleMessage(data)
      } catch {
        this.logger.warn?.("[relay] Failed to parse message")
      }
    })

    this.ws.on("close", () => {
      this.logger.info?.("[relay] WebSocket closed")
      this.scheduleReconnect()
    })

    this.ws.on("error", (err: Error) => {
      this.logger.error?.(`[relay] WebSocket error: ${err.message}`)
    })
  }

  send(message: RelayOutboundMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message))
    }
  }

  close(): void {
    this.closed = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
  }

  private handleMessage(data: any): void {
    switch (data.type) {
      case "ping":
        this.send({ type: "pong" })
        break
      case "event":
        this.onEvent(data as RelayEventMessage)
        break
      default:
        this.logger.debug?.(`[relay] Unknown message type: ${data.type}`)
    }
  }

  private scheduleReconnect(): void {
    if (this.closed) return

    const delay = Math.min(
      BASE_DELAY_MS * Math.pow(2, this.reconnectAttempt) + Math.random() * JITTER_MS,
      MAX_DELAY_MS,
    )

    this.reconnectAttempt++
    this.logger.info?.(`[relay] Reconnecting in ${Math.round(delay)}ms (attempt ${this.reconnectAttempt})`)

    this.reconnectTimer = setTimeout(() => {
      this.connect()
    }, delay)
  }
}
