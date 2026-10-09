# Parvez AI

Public AI assistant platform by Parvez Mosharaf.

- **Dashboard** (`/ai`) — Jarvis-style brain + node UI, real-time status
- **API Vault** (`/vault`) — encrypted multi-provider API key storage (server-side only)
- **Router** (`/api/chat`) — multi-provider routing with auto key failover (401/429 → next key)
- **Health checker** — background key health monitoring, red/green status
- **Telegram skill** — group messaging + countdown closer

## Deploy

```bash
wrangler deploy
```

Custom domain: `ai.parvez.website` (or your domain).

## Providers supported

OpenRouter, OpenAI, Anthropic, Google AI Studio, Groq, Mistral, DeepSeek, xAI, plus local models via tunnel.
