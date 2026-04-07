# @ckgworks/openclaw-relay

OpenClaw channel plugin for [Relay](https://relay.ckgworks.com) — the AI messaging bridge for CKG Works and Smiling Group apps.

This plugin makes Relay a native messaging channel for OpenClaw agents. Apps send events to Relay, Relay delivers them to your agent via this plugin, and the agent streams responses back in real-time.

## How It Works

```
App (Portal, Flow, etc.)
  → WebSocket → Relay → WebSocket → this plugin → OpenClaw agent
                                                  → token stream → Relay → App
```

## Installation

```bash
# Install from GitHub
openclaw plugins install github:ckg-works/relay-ckgworks

# Enable the plugin
openclaw plugins enable relay

# Run the setup wizard (prompts for your agent token)
openclaw channels setup relay
```

The setup wizard asks for one thing: your `rla_` agent token from the [Relay Dashboard](https://relay.ckgworks.com).

## What You Need

1. A Relay account — request access at [relay.ckgworks.com/request-access](https://relay.ckgworks.com/request-access)
2. An agent registered in the Relay Dashboard (gives you an `rla_` token)
3. OpenClaw installed on your machine

## Configuration

After running `openclaw channels setup relay`, your config will contain:

```json
{
  "channels": {
    "relay": {
      "token": "rla_athena_k9p2m3_..."
    }
  }
}
```

That's it. The WebSocket URL is hardcoded to `wss://api.relay.ckgworks.com/v1/ws/agent`.

### Environment Variable Override

You can also set the token via environment variable:

```bash
export RELAY_TOKEN=rla_athena_k9p2m3_...
```

## Features

- Persistent WebSocket connection to Relay with auto-reconnect (exponential backoff 1s → 60s)
- Heartbeat (ping/pong every 30s)
- Real-time token streaming from agent to app
- Event payload injected as agent context via `before_prompt_build` hook
- Token usage tracking via `llm_output` hook
- Final reply sent to Relay on `agent_end`

## Protocol

- **Auth:** Query param (`?token=rla_...`)
- **Inbound:** `{"type": "event", "event_id", "app_id", "thread_id", "session_key", "payload"}`
- **Outbound tokens:** `{"type": "token", "event_id", "token"}`
- **Outbound reply:** `{"type": "reply", "event_id", "content", "metadata"}`
- **Heartbeat:** `{"type": "ping"}` / `{"type": "pong"}`

Full protocol docs: [docs.relay.ckgworks.com](https://docs.relay.ckgworks.com)

## Development

```bash
# Clone
git clone git@github.com:ckg-works/relay-ckgworks.git
cd relay-ckgworks

# Install deps
npm install

# Link for local development
openclaw plugins install -l .
openclaw plugins enable relay

# Type check
npx tsc --noEmit

# Run tests
npm test
```

## License

Proprietary — CKG Works
