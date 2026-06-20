# Treasury Agent — Sui

A non-custodial agent that deploys idle stablecoins under on-chain risk bounds you can
cryptographically verify. The LLM plans and explains; a deterministic layer moves funds.

## Status

The v1 verifiable-execution stack is **built, tested, and demonstrated live on localnet**
(~48 tests across Move + agent + enclave). Full design: [`docs/treasury-agent-design.md`](docs/treasury-agent-design.md);
phased build log: [`docs/superpowers/plans/2026-06-20-implementation-roadmap.md`](docs/superpowers/plans/2026-06-20-implementation-roadmap.md).

- **On-chain** (`move/`): non-custodial `Treasury<T>` (typed, revocable caps), the
  signature-gated `verified_supply` / `verified_supply_entry`, receipt custody, the
  `decision.move` enclave verifier + nonce/replay, and the `seal_approve` policy.
- **Enclave** (`enclave/app/`): the deterministic optimizer + `decide()` → a signed
  `ActionIntent` (the *decision* is attested), `@noble`-only for a small PCR.
- **Agent** (`agent/`): canonical `ActionIntent` codec + the `verified_supply` PTB
  builder — byte-identical BCS across `@mysten/sui` ≡ Move ≡ enclave ≡ agent.
- **Proven live:** enclave-signed action → on-chain verify → caps → custody; over-cap
  aborts; a **tampered intent is rejected**; only the owner can withdraw.
- **Deployed on Sui testnet:** package [`0x79517b…b4396c`](https://suiscan.xyz/testnet/object/0x79517b947e204f8ba6377e9e1ddc26de49145d1f55643875b79e4297b1b4396c)
  — the full attested `verified_supply` flow runs on a public chain.

**Pending external infra (not core logic):** the real Suilend adapter (upstream
Move.toml dep conflict), live Seal (needs key servers), and real Nitro attestation
(replaces the localnet-only `enclave::register_enclave_dev`).

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

## Reproduce the live attested demo (localnet)

End-to-end on a throwaway local network: the enclave-signed action is verified on-chain,
bounds are enforced, the receipt is custodied, and a tampered intent is rejected.

> **Localnet only.** This uses `enclave::register_enclave_dev` (registers an enclave key
> with **no attestation / no PCR binding**) — it must be removed before testnet/mainnet,
> where a real Nitro attestation registers the key instead.

```bash
# 1. Start a localnet with a faucet (leave running in its own terminal)
RUST_LOG="off,sui_node=info" sui start --with-faucet --force-regenesis

# 2. Point the client at it and fund your address
sui client new-env --alias localnet --rpc http://127.0.0.1:9000
sui client switch --env localnet
sui client faucet --url http://127.0.0.1:9123/gas

# 3. Publish (ephemeral; records ids in Pub.localnet.toml)
cd move && sui client test-publish --build-env localnet --gas-budget 300000000
#   -> note the published PACKAGE id and the created decision::DecisionRegistry id

# 4. Register the dev "enclave" with the canonical demo key (LOCALNET ONLY)
sui client call --package <PKG> --module enclave --function register_enclave_dev \
  --type-args <PKG>::decision::DECISION \
  --args 0x034f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa \
  --gas-budget 100000000        #   -> note the created enclave::Enclave id

# 5. Create a funded vault (delegate the AgentCap to your own address for the demo)
sui client call --package <PKG> --module capability --function create --type-args 0x2::sui::SUI \
  --args <A_COIN_ID> 100000000000 150000000000 86400000 9999999999999 <YOUR_ADDRESS> 0x6 \
  --gas <ANOTHER_COIN_ID> --gas-budget 100000000   #   -> note Treasury + AgentCap ids

# 6. Sign an ActionIntent (agent code) and submit verified_supply_entry, then a tamper test
cd ../agent
PKG=<PKG> REGISTRY=<REGISTRY> ENCLAVE=<ENCLAVE> TREASURY=<TREASURY> \
AGENTCAP=<AGENTCAP> ADDR=<YOUR_ADDRESS> \
  bun scripts/live-verified-supply.ts
```

Expected: `[1]` a `FundsReleased` event and the treasury balance drops (funds → custodied
`MockPosition` held *by the Treasury*); `[2]` the tampered intent (same signature, changed
amount) is **rejected on-chain** (signature verification fails). Stop the localnet with
`pkill -f "sui start"` and restore your env with `sui client switch --env testnet`.

## Future layout

`web/` (trust-console UI) and `shared/` (TS↔Move types: the bounds schema + generated ABI)
slot in as siblings when the frontend lands. `agent/` graduates to a Bun workspace member at
that point.
