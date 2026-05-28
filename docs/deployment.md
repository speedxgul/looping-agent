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

Keep `DRY_RUN=true` until you have verified several runs.

Optional Fluid position creation:

```bash
ENABLE_FLUID_POSITION_CREATION=true
DRY_RUN=false
ACCOUNT_MODE=smart
BASE_RPC_URL=https://...
AGENT_PRIVATE_KEY=0x...
SMART_ACCOUNT_BUNDLER_URL=https://...
FLUID_ALLOWED_FTOKENS=0x...
```

Keep `FLUID_ALLOWED_FTOKENS` narrow. The agent will only deposit into allowlisted Fluid markets.

With `ACCOUNT_MODE=smart`, `AGENT_PRIVATE_KEY` is the smart account owner key. Set `AGENT_WALLET_ADDRESS` to the derived smart account address from `bun run account:address`.

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
- Logs are JSON lines and can be shipped to your deployment platform's log viewer.
