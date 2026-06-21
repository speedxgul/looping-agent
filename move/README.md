# move/ — on-chain packages

The Sui Move code that makes the agent **non-custodial and verifiable**. It is the
choke-point every fund movement passes through; the off-chain `agent/` only proposes.

## Split architecture

A protocol-free **core** plus one **adapter package per lending protocol**. Each adapter
package depends on the core + exactly one protocol's real published source, so no single
package ever sees two protocols' (conflicting) transitive dependency graphs — the diamond
that blocks combining Scallop + NAVI + Suilend in one package never forms.

```
packages/
  enclave/          Nautilus/Oyster attestation library (Enclave<T>, register_enclave, verify_signature)
  core/             treasury_core — PROTOCOL-FREE:
                      capability.move  Treasury<T> + OwnerCap/AgentCap, per-tx + rolling caps, expiry,
                                       ReleaseTicket hot-potato + custody (positions held as dynamic
                                       object fields of the Treasury — agent deposits, only OwnerCap withdraws)
                      decision.move    enclave-signature verify + adapter allowlist → verified_release
                      seal_policy.move Seal gate (release key-shares only to the attested enclave)
  scallop_adapter/  deps core + real Scallop  (github scallop-io/sui-lending-protocol)
  navi_adapter/     deps core + real NAVI     (github naviprotocol/navi-smart-contracts)
  suilend_adapter/  deps core + real Suilend  (github suilend/suilend)
  mock_adapter/     deps core only — testnet/demo placeholder
DEPLOY.md           step-by-step mainnet deploy runbook
```

## How a verified supply flows (non-custodial across package boundaries)

1. The agent relays the enclave-signed `ActionIntent` to an adapter's `verified_supply_*_entry`.
2. The adapter calls `core::decision::verified_release<C, W>(witness, …)`, which:
   - verifies the secp256k1 signature against the registered `Enclave<DECISION>.pk`,
   - checks the calling **witness** `W` is the adapter registered for `intent.protocol_id`
     (an on-chain allowlist, `register_adapter`, Cap-gated to the deployer),
   - consumes the nonce (replay protection), and
   - releases the bounded `Coin<C>` **plus a `ReleaseTicket`** — a hot-potato with no
     abilities, so the adapter is *forced* to discharge it.
3. The adapter supplies the coin into its protocol and discharges the ticket via
   `capability::custody_new` / `borrow_for_ticket` + `discharge_existing` — which custodies
   the protocol receipt (sCoin / AccountCap / ObligationOwnerCap) **inside the Treasury**.

So even cross-package, a raw `Coin` can never escape: the only way to obtain one is a
verified release, and the only way to discharge its ticket is to custody a position. The
owner redeems via each adapter's `owner_redeem` (OwnerCap-gated; the agent never can).

**Status: built + deployed live on Sui mainnet** (all three protocols, incl. NAVI via its
AccountCap — so NAVI *is* non-custodial here). Package ids in `../deployments/mainnet-v2.env`.

## Building

Each package is independent — build from its own directory:

```bash
cd packages/core            && sui move build && sui move test
cd packages/scallop_adapter && sui move build      # fetches the real protocol git source
```

`mainnet`/`testnet` are CLI system environments, so no `[environments]` block is needed to
publish there; `Published.toml` (written on publish) records each package's on-chain address
and dependents link to it automatically. See **DEPLOY.md** for the full publish order
(enclave → core → adapters → `register_adapter` → create Treasury) and the live mainnet ids
(also in `../deployments/mainnet-v2.env`).
