const RELAY_PREFIX = "relay:"

export const isRelaySessionKey = (key: string): boolean =>
  key.startsWith(RELAY_PREFIX)

export const parseSessionKey = (key: string): { appId: string; threadId: string } | null => {
  if (!isRelaySessionKey(key)) return null
  // Format: relay:{app_id}:{thread_id}
  const parts = key.slice(RELAY_PREFIX.length).split(":")
  if (parts.length < 2) return null
  return { appId: parts[0], threadId: parts.slice(1).join(":") }
}
