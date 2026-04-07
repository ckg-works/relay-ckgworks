/**
 * OpenClaw hooks for the Relay plugin.
 *
 * - before_prompt_build: Inject Relay event payload as context
 * - llm_output: Accumulate token usage
 * - agent_end: Send final reply to Relay, clean up state
 */

import { isRelaySessionKey } from "./session-keys.js"
import type { RelayPluginState } from "./state.js"
import type { RelayWebSocket } from "./relay-ws.js"

type HookEvent = { prompt: string; messages: unknown[] }
type HookCtx = { sessionKey?: string }
type HookResult = { prependContext?: string } | undefined
type LlmOutputEvent = { usage?: { output_tokens?: number; total_tokens?: number } }
type AgentEndEvent = { messages: unknown[]; success: boolean; error?: string }

// ── before_prompt_build ──────────────────────────────────────────────────────

export const createBeforePromptBuildHook = (state: RelayPluginState) => {
  return (_event: HookEvent, ctx: HookCtx): HookResult => {
    const { sessionKey } = ctx
    if (!sessionKey || !isRelaySessionKey(sessionKey)) return undefined

    const evtCtx = state.getBySession(sessionKey)
    if (!evtCtx) return undefined

    const lines: string[] = []
    lines.push("## Relay Event Context")
    lines.push(`**App:** ${evtCtx.appId}`)
    lines.push(`**Thread:** ${evtCtx.threadId}`)
    lines.push(`**Event ID:** ${evtCtx.eventId}`)
    lines.push("")
    lines.push("### Payload")
    lines.push("```json")
    lines.push(JSON.stringify(evtCtx.payload, null, 2))
    lines.push("```")
    lines.push("")
    lines.push("Respond to this event. Your response will be streamed back to the app in real-time.")

    return { prependContext: lines.join("\n") }
  }
}

// ── llm_output ───────────────────────────────────────────────────────────────

export const createLlmOutputHook = (state: RelayPluginState) => {
  return (event: LlmOutputEvent, ctx: HookCtx): void => {
    const { sessionKey } = ctx
    if (!sessionKey || !isRelaySessionKey(sessionKey)) return

    const evtCtx = state.getBySession(sessionKey)
    if (!evtCtx) return

    const tokens = event.usage?.output_tokens ?? event.usage?.total_tokens ?? 0
    if (tokens > 0) {
      evtCtx.tokensUsed += tokens
    }
  }
}

// ── agent_end ────────────────────────────────────────────────────────────────

export const createAgentEndHook = (state: RelayPluginState, ws: RelayWebSocket) => {
  return async (event: AgentEndEvent, ctx: HookCtx): Promise<void> => {
    const { sessionKey } = ctx
    if (!sessionKey || !isRelaySessionKey(sessionKey)) return

    const evtCtx = state.getBySession(sessionKey)
    if (!evtCtx) return

    try {
      if (event.success) {
        const content = extractLastAssistantContent(event.messages)
        ws.send({
          type: "reply",
          event_id: evtCtx.eventId,
          content: content ?? "Agent completed without output.",
          metadata: { tokens_used: evtCtx.tokensUsed },
        })
      } else {
        ws.send({
          type: "error",
          event_id: evtCtx.eventId,
          error: event.error ?? "Agent turn failed",
          code: "AGENT_ERROR",
        })
      }
    } catch {
      // Swallow errors to avoid crashing agent lifecycle
    }

    state.remove(evtCtx)
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

type ContentBlock = { type: string; text?: string }
type Message = { role?: string; content?: unknown }

const extractLastAssistantContent = (messages: unknown[]): string | null => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as Message
    if (msg.role !== "assistant") continue

    const { content } = msg
    if (typeof content === "string") return content || null

    if (Array.isArray(content)) {
      const texts = (content as ContentBlock[])
        .filter((b) => b.type === "text" && typeof b.text === "string")
        .map((b) => b.text as string)
      return texts.length > 0 ? texts.join("\n") : null
    }
  }
  return null
}
