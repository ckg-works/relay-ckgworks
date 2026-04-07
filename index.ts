import { setRelayRuntime } from "./src/runtime.js"
import { resolveRelayConfig } from "./src/config.js"
import { RelayPluginState } from "./src/state.js"
import { RelayWebSocket } from "./src/relay-ws.js"
import { createRelayPlugin } from "./src/channel.js"
import { createBeforePromptBuildHook, createLlmOutputHook, createAgentEndHook } from "./src/hooks.js"

const state = new RelayPluginState()

const plugin = {
  id: "openclaw-relay",
  name: "Relay",
  description: "Relay channel plugin — connect apps to AI agents via Relay's WebSocket bridge.",

  register(api: any) {
    setRelayRuntime(api.runtime)
    const config = resolveRelayConfig(api.config)

    // Create WebSocket manager — onEvent is set later in gateway.startAccount
    const ws = new RelayWebSocket(config, () => {}, api.logger)

    // Register channel
    const relayPlugin = createRelayPlugin(config, state, ws)
    api.registerChannel({ plugin: relayPlugin })

    // Register hooks
    api.on("before_prompt_build", createBeforePromptBuildHook(state))
    api.on("llm_output", createLlmOutputHook(state))
    api.on("agent_end", createAgentEndHook(state, ws))

    api.logger.info("[relay] Plugin registered successfully")
  },
}

export default plugin
