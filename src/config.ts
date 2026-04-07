import type { RelayPluginConfig } from "./types.js"

const DEFAULT_WS_URL = "wss://api.relay.ckgworks.com/v1/ws/agent"

export const resolveRelayConfig = (cfg: any): RelayPluginConfig => {
  const relayCfg = cfg?.channels?.relay ?? {}

  const token = relayCfg.token ?? process.env.RELAY_TOKEN ?? ""
  const wsUrl = relayCfg.ws_url ?? process.env.RELAY_WS_URL ?? DEFAULT_WS_URL

  return { token, wsUrl }
}
