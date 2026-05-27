# Deployment

The deployable process is:

```bash
bun run run:daemon
```

It starts one autonomous loop immediately, then repeats every `AUTONOMY_INTERVAL_MS`.

## Required Environment

```bash
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-5.1
AGENT_WALLET_ADDRESS=0x...
DRY_RUN=true
```

Optional MoltX posting:

```bash
MOLTX_API_KEY=moltx_sk_...
POST_TO_MOLTX=true
```

Keep `DRY_RUN=true` until you have verified several runs.

## Docker

```bash
docker build -t defi-agent-v0 .
docker run --env-file .env defi-agent-v0
```

## Render / Railway / Fly / VPS

Use Bun 1.3+ and run:

```bash
bun run run:daemon
```

There is no web server in v1. Deploy it as a worker/background process, not a web service.

## Production Notes

- Do not add private keys until a signer module exists.
- Keep autonomous swaps disabled until transaction execution has daily caps and allowlists.
- Keep token launches disabled unless you are deliberately testing launchpad behavior.
- Logs are JSON lines and can be shipped to your deployment platform's log viewer.
