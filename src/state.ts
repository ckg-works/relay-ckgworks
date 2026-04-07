import type { RelayEventContext } from "./types.js"

const TTL_MS = 24 * 60 * 60 * 1000 // 24 hours
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000 // 1 hour

export class RelayPluginState {
  readonly events = new Map<string, RelayEventContext>()
  private cleanupTimer: ReturnType<typeof setInterval> | null = null

  /** Store event context by session key (for hooks) and by event ID (for replies). */
  setEvent(ctx: RelayEventContext): void {
    this.events.set(ctx.sessionKey, ctx)
    this.events.set(ctx.eventId, ctx)
  }

  getBySession(sessionKey: string): RelayEventContext | undefined {
    return this.events.get(sessionKey)
  }

  getByEventId(eventId: string): RelayEventContext | undefined {
    return this.events.get(eventId)
  }

  remove(ctx: RelayEventContext): void {
    this.events.delete(ctx.sessionKey)
    this.events.delete(ctx.eventId)
  }

  evictExpired(): void {
    const now = Date.now()
    for (const [key, ctx] of this.events) {
      if (now - ctx.createdAt > TTL_MS) this.events.delete(key)
    }
  }

  startCleanup(): void {
    this.cleanupTimer = setInterval(() => this.evictExpired(), CLEANUP_INTERVAL_MS)
  }

  stopCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = null
    }
  }
}
