# move/ — on-chain package

The Sui Move package that makes the agent **non-custodial and verifiable**. It is the
choke-point every fund movement passes through; the off-chain `agent/` only proposes.

## Modules (`sources/`)

- `capability.move` — the non-custodial core: shared `Treasury<phantom T>`, typed
  revocable `OwnerCap<T>` / `AgentCap<T>`, per-tx + rolling caps, expiry, and **receipt
  custody** (the protocol position is held as a dynamic object field of the `Treasury`,
  so the agent can deposit but only the `OwnerCap` holder can withdraw). `release_for_action`
  is `public(package)` — no external PTB can pull a raw `Coin` out.
- `decision.move` — the on-chain verifier: the 17-field `ActionIntent` schema,
  `verify`/nonce/replay (`DecisionRegistry`), and **`verified_supply` / `verified_supply_entry`**
  — the signature-gated entrypoint. `execute_verified` is `public(package)` so a PTB can't
  skip the enclave signature. (This is the on-chain counterpart of `agent/src/core/policy.ts`.)
- `enclave.move` — Nautilus-compatible enclave registry: PCR ↔ pubkey binding,
  `verify_signature`, and the **localnet-only `register_enclave_dev`** (no attestation —
  remove before mainnet).
- `mock_supply.move` — a placeholder protocol adapter (releases a bounded coin and custodies
  a `MockPosition` receipt). Stands in for the real Suilend adapter (deferred — see the design doc).
- `seal_policy.move` — the `seal_approve` gate: releases Seal key-shares only to the attested
  enclave (the "can't-puppet" key/weights provisioning policy).

## Build / test

```bash
sui move build
sui move test          # ~29 tests
```

See [`docs/treasury-agent-design.md`](../docs/treasury-agent-design.md) for the full design
(thin-signer, receipt custody, the attestation/Seal layers) and the repo-root README for the
reproducible live localnet demo.
