# move/ — on-chain package

The Sui Move package that makes the agent **non-custodial and verifiable**. It is the
choke-point every fund movement passes through; the off-chain `agent/` only proposes.

## Layout

```
sources/
  core/         capability.move (Treasury + caps + release_for_action), decision.move (enclave-verified entry)
  attestation/  enclave.move (Nautilus/Oyster registry), seal_policy.move (Seal gate)
  adapters/     mock_supply, suilend_adapter, scallop_adapter, navi_adapter
vendor/         build-time interface stubs for the real protocols (never published) — see vendor/README.md
```

(Subdirectories under `sources/` are purely organizational — Sui compiles every `.move`
in the tree and module names are path-independent.)

## Modules

- `capability.move` — the non-custodial core: shared `Treasury<phantom T>`, typed
  revocable `OwnerCap<T>` / `AgentCap<T>`, per-tx + rolling caps, expiry, and **receipt
  custody** (the protocol position is held as a dynamic object field of the `Treasury`,
  so the agent can deposit but only the `OwnerCap` holder can withdraw). `release_for_action`
  is `public(package)` — no external PTB can pull a raw `Coin` out.
- `decision.move` — the on-chain verifier: the 17-field `ActionIntent` schema,
  `verify`/nonce/replay (`DecisionRegistry`), and the signature-gated entrypoints
  **`verified_supply_entry`** (mock) plus the real-adapter variants
  **`verified_supply_suilend_entry<P,C>`** / **`_scallop_entry<C>`** / **`_navi_entry<C>`**
  (each carries that protocol's shared objects, e.g. Suilend's `LendingMarket`, Scallop's
  `Version`+`Market`, NAVI's `Storage`/`Pool`/`Incentive`). The `execute_verified*`
  executors are `public(package)` so a PTB can't skip the enclave signature.
- `enclave.move` — Nautilus-compatible enclave registry: PCR ↔ pubkey binding and
  `verify_signature`. The real `register_enclave` (verifies a Nitro attestation's cert chain
  to the AWS root + the PCRs, then binds the secp256k1 pubkey) is **proven live on testnet**
  with an enclave on Marlin Oyster — see [`docs/runbooks/m3-attestation.md`](../docs/runbooks/m3-attestation.md).
  (The old localnet-only `register_enclave_dev` backdoor — registering an enclave from a raw
  key with no attestation — has been **removed**; tests use the `#[test_only]`
  `new_enclave_for_testing` instead, so nothing unattested can ship.)
- `suilend_adapter.move` — the **real Suilend adapter**: supplies treasury funds and
  custodies the withdrawal-gating `ObligationOwnerCap` inside the `Treasury` (deposit-only
  agent, owner-only unwind), wired into the attested path via `decision`'s
  `verified_supply_suilend_entry`. Compiles + type-checks against Suilend's exact published
  API via the local `vendor/suilend_interface` stub (Suilend's own source is unbuildable —
  its Move.lock pins a dead Sui-framework rev; the production dep is `@suilend/core` on MVR).
  Live execution needs a Suilend market + Pyth refresh (mainnet) — see the spike doc.
- `scallop_adapter.move` — the **real Scallop adapter**: mints the fungible `MarketCoin`
  (sCoin) from treasury funds and custodies its `Balance` in the `Treasury`. Compiles vs
  Scallop's `mint`/`redeem` (`vendor/scallop_interface`, mirroring `ScallopProtocol`).
- `navi_adapter.move` — the **real NAVI adapter**: NAVI is normally address-based (would
  break non-custody), so this uses NAVI's **`AccountCap`** path — mints an account cap,
  deposits into it, and custodies the cap in the `Treasury`. Compiles vs NAVI's exact
  on-chain ABI (`vendor/navi_interface` + `vendor/navi_oracle`, @navi-protocol/lending).
- `mock_supply.move` — a placeholder adapter (releases a bounded coin, custodies a
  `MockPosition`). The unit-tested stand-in proving the custody mechanics that
  `suilend_adapter` applies to Suilend's real types.
- `seal_policy.move` — the `seal_approve` gate: releases Seal key-shares only to the attested
  enclave (the "can't-puppet" key/weights provisioning policy).

## Build / test

```bash
sui move build
sui move test          # ~29 tests
```

See [`docs/treasury-agent-design.md`](../docs/treasury-agent-design.md) for the full design
(thin-signer, receipt custody, the attestation/Seal layers), [`docs/runbooks/m3-attestation.md`](../docs/runbooks/m3-attestation.md)
for the real-attestation deploy, and the repo-root README for the reproducible demos
(testnet with real Nitro attestation, and a hardware-free localnet path).
