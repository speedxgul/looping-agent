# Treasury Agent — Trust Console

A read-only web dashboard that surfaces the Sui treasury agent's state: subagent
heartbeats, market rates, positions, strategy proposals, accepted plans, execution
receipts, risk locks, Walrus archives, and main-agent memory.

It is **read-only**. It does not connect a wallet, trigger agent actions, or write any
state. It reads the agent's existing on-disk JSON files server-side.

## How it gets data

The agent writes two JSON files that this console reads:

- `../agent/data/strategy-ledger.json` — the six-subagent pipeline state.
- `../agent/data/agent-state.json` — the main-agent memory.

By default the console resolves these relative to the repo (`../agent/data`). Override
the directory with the `AGENT_DATA_DIR` environment variable (absolute path or relative
to the `app/` folder).

The dashboard polls the API routes every ~15s so it stays live while the agent runs.

## Run

```bash
cd app
bun install
bun run dev      # http://localhost:3000
```

Build / production:

```bash
bun run build
bun run start
```

## Layout

- `src/lib/ledger.ts` — typed loaders for the two data files (safe empty defaults if missing).
- `src/app/api/ledger/route.ts`, `src/app/api/memory/route.ts` — GET endpoints returning parsed JSON.
- `src/app/page.tsx` — the dashboard (client component, polls the API routes).
- `src/components/` — one component per dashboard section.
