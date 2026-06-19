# move/ — on-chain package

The Sui Move package that makes the agent **non-custodial and verifiable**. It is the
choke-point every fund movement passes through; the off-chain `agent/` only proposes.

## Planned modules (`sources/`)

- `capability.move` — the scoped, revocable capability object (per-tx + rolling caps,
  allowlist, expiry, can't-touch-principal, can't-send-to-arbitrary-address). The
  non-custodial core; "table stakes" but required.
- `verifier.move` — re-derives that a proposed allocation is **within bounds**
  (allowlist + caps + health). This is the on-chain port of the off-chain reference spec
  in [`agent/src/core/policy.ts`](../agent/src/core/policy.ts) — keep the two in lockstep.
- `attestation.move` — (TEE phase) register the enclave PCR + verify the enclave
  signature on each decision before acting.
- `receipt.move` — per-action on-chain receipt events (the real proof, not a tweet).

## Build / test

```bash
sui move build
sui move test
```

See [`docs/defi-agent-sui.md`](../docs/defi-agent-sui.md) for the verifiability/attestation
design and [`docs/strategy-research.md`](../docs/strategy-research.md) for the strategy the
verifier bounds.
