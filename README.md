# @openclaw/discord-voice

OpenClaw plugin for voice conversations in Discord voice channels using OpenAI Realtime API.

## Features

- 🎙️ Real-time voice conversations with AI in Discord voice channels
- 🔄 Automatic speech detection (VAD) - no push-to-talk needed
- 🎭 Multiple voice options (alloy, echo, fable, onyx, nova, shimmer)
- 🤖 Integrates with existing OpenClaw Discord bot
- ⚡ Low latency - uses OpenAI's native audio streaming

## Installation

```bash
openclaw plugins install @openclaw/discord-voice
```

Or install from local folder (development):

```bash
openclaw plugins install ./path/to/openclaw-discord-voice
cd ./path/to/openclaw-discord-voice && npm install
```

Restart the Gateway after installation.

## Configuration

Add to your OpenClaw config:

```json5
{
  plugins: {
    entries: {
      "discord-voice": {
        enabled: true,
        config: {
          // Optional: falls back to providers.openai.apiKey
          openaiApiKey: "sk-...",
          
          // Optional: model selection
          model: "gpt-4o-realtime-preview-2024-12-17",
          
          // Optional: AI voice
          voice: "alloy", // alloy, echo, fable, onyx, nova, shimmer
          
          // Optional: voice detection sensitivity (0-1)
          vadThreshold: 0.5,
          
          // Optional: custom AI personality
          systemPrompt: "You are a helpful assistant...",
          
          // Optional: auto-join when users enter voice
          autoJoin: false,
        }
      }
    }
  }
}
```

## Usage

### Slash Commands

- `/voice-join` - Bot joins your current voice channel
- `/voice-leave` - Bot leaves the voice channel
- `/voice-status` - Shows current connection status

### How it works

1. Join a Discord voice channel
2. Use `/voice-join` to invite the bot
3. Start talking - the AI will respond via voice
4. Use `/voice-leave` when done

## Requirements

- OpenClaw with Discord channel configured
- OpenAI API key with Realtime API access
- Node.js 20+
- libopus (usually pre-installed, required for @discordjs/opus)

## Development

```bash
# Install dependencies
npm install

# Build TypeScript
npm run build

# Watch mode
npm run watch
```

## Architecture

```
Discord Voice Channel
        │
        ▼
┌───────────────────┐
│  @discordjs/voice │  ← Opus audio streams
└───────────────────┘
        │
        ▼
┌───────────────────┐
│   AudioPipeline   │  ← 48kHz stereo ↔ 24kHz mono
└───────────────────┘
        │
        ▼
┌───────────────────┐
│  RealtimeBridge   │  ← WebSocket to OpenAI
└───────────────────┘
        │
        ▼
   OpenAI Realtime API
   (gpt-4o-realtime)
```

## License

MIT
