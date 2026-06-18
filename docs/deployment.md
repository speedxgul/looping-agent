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
SUI_NETWORK=testnet
```

Keep `DRY_RUN=true` until you have verified several runs on testnet.

Optional Suilend position creation:

```bash
SUI_ENABLED=true
ENABLE_SUI_POSITION_CREATION=true
DRY_RUN=false
SUI_RPC_URL=https://fullnode.testnet.sui.io:443
AGENT_SUI_PRIVATE_KEY=0x...
SUI_ALLOWED_ASSETS=usdc
SUI_MAX_SUPPLY_AMOUNT_RAW=10000000
MIN_IDLE_USDC_RAW=5000000
```

Optional borrow (requires health guard awareness):

```bash
SUI_ENABLE_BORROW=true
SUI_MIN_HEALTH_FACTOR=1.25
SUI_MAX_BORROW_AMOUNT_RAW=...
```

Set `AGENT_WALLET_ADDRESS` to the Sui address derived from `AGENT_SUI_PRIVATE_KEY`:

```bash
bun run account:address
```

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

- Default to `SUI_NETWORK=testnet` until caps and health guard behavior are verified.
- Keep `SUI_ALLOWED_ASSETS` narrow — the agent only acts on explicitly allowlisted markets.
- NAVI and Scallop are read-only rate sources; execution stays on Suilend.
- Logs are JSON lines and can be shipped to your deployment platform's log viewer.

## Verification

1. `bun run doctor` — key, address, RPC, protocol flags
2. `bun test`
3. `DRY_RUN=true SUI_NETWORK=testnet bun run run:once`
4. Live testnet with tiny caps: supply → withdraw → borrow → repay
5. Health guard: borrow near limit, confirm auto-repay when HF drops
