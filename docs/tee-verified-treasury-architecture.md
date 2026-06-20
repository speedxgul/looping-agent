# TEE-Verified Treasury Architecture

## Purpose

This document describes the target architecture for turning the current Sui treasury
agent into a product that can safely manage other people's funds. The goal is not
"an agent wallet with a private key." The goal is a non-custodial treasury system
where users deposit funds into a Sui Move-controlled object, the agent computes
yield actions, and funds can only move when an on-chain verifier proves the action
is authorized, bounded, and signed by an attested TEE.

The core invariant:

```text
User funds only move through the Move policy choke-point.
```

The system should not require the user to trust the operator, host machine, LLM
prompt, raw agent key, or off-chain report. The LLM may plan and explain, but the
deterministic strategy engine, TEE signer, and Move verifier decide what can
actually execute.

## Current State

The repo already has most of the off-chain strategy pieces:

- `agent/src/core/allocation.ts` contains the own-impact-aware allocation solver.
- `agent/src/core/toolRegistry.ts` exposes lending tools and the plan-only rebalance
  tool.
- `agent/src/core/policy.ts` has the current off-chain write gates, borrow health
  checks, and rebalance breakeven math.
- The agent can read and write Suilend, NAVI, and Scallop positions using a local
  Sui signer.
- Walrus and MemWal are wired for durable state, reports, and semantic memory.

The Move package has the first piece of the non-custodial model:

- `move/sources/capability.move` defines a shared `Treasury<T>`, owner `OwnerCap`,
  agent `AgentCap`, expiry, per-transaction caps, rolling caps, revocation, and
  bounded fund release.
- `move/README.md` already names the planned `verifier.move`, `attestation.move`,
  and `receipt.move` modules.

The current direct-signer model is fine for the project owner's own test wallet,
but it is not sufficient for third-party deposits. If user funds are involved, the
agent cannot hold a raw key that can route coins directly through arbitrary PTBs.
The Move contract must be the final authority over every fund movement.

## Target Architecture

At a high level:

```text
User
  deposits USDC
  keeps OwnerCap
  can revoke
    |
    v
Treasury<USDC> Move object
  enforces caps, expiry, allowlists, nonces, risk bounds
  only executes verified action templates
    ^
    |
TEE-signed ActionIntent
  produced by deterministic strategy engine
  key registered through enclave attestation
    ^
    |
Off-chain agent host
  untrusted transport
  reads chain/protocol data
  asks LLM for summaries/plans
  submits PTBs
```

The user deposits funds into `Treasury<USDC>`. The user receives and keeps
`OwnerCap`, which can revoke the agent and withdraw principal. The agent receives
only a scoped `AgentCap`, and that cap alone should not be enough to release funds
to arbitrary destinations.

The TEE runs the deterministic strategy validator and signer. It produces a signed
canonical `ActionIntent`, such as "supply 4 USDC from treasury X into NAVI USDC
market under policy hash Y and input hash Z." The Move verifier checks the TEE
signature, nonce, caps, expiry, allowlists, and risk constraints before routing
funds through an approved action template.

Every successful action emits an on-chain receipt event. Walrus stores the longer
run report and state snapshot, but the on-chain receipt is the execution proof.

## Trust Boundaries

### LLM

The LLM is advisory. It may summarize market state, propose a strategy, explain a
blocked action, or decide which tool to call next. It must not hold keys, produce
the final signature, or bypass deterministic validation.

### Deterministic Strategy Engine

This is the real decision layer. It takes authenticated inputs, computes an
allocation/rebalance/health action, checks local policy, and emits a typed
`ActionIntent`. It should be deterministic for the same input bundle.

Relevant current code:

- `agent/src/core/allocation.ts`
- `agent/src/core/policy.ts`
- `agent/src/core/toolRegistry.ts`

### TEE

The TEE protects strategy secrets, private signing keys, and any encrypted memory
material decrypted through Seal/Walrus. The enclave signs only canonical intents
that pass deterministic policy validation.

The TEE is not the only safety layer. A valid enclave signature should mean:

```text
This action came from the registered enclave code.
```

It should not mean:

```text
Move no longer needs to check caps, allowlists, health, or replay protection.
```

Move remains the final enforcement layer.

### Move Contract

The Move package is the non-custodial choke-point. It holds funds, validates
authority, enforces caps, verifies registered enclave signatures, executes approved
templates, and emits receipts.

Move should assume the host, LLM, and submitted PTB are adversarial.

### Host Machine

The host process is untrusted transport. It can fetch data, call the LLM, relay
requests into the enclave, and submit signed PTBs. It must not be able to forge
valid intents or extract keys.

### Walrus and Seal

Walrus stores reports, memory, and optionally encrypted strategy configuration.
Seal can gate access so only the enclave can decrypt sensitive blobs. Walrus is
the audit and memory layer, not the authority over funds.

## User and Agent Lifecycle

### 1. User Onboarding

The user creates a treasury:

```text
create<T>(
  funds,
  per_tx_cap,
  period_cap,
  period_ms,
  expiry_ms,
  agent_address,
  clock
)
```

Expected result:

- shared `Treasury<USDC>`
- `OwnerCap` transferred to user
- `AgentCap` transferred to the agent/enclave-controlled address

The v1 product should start with USDC-only treasuries. Borrowing and looping should
stay disabled for user funds until on-chain health/risk verification exists.

### 2. Enclave Registration

The enclave boots from a reproducible image, generates an internal signing key,
and produces an attestation that binds the public key to the image measurement.

Registration stores:

- enclave public key
- image measurement or PCR hash
- status: active/revoked
- optional metadata: version, build id, policy schema version

There are two practical implementation levels:

1. **v1 registry:** verify attestation off-chain during deployment, then register
   the enclave public key and expected image hash on-chain. This is simpler and
   enough to prove the end-to-end product flow.
2. **hardened registry:** verify the full attestation document/certificate chain
   on-chain or through a canonical Sui verifier module. This is stronger but more
   expensive and more complex.

The design should allow v1 to upgrade into the hardened model without changing the
action intent schema.

### 3. Agent Cycle

Each cycle:

1. Read treasury policy and current agent memory.
2. Read protocol markets, positions, balances, and health factors.
3. Verify or authenticate price inputs.
4. Compute target allocation or rebalance plan.
5. Build canonical `ActionIntent`.
6. Send the intent and input bundle to the enclave.
7. Enclave validates and signs.
8. Host submits a PTB to the Move verifier.
9. Move verifies and executes.
10. Receipt event is emitted.
11. Walrus report is stored.

### 4. Revocation

The owner can call `revoke` at any time. After revocation:

- `AgentCap` no longer authorizes actions.
- Any future signed action should fail on-chain.
- The owner can withdraw principal.

Revocation must be part of the demo path because it is the clearest proof that the
system is non-custodial.

## Canonical ActionIntent

The intent is the signed payload emitted by the enclave. It should be typed, stable,
and canonicalized before signing. Avoid signing ad hoc JSON unless the exact
canonical encoding is defined and tested.

Recommended v1 fields:

```text
ActionIntent {
  schema_version: u16,
  chain_id: vector<u8>,
  treasury_id: ID,
  agent_cap_id: ID,
  nonce: u64,
  expires_at_ms: u64,
  action_kind: u8,
  protocol_id: u8,
  asset_type: vector<u8>,
  amount: u64,
  min_health_factor_bps: u64,
  max_protocol_exposure: u64,
  policy_hash: vector<u8>,
  input_hash: vector<u8>,
  rationale_hash: vector<u8>,
}
```

For v1, `action_kind` should be limited to:

- supply USDC
- withdraw USDC back to treasury/owner
- emergency unwind to idle

Borrow and looping intents should be added only after the on-chain verifier can
validate health-factor and liquidation-risk constraints.

## Input Bundle and Hashing

The enclave should sign a hash of the inputs it used. This prevents ambiguous
"the agent said it saw X" reports.

Recommended input bundle:

- treasury policy
- current treasury balance
- protocol rates and reserve data
- current positions
- Pyth price update identifiers or verified price payloads
- wallet/treasury object ids
- allocation solver output
- risk flags: depeg status, health status, protocol disabled status

The host can still lie about inputs unless they are authenticated. For demo v1,
hashing the input bundle is useful for auditability. For production, price feeds
and core protocol state used for risk decisions should be verified inside the
enclave or re-derived by Move where practical.

## Move Contract Design

### capability.move

`capability.move` should remain the treasury object and owner/agent authority
module, but `release_for_action` is too permissive for third-party funds if used
directly. Returning a raw `Coin<T>` lets a PTB route the coin anywhere after release.

The safer design is:

```text
verified_supply_to_protocol(...)
  verifies cap
  verifies signed ActionIntent
  checks bounds
  splits treasury funds
  calls approved protocol adapter/template
  emits receipt
```

If generic release remains for internal composition, it should not be exposed as
the main third-party fund movement endpoint.

### verifier.move

Responsible for:

- verifying action fields match treasury and cap
- enforcing nonce/replay protection
- enforcing expiry
- enforcing per-tx and rolling caps
- enforcing asset/protocol allowlists
- enforcing strategy-specific constraints
- checking policy hash and schema version

### enclave_registry.move or attestation.move

Responsible for:

- storing registered enclave public keys
- storing expected image measurement/PCR
- revoking enclave keys
- checking signatures over `ActionIntent`
- optionally verifying full TEE attestation documents in the hardened version

### receipt.move

Responsible for action events:

```text
ActionExecuted {
  treasury: ID,
  agent: ID,
  action_kind: u8,
  protocol_id: u8,
  asset_type: vector<u8>,
  amount: u64,
  intent_hash: vector<u8>,
  input_hash: vector<u8>,
  report_blob_id: vector<u8>,
  timestamp_ms: u64,
}
```

Receipts should be emitted only after a successful action.

## Agent and TEE Design

The current agent should be split into four conceptual roles:

### Planner

Reads market state and produces candidate actions. This can involve the LLM for
summaries, but the output is not trusted.

### Validator

Deterministic TypeScript logic checks:

- asset allowlist
- protocol allowlist
- amount caps
- health-factor constraints
- rebalance breakeven constraints
- depeg/circuit-breaker constraints

This logic should mirror the Move verifier spec.

### Enclave Signer

API shape:

```text
signActionIntent(intent, inputBundle) -> {
  intent,
  intentHash,
  inputHash,
  enclavePubkey,
  signature,
  attestationRef
}
```

The private key never leaves the enclave.

### Submitter

Builds the Sui PTB and submits it. The submitter can be outside the TEE because
Move verifies the signature and policy. The submitter should not be trusted to
modify the intent.

## Risk Controls

V1 required:

- USDC-only treasury
- protocol allowlist
- asset allowlist
- per-action cap
- rolling-period cap
- expiry
- nonce/replay protection
- owner revocation
- no raw arbitrary transfers
- on-chain receipts

V1.5:

- max per-protocol exposure
- depeg circuit breaker
- protocol pause list
- minimum health factor checks for any borrow-capable action
- emergency unwind action

Deferred:

- live borrowing for user funds
- recursive looping
- CLMM LP strategies
- cross-asset swaps beyond approved stablecoin routing

## Walrus and Seal Integration

Walrus should store:

- run reports
- signed action explanations
- historical memory
- strategy metadata
- optional encrypted strategy weights/config

Seal should protect sensitive blobs so only the enclave can decrypt them. The
intended flow:

1. Operator stores encrypted strategy config on Walrus.
2. Enclave proves its identity.
3. Seal grants/decrypts only inside the enclave context.
4. Enclave computes and signs actions.
5. Public report reveals enough to audit, not enough to leak secrets.

Do not make Walrus the source of truth for execution. Move receipts are the source
of truth for fund movement.

## Phased Build Plan

### Phase 1: Non-Custodial Treasury

- Finish `capability.move` tests.
- Deploy `Treasury<USDC>` on testnet.
- Add scripts for create, deposit, revoke, withdraw.
- Demonstrate owner revocation.

### Phase 2: Verified Action Templates

- Add `verifier.move`.
- Remove reliance on generic raw coin release for user funds.
- Add a v1 approved action: supply USDC to one protocol.
- Add nonce and receipt events.

### Phase 3: Mock Enclave Signer

- Add canonical `ActionIntent` serialization in TS.
- Add local mock signer with the same API as the future enclave.
- Add Move signature verification against registered mock public key.
- Run full testnet flow with tiny funds.

### Phase 4: Real TEE Registration

- Package deterministic strategy runner into reproducible enclave image.
- Boot enclave, generate key, produce attestation.
- Register enclave public key and image measurement.
- Replace mock signer with enclave signer.

### Phase 5: Walrus/Seal Secrets and Audit

- Move strategy config/memory blobs to encrypted Walrus storage.
- Decrypt only inside enclave.
- Store receipt-linked run reports.
- Add explorer/trust-console view later.

### Phase 6: Production Hardening

- Add protocol pause and emergency unwind.
- Add depeg price authentication.
- Add monitoring for failed signatures, failed receipts, stale inputs.
- Add owner-facing revoke and withdraw UI.

## Testing Strategy

### Move Unit Tests

- create treasury
- deposit funds
- release/execute within cap
- reject over per-tx cap
- reject over rolling cap
- reject expired cap
- reject revoked agent
- reject wrong treasury/cap pairing
- reject replayed nonce
- reject wrong enclave signer
- reject non-allowlisted protocol
- reject non-allowlisted asset
- emit receipt only on success

### TypeScript Tests

- canonical intent serialization is stable
- policy hash is stable
- input hash is stable
- tampered intent fails signature validation
- planner cannot produce unsupported action kinds
- LLM output cannot bypass deterministic validator
- mock signer and enclave signer share the same interface

### Integration Tests

- testnet USDC treasury creation
- mock-signed supply into approved protocol
- receipt emitted and indexed
- revoke blocks next action
- wrong signer fails
- stale nonce fails
- over-cap action fails
- Walrus report references receipt hash

## Open Questions

1. Should v1 verify full TEE attestation on-chain, or start with off-chain
   attestation verification plus on-chain registered pubkeys?
2. Should each user have a separate treasury object, or should there be a pooled
   strategy vault with per-user shares?
3. Which protocol should be the first verified action template?
4. Should action templates call protocols directly from Move, or should the PTB
   compose verified treasury release plus protocol SDK-generated calls?
5. How much of the risk verifier can Move re-derive from on-chain state versus
   needing signed/enclave-authenticated inputs?

## Recommended V1 Lock

Build the first user-funds version as:

```text
USDC-only
single-user Treasury<USDC>
OwnerCap revocation
AgentCap with caps and expiry
registered enclave/mock signer
one approved action: supply USDC
on-chain receipt
Walrus report
no live borrowing
no looping
no CLMM
```

This is the shortest path to proving the important product claim:

```text
Users can delegate idle capital to an autonomous yield agent without trusting the
operator, because funds only move through verifiable on-chain bounds and
TEE-signed deterministic decisions.
```
