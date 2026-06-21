# Seal Integration (Deferred — Scaffold Only)

The enclave uses [Mysten Seal](https://github.com/MystenLabs/seal) to encrypt its
secp256k1 signing seed and strategy weights at rest. Only the attested enclave
(verified by `seal_policy::seal_approve` on-chain) can obtain the decryption key-shares
from the Seal key servers.

---

## Admin endpoints (planned, not yet wired)

### 1. `init_seal_key_load`

**Purpose:** Begin the key-retrieval flow by creating an ElGamal ephemeral key-pair
inside the enclave. The enclave generates a fresh ElGamal keypair whose public key will
be embedded in the `FetchKeyRequest` so the key servers can encrypt their shares back to
the enclave and no one else.

**What it does:**
- Generates an ephemeral ElGamal keypair (`egPub`, `egPriv`) inside the TEE.
- Constructs the `FetchKeyRequest` (Seal v1 wire format): `{pkg_id, seal_id: [0], egPub}`.
- Returns `{ requestBytes, egPriv }` to the enclave's internal state (never leaves the enclave).

**Prerequisite:** The package containing `seal_policy::seal_approve` must already be
published so `pkg_id` is known.

---

### 2. `complete_seal_key_load`

**Purpose:** Collect the `FetchKeyResponse` objects returned by the Seal key servers,
decrypt the key-shares with `egPriv`, and reconstruct the Seal symmetric key.

**What it does:**
- Receives one `FetchKeyResponse` per key server (threshold-of-N scheme).
- Decrypts each share using `egPriv` (ElGamal decryption inside the TEE).
- Combines shares (Shamir reconstruction) to recover the 32-byte Seal symmetric key `K`.
- Calls `provision_*` internally to decrypt and cache the protected secrets.

**Why the round-trip:** Seal key servers only release shares after verifying a valid
dry-run of `seal_approve` against the live Sui chain. This is the on-chain gate.

---

### 3. `provision_signing_seed` / `provision_strategy_weights`

**Purpose:** Use the recovered Seal key `K` to decrypt the ciphertext blobs and place
the plaintext into protected in-memory slots (never written to disk).

- `provision_signing_seed`: decrypts the secp256k1 signing seed that the enclave uses
  to produce `ActionIntent` signatures. Replaces the current in-memory key.
- `provision_strategy_weights`: decrypts the allocation curve parameters used by
  `decide()`. Allows operators to rotate strategy config without redeploying the image.

---

## On-chain gate

`seal_policy::seal_approve<T>` in `move/sources/seal_policy.move` is the sole on-chain
control point. Seal key servers perform a dry-run of this function before releasing any
share. It verifies:

1. `id == vector[0]` — correct Seal key slot.
2. `enclave.verify_signature(WALLET_PK_INTENT=1, timestamp_ms, wallet_pk, signature)` —
   the requester holds the enclave's private key, i.e. it is the registered enclave.

The function is `public fun` (not `entry`) so Seal's dry-run PTB can call it directly.

---

## Why this is deferred

Two dependencies are not yet available in the project:

1. **`@mysten/seal` SDK** — already in `agent/package.json` but the enclave app
   (`enclave/app/`) does not yet import it or have a `FetchKeyRequest` builder.
2. **Running Seal key servers** — require a deployed package address and a live Sui
   environment to serve threshold shares.

Once both are available, implement `init_seal_key_load` → `complete_seal_key_load` →
`provision_*` in `enclave/app/server.ts` (or a dedicated `enclave/app/seal.ts` module).

---

## Tension: deps vs minimal-PCR

Importing `@mysten/seal` and its transitive dependencies into the enclave image increases
the measured binary footprint, changing PCR0/PCR2. This means that adding Seal support
requires a `cap`-gated `update_pcrs` call to advance `EnclaveConfig.version` and
re-register the enclave. Evaluate the PCR delta carefully at integration time — consider
vendoring only the share-decryption primitive rather than the full SDK to minimize image
size and PCR churn.
