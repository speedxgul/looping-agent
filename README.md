# Treasury Agent — Sui

A non-custodial agent that deploys idle stablecoins under on-chain risk bounds you can
cryptographically verify. The LLM plans and explains; a deterministic layer moves funds.

## Layout

| Folder | What it is |
|---|---|
| [`agent/`](agent/) | Off-chain TypeScript agent (the "brain"): an LLM tool-calling loop **and** a six-subagent yield-looping pipeline, the own-impact-aware optimizer, policy, health guard, Suilend/NAVI/Scallop read+write clients, Walrus/MemWal memory. Self-contained Bun package. |
| [`move/`](move/) | On-chain Sui Move package (the choke-point). Built + tested: scoped revocable capability (`capability.move`), enclave-signature verifier (`decision.move`), PCR-pinned attestation (`enclave.move`). Roadmap: receipt-custody `verified_supply` and on-chain bounds `verifier`. |
| [`enclave/`](enclave/) | TEE app (AWS Nitro / Marlin Oyster) for the attested strategy + signer — roadmap M3–M4. |
| [`docs/`](docs/) | [`architecture.md`](docs/architecture.md) (what's built), [`strategies.md`](docs/strategies.md) (strategies + math), [`subagent-pipeline.md`](docs/subagent-pipeline.md) (the loop pipeline), [`autonomy.md`](docs/autonomy.md), [`treasury-agent-design.md`](docs/treasury-agent-design.md) (TEE-verified custody design), [`deployment.md`](docs/deployment.md). |

## Quick start

Run from the repo root — these delegate into `agent/` and `move/`:

```bash
bun run setup                        # install agent deps
cp agent/.env.example agent/.env     # set OPENAI_API_KEY and AGENT_SUI_PRIVATE_KEY
bun run doctor                       # config + key + RPC checks
bun run dev                          # one autonomous main-agent loop (run-once)

cd agent && bun run run:supervisor   # main agent + six-subagent loop pipeline

bun run typecheck && bun run check && bun run test   # agent gates
bun run move:build && bun run move:test              # on-chain package
```

**Two decision engines, one enforcement layer.** A flexible LLM tool-calling agent and
a deterministic six-subagent pipeline (rate-scout · position-risk · loop-strategist ·
coordinator · executor · unwind-guard) both move funds only through the same policy,
caps, allowlists, and health-factor gates. The pipeline runs **single-depth USDC→SUI
yield loops** with no LLM in the fund-moving path. See
[`docs/subagent-pipeline.md`](docs/subagent-pipeline.md).

(Use `bun run <script>` from root, not bare `bun test`.) See [`agent/README.md`](agent/README.md)
for full agent docs and [`move/README.md`](move/README.md) for the on-chain package.

## Future layout

`web/` (trust-console UI) and `shared/` (TS↔Move types: the bounds schema + generated ABI)
slot in as siblings when the frontend lands. `agent/` graduates to a Bun workspace member at
that point.
