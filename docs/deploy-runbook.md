# Deploy — attested, non-custodial treasury (mainnet)

The full loop **agent → enclave `/decide` → TEE signature → `verified_supply_*` contract →
custody**, live on Sui mainnet across Suilend, NAVI, and Scallop. The on-chain side is a
**split architecture**: a protocol-free `treasury_core` + one adapter package per protocol
(each sees only its own protocol's deps, so no dependency diamond). One shared `Treasury`;
the agent allocates across all three from a single fund pool. See `move/README.md` for the
package design and `docs/architecture.md` for the system overview.

## Prerequisites
- **Sui CLI** on mainnet (`sui client switch --env mainnet`), `bun`, `python3`.
- **`oyster-cvm` CLI** + **Docker** (for the enclave).
- An **owner** wallet funded with SUI + USDC, and a separate **agent** wallet (delegated,
  low-privilege). See [the two-key model](#two-key-model).
- All ids land in `deployments/mainnet-v2.env`; the `treasury` CLI + `mainnet-supply.ts` read it.

---

## 1. Publish the packages

Publish in dependency order — new-style automated address management records each package's
published-at in `Published.toml`, so dependents link to the on-chain package automatically
(no manual `published-at` edits, no stubs). `mainnet`/`testnet` are CLI *system* envs, so the
packages need no `[environments]` block to publish there.

```bash
cd move/packages
sui client publish --gas-budget 200000000 ./enclave        # → ENCLAVE_FRAMEWORK_PKG
sui client publish --gas-budget 300000000 ./core           # → CORE_PKG, Cap<DECISION>, DecisionRegistry
for p in scallop_adapter navi_adapter suilend_adapter mock_adapter; do
  sui client publish --gas-budget 300000000 ./$p           # → <P>_ADAPTER_PKG (links the published core)
done
```

**Register the adapter allowlist** (Cap-gated — binds `protocol_id → adapter witness type`, so
only the registered package can release for that protocol):
```bash
# Suilend=0  Scallop=1  NAVI=2  mock=255
sui client call --package $CORE_PKG --module decision --function register_adapter \
  --type-args "$SCALLOP_ADAPTER_PKG::scallop_adapter::SCALLOP" --args $REGISTRY $CAP_DECISION 1 --gas-budget 50000000
# …repeat for SUILEND/0, NAVI/2, MOCK/255
```

> **Smoke-test the linkage cheaply first:** publish `enclave → core → mock_adapter` on a
> throwaway localnet (no mainnet-only protocol deps) and confirm `mock_adapter`'s on-chain
> Dependencies point at the already-published core. If that links, the real adapters follow the
> same mechanism on mainnet.

---

## 2. Deploy + register the enclave

The Oyster **blue base image (v3.0.0)** generates a secp256k1 keypair *inside* the enclave at
`/app/ecdsa.sec` and serves two attestations: **`:1300`** binds the base's ed25519 identity
(what `oyster-cvm verify` checks); **`:1301`** binds **our** secp256k1 key. On-chain
`register_enclave` consumes the **`:1301`** doc. Our app just reads the file and signs.

```bash
cd enclave
# image MUST be a pinned @sha256 digest (PCR16 = the image measurement must be reproducible).
oyster-cvm deploy --wallet-private-key "$OWNER_PK" --docker-compose ./docker-compose.yml \
  --instance-type c6g.xlarge --duration-in-minutes 240 --deployment sui      # → PUBLIC_IP
export ENCLAVE_IP=<PUBLIC_IP>

# verify + decode the :1301 key/PCRs BEFORE spending gas:
curl -s http://$ENCLAVE_IP:3000/health        # -> ok
curl -s http://$ENCLAVE_IP:1301/attestation/hex | bun run scripts/decode-attestation.ts   # PCR0/1/2/16 + secp256k1 key
```

Register on-chain. **Split note:** the `enclave` module lives in the framework package, the
`DECISION` type in core — so the calls take separate `--package` / `--type-args` (the old
single-package register helper no longer applies — register via the inline PTB below):
```bash
# E4 — create the EnclaveConfig with the measured PCRs (skip if reusing a config with matching PCRs)
sui client call --package $ENCLAVE_FRAMEWORK_PKG --module enclave --function create_enclave_config \
  --type-args ${CORE_PKG}::decision::DECISION \
  --args $CAP_DECISION "treasury-enclave" 0x$PCR0 0x$PCR1 0x$PCR2 0x$PCR16 --gas-budget 100000000   # → CONFIG

# E5 — register_enclave (inline PTB; fetches the live :1301 doc, which is time-bounded)
HEX=$(curl -s "http://$ENCLAVE_IP:1301/attestation/hex" | tr -d '[:space:]')
VEC=$(python3 -c "h='$HEX'; print('vector['+','.join(f'{int(h[i:i+2],16)}u8' for i in range(0,len(h),2))+']')")
sui client ptb --assign v "$VEC" \
  --move-call 0x2::nitro_attestation::load_nitro_attestation v @0x6 --assign doc \
  --move-call "${ENCLAVE_FRAMEWORK_PKG}::enclave::register_enclave<${CORE_PKG}::decision::DECISION>" @$CONFIG doc \
  --gas-budget 200000000      # → ENCLAVE_OBJECT (the attested Enclave<DECISION>)
```
Same image re-deploys to the **same PCRs** (reproducible), so you can reuse an existing
`EnclaveConfig` and only re-run E5 — the new run just generates a fresh signing key.

---

## 3. Create + fund the Treasury, wire the env

Use the `treasury` CLI (reads `deployments/mainnet-v2.env`; dry-runs unless `--submit`):
```bash
cd agent
OWNER_SUI_PRIVATE_KEY=suiprivkey1… bun run treasury create --fund 20 --cap 500 --submit   # records TREASURY/OWNERCAP/AGENTCAP
bun run treasury sync-env                                                                 # → populates agent/.env
bun run treasury status                                                                   # budget + positions
```
`create` delegates the `AgentCap` to `AGENT_ADDR`; `sync-env` writes all `TREASURY_*` vars
(plus `TREASURY_MODE=true`) into `agent/.env`.

---

## 4. Run + withdraw

```bash
cd agent
bun src/index.ts run-daemon                                  # agent: enclave /decide → attested verified_supply → custody
# manual single-protocol supply (dry-run unless SUBMIT=1):
source ../deployments/mainnet-v2.env && ENCLAVE=$ENCLAVE_OBJECT PROTOCOL=scallop bun scripts/mainnet-supply.ts

# owner withdraws deployed treasury positions (dry-run unless --submit); scallop/mock = whole position, navi/suilend = --amount:
OWNER_SUI_PRIVATE_KEY=suiprivkey1… bun run treasury withdraw --submit
OWNER_SUI_PRIVATE_KEY=suiprivkey1… bun run treasury withdraw --protocol navi --amount 4 --submit
# owner recovers idle (un-deployed) principal from the vault (wraps capability::withdraw_principal):
OWNER_SUI_PRIVATE_KEY=suiprivkey1… bun run treasury withdraw-idle --submit
# agent recovers a Flow-2 WALLET position (TREASURY_MODE=false; agent-signed, not owner):
bun run treasury wallet-withdraw --protocol navi --amount 3 --submit
```
All four recovery paths live in the `treasury` CLI; each dry-runs unless `--submit`.

### Two-key model
The **agent** key (`AGENT_SUI_PRIVATE_KEY` in `agent/.env`) is low-privilege: the daemon signs
only capped, enclave-attested supplies with it — it can never withdraw principal and is
revocable. The **owner** key (full control — create/deposit/withdraw) is separate:
`OWNER_SUI_PRIVATE_KEY` (passed inline, never stored) or your Sui keystore. Keeping them
distinct is what makes the treasury non-custodial; using one wallet for both collapses that to
a single-key custodial setup (the contract allows it, but a leak of the hot agent key = full rug).

---

## Caveats
- **Scallop ids are upgrade-gated** — `mint` calls `assert_current_version`, so a stale package
  or `Version` aborts (`TypeMismatch` / `513`). Resolve `Version`/`Market` live from the SDK.
- **Suilend deposit is oracle-gated** — `mainnet-supply.ts` prepends `refreshReservePrices` (the
  reserve's Pyth `PriceInfoObject`). On a cold reserve, prepend a `pyth::update_price_feeds` too.
- **Caps are fixed at creation** — `per_tx_cap` / `period_cap` can't be raised on an existing
  Treasury; create a fresh one to deploy past the daily cap.
- **Keep the enclave image reproducible** (pinned base, frozen lockfile) so PCR0/1/2/16 verify.

## Gotchas (hard-won)
| Symptom | Cause | Fix |
| --- | --- | --- |
| `register_enclave` aborts `EInvalidPublicKeyLength` | registered the `:1300` doc (ed25519) | register the **`:1301`** doc (secp256k1) |
| Deploy: *"no space left on device"* | default host too small for the in-enclave pull | `--instance-type c6g.xlarge` |
| App unreachable / `/public-key` 404 | wrong port, or a shell-escaped `;` in the curl path | app serves **:3000**; no trailing `; echo` |
| `oyster-cvm verify --pcr-preset` *pcrs mismatch* | preset assumes PCR16 = zeros; ours is the app measurement | harmless — read PCRs from the `:1301` decode |
| supply aborts `EExceedsPerTxCap` (code 0 in `capability`) | amount over the cap | lower it (≤ `per_tx_cap`, ≤ remaining `period_cap`) |
| `funds after` looks unchanged | read-after-write RPC lag | trust the `FundsReleased` event / `spent_in_period` |

**Live mainnet ids** are recorded in [`deployments/mainnet-v2.env`](../../deployments/mainnet-v2.env).
