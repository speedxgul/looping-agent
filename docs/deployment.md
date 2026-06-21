# Deployment

There are two deployable processes:

```bash
bun run run:daemon        # main LLM agent only, one loop every AUTONOMY_INTERVAL_MS
bun run run:supervisor    # main agent + the six-subagent loop pipeline (recommended)
```

The supervisor bootstraps the subagents once in dependency order, then schedules each
role (and the main agent) on its own interval. See
[`subagent-pipeline.md`](subagent-pipeline.md).

## Required Environment

```bash
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-5.1
AGENT_WALLET_ADDRESS=0x...
DRY_RUN=true
SUI_NETWORK=testnet
```

Keep `DRY_RUN=true` until you have verified several runs on testnet.

## Lending writes (supply / withdraw / borrow / repay)

Writes work on **all three protocols** (Suilend, NAVI, Scallop). Each is gated by an
`enabled` flag (reads) and a `write` flag, plus the asset/protocol allowlists.

```bash
SUI_ENABLED=true
ENABLE_SUI_POSITION_CREATION=true
DRY_RUN=false
SUI_RPC_URL=https://fullnode.testnet.sui.io:443
AGENT_SUI_PRIVATE_KEY=0x...           # or suiprivkey1...
SUI_ALLOWED_ASSETS=usdc
SUI_ALLOWED_PROTOCOLS=suilend,navi,scallop
ENABLE_SUILEND=true
ENABLE_NAVI=true
ENABLE_SCALLOP=true
SUI_MAX_SUPPLY_AMOUNT_RAW=10000000
MIN_IDLE_USDC_RAW=5000000
```

Borrow (requires health-guard awareness):

```bash
SUI_ENABLE_BORROW=true
SUI_MIN_HEALTH_FACTOR=1.25
SUI_MAX_BORROW_AMOUNT_RAW=...
```

## Loop-strategy pipeline

Off by default. To observe and propose loops:

```bash
LOOP_STRATEGY_ENABLED=true
```

To let the pipeline (or the main agent) **execute** loops live, also set:

```bash
DRY_RUN=false
SUI_ENABLE_BORROW=true
LOOP_EXECUTION_ENABLED=true
LOOP_MAX_BORROW_USD=25
LOOP_MAX_COLLATERAL_USD=100
LOOP_MIN_HEALTH_FACTOR=1.75
LOOP_CRITICAL_HEALTH_FACTOR=1.45
```

See [`subagent-pipeline.md`](subagent-pipeline.md) §6 for the full variable table.

Set `AGENT_WALLET_ADDRESS` to the Sui address derived from `AGENT_SUI_PRIVATE_KEY`:

```bash
bun run account:address
```

## Docker

```bash
docker build -t defi-agent .
docker run --env-file .env defi-agent
```

## Render / Railway / Fly / VPS

Use Bun 1.3+ and run either `bun run run:daemon` or `bun run run:supervisor`. The agent
has no web server — deploy it as a worker/background process. (The Trust Console in `app/`
is a separate read-only web UI.)

## Production Notes

- The contracts + agent are **live on mainnet**, but start on `SUI_NETWORK=testnet` (or
  tiny mainnet caps) while you validate your own keys, caps, and risk config.
- Keep `SUI_ALLOWED_ASSETS` and `SUI_ALLOWED_PROTOCOLS` narrow — the agent only acts on
  explicitly allowlisted markets.
- The strategy ledger (`data/strategy-ledger.json`) and agent state are local JSON by
  default; set `AGENT_MEMORY_BACKEND=walrus` for verifiable, portable history.
- Logs are JSON lines and can be shipped to your platform's log viewer.

## Verification

1. `bun run doctor` — key, address, RPC, protocol flags, loop config
2. `bun test`
3. `bun run verify:allocation` — allocation solver legs + APR math
4. `DRY_RUN=true SUI_NETWORK=testnet bun run run:once` (main agent)
5. `DRY_RUN=true LOOP_STRATEGY_ENABLED=true bun run run:supervisor` — confirm the
   ledger fills with snapshots → proposal → accepted plan → planned receipt
6. Live testnet with tiny caps: supply → withdraw → borrow → repay on each protocol
7. Health guard: borrow near limit, confirm auto-repay when HF drops
8. Unwind guard: drive HF below `LOOP_CRITICAL_HEALTH_FACTOR`, confirm a risk lock
   appears and active loops flip to `unwinding`
