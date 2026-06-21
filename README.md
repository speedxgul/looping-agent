# Treasury Agent — Sui

A non-custodial agent that deploys idle stablecoins under on-chain risk bounds you can
cryptographically verify. The LLM plans and explains; a deterministic layer moves funds.

## Status

The v1 verifiable-execution stack is **built, tested, and demonstrated live on Sui testnet
with real AWS Nitro attestation** (~48 tests across Move + agent + enclave). Full design:
[`docs/treasury-agent-design.md`](docs/treasury-agent-design.md); phased build log:
[`docs/superpowers/plans/2026-06-20-implementation-roadmap.md`](docs/superpowers/plans/2026-06-20-implementation-roadmap.md);
attestation runbook: [`docs/runbooks/m3-attestation.md`](docs/runbooks/m3-attestation.md).

- **On-chain** (`move/`): non-custodial `Treasury<T>` (typed, revocable caps), the
  signature-gated `verified_supply` / `verified_supply_entry`, receipt custody, the
  `decision.move` enclave verifier + nonce/replay, and the `seal_approve` policy.
- **Enclave** (`enclave/app/`): the deterministic optimizer + `decide()` → a signed
  `ActionIntent` (the *decision* is attested), `@noble`-only for a small PCR.
- **Agent** (`agent/`): canonical `ActionIntent` codec + the `verified_supply` PTB
  builder — byte-identical BCS across `@mysten/sui` ≡ Move ≡ enclave ≡ agent.
- **Attested on real hardware:** a Nitro enclave on Marlin Oyster generates a secp256k1
  key **inside the TEE**; `register_enclave` binds its pubkey on-chain after verifying the
  cert chain to the **AWS Nitro root** + the enclave PCRs — no dev key, no trust in the operator.
- **Proven live on testnet:** enclave-signed action → on-chain signature verify → caps →
  receipt custody; over-cap aborts; a **tampered intent is rejected**; only the owner withdraws.
- **The decision itself is attested:** the agent sends only market data — the enclave runs
  the optimizer in the TEE, picks venue + amount, and signs. The agent cannot puppet it
  ([decide tx](https://suiscan.xyz/testnet/tx/CaF2Ng8DsZuxXzZsLFX1HGZY7RmrhbvQ5ssJXZvoUANH)).
- **On Sui testnet:** package [`0x79517b…b4396c`](https://suiscan.xyz/testnet/object/0x79517b947e204f8ba6377e9e1ddc26de49145d1f55643875b79e4297b1b4396c),
  attested [`Enclave<DECISION>` `0x425a87be…`](https://suiscan.xyz/testnet/object/0x425a87be07be7a8d9a4efdc58c9a72e0052b528bfabefbcb97754d166c61cef3).

**Pending external infra (not core logic):** the real Suilend adapter (upstream Move.toml
dep conflict) and live Seal (needs key servers). The localnet-only
`enclave::register_enclave_dev` should be deleted before mainnet now that real attestation works.

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

## Reproduce the live attested demo

### On Sui testnet (real Nitro attestation)

The enclave's key is generated inside a real AWS Nitro enclave on Marlin Oyster and bound
on-chain — no dev key. The full deploy → attest → register process (build+push the image,
`oyster-cvm deploy`, decode the `:1301` attestation, `register_enclave`) is in
[`docs/runbooks/m3-attestation.md`](docs/runbooks/m3-attestation.md). With a registered
enclave and the object ids recorded in `deployments/testnet.env`:

```bash
source deployments/testnet.env && cd agent
# Single endpoint: the enclave runs the optimizer in the TEE, picks the protocol + amount,
# and signs that ActionIntent. The agent only relays it; the chain verifies; a tampered
# intent (same signature, bumped amount) is rejected.
bun scripts/live-attested-decide.ts
```

### On localnet (no hardware)

End-to-end on a throwaway local network: the enclave-signed action is verified on-chain,
bounds are enforced, the receipt is custodied, and a tampered intent is rejected.

> **Localnet only.** This uses `enclave::register_enclave_dev` (registers an enclave key
> with **no attestation / no PCR binding**) — it must be removed before testnet/mainnet,
> where a real Nitro attestation registers the key instead (see the testnet path above).

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
