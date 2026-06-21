# move/ — on-chain package

The Sui Move package that makes the agent **non-custodial and verifiable**. It is the
choke-point every fund movement will pass through; the off-chain `agent/` only proposes.

## Modules (`sources/`)

**Built + tested today:**

- `capability.move` — the scoped, revocable capability. A `Treasury<T>` holds the
  owner's funds; an `OwnerCap` authorises revocation and principal withdrawal; an
  `AgentCap` authorises **bounded** fund release only (per-tx cap, rolling-period cap,
  expiry, can't touch principal, revocable). Emits on-chain receipt events
  (`TreasuryCreated`, `FundsReleased`, `AgentRevoked`, `PrincipalWithdrawn`).
  `release_for_action` currently returns a raw `Coin<T>` into the PTB.
- `decision.move` — `execute_decision` verifies an enclave signature over a
  `DecisionPayload { treasury, amount, nonce }` and enforces a strictly-increasing,
  one-time-use nonce (replay protection) before releasing via the capability. BCS
  byte-parity with the enclave serializer is self-tested.
- `enclave.move` — registers the enclave's secp256k1 public key bound to its PCR
  measurement (AWS Nitro attestation) and verifies signatures over `IntentMessage<T>`
  against the registered key. Code-hash-pinned: swap the image → the PCR changes →
  signatures stop verifying.

**On the roadmap (not yet built):**

- `verified_supply` (inside `capability.move`) — perform the protocol deposit **and**
  sink the receipt (`ObligationOwnerCap` / `sCoin`) into the `Treasury` in one atomic
  action. This is the central non-custodial upgrade: until it lands, the host composes
  the downstream supply after the coin is released. See
  [`../docs/treasury-agent-design.md`](../docs/treasury-agent-design.md) §6.
- `verifier.move` — re-derive that a proposed allocation is **within bounds**
  (allowlist + caps + health) on-chain. The on-chain port of the off-chain reference
  spec in [`../agent/src/core/policy.ts`](../agent/src/core/policy.ts) — keep the two
  in lockstep.
- `receipt.move` — a dedicated per-action receipt module (events currently live in
  `capability`/`decision`).

## Build / test

```bash
sui move build
sui move test
```

`decision.move` and `enclave.move` pass their Move tests (real-signature verify,
replay/stale-nonce aborts); `capability.move` tests cover release within cap, over
per-tx cap, over rolling cap, after revoke, and owner principal withdrawal.

See [`../docs/treasury-agent-design.md`](../docs/treasury-agent-design.md) for the full
verifiability/attestation design, [`../docs/subagent-pipeline.md`](../docs/subagent-pipeline.md)
for the off-chain strategy engine, and [`../docs/strategy-research.md`](../docs/strategy-research.md)
for the strategy the verifier bounds.
