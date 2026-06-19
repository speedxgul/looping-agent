# Treasury Agent — Sui

A non-custodial agent that deploys idle stablecoins under on-chain risk bounds you can
cryptographically verify. The LLM plans and explains; a deterministic layer moves funds.

## Layout

| Folder | What it is |
|---|---|
| [`agent/`](agent/) | Off-chain TypeScript agent (the "brain"): autonomous loop, strategy/optimizer, policy, Suilend/NAVI/Scallop clients, Walrus/MemWal memory. Self-contained Bun package (own `package.json`/`biome.json`/`tsconfig.json`). |
| [`move/`](move/) | On-chain Sui Move package (the choke-point): scoped revocable capability, on-chain bounds verifier, per-action receipts, and the enclave-attestation verifier. |
| [`docs/`](docs/) | Thesis & scope ([`defi-agent-sui.md`](docs/defi-agent-sui.md)), strategy math ([`strategy-research.md`](docs/strategy-research.md)), and venue/SDK selection. |

## Quick start

Run from the repo root — these delegate into `agent/` and `move/`:

```bash
bun run setup                        # install agent deps
cp agent/.env.example agent/.env     # set OPENAI_API_KEY and AGENT_SUI_PRIVATE_KEY
bun run doctor                       # config + key + RPC checks
bun run dev                          # one autonomous loop (run-once)

bun run typecheck && bun run check && bun run test   # agent gates
bun run move:build && bun run move:test              # on-chain package
```

(Use `bun run <script>` from root, not bare `bun test`.) See [`agent/README.md`](agent/README.md)
for full agent docs and [`move/README.md`](move/README.md) for the on-chain package.

## Future layout

`web/` (trust-console UI) and `shared/` (TS↔Move types: the bounds schema + generated ABI)
slot in as siblings when the frontend lands. `agent/` graduates to a Bun workspace member at
that point.
