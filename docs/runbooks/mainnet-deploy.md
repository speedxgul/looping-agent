# Mainnet end-to-end runbook (split architecture, real protocols)

Take the attested treasury live on **mainnet** with **all three** real lending protocols —
the full loop **agent → enclave `/decide` → attested signature → `verified_supply_*` →
custody → owner withdraw**, with real USDC. This ties together the two component runbooks:

- **Packages:** [`move/packages/DEPLOY.md`](../../move/packages/DEPLOY.md) — publish order, `register_adapter`, create Treasury.
- **Enclave:** [`m3-attestation.md`](m3-attestation.md) — Oyster deploy, attestation, `create_enclave_config` / `register_enclave`.

> The old single-package + `vendor/*` interface-stub flow is **gone**. Each protocol now
> lives in its own adapter package that depends on the protocol-free core + the protocol's
> **real git source**, so there are no stubs to link and no dependency diamond. See
> `move/README.md` for the architecture.

---

## Order of operations

1. **Publish the packages** — `move/packages/DEPLOY.md` Steps 1, 3: publish `enclave` → `core`
   → the four adapters (new-style `Published.toml` auto-links each to the published core).
   Record `CORE_PKG`, `REGISTRY` (DecisionRegistry), `CAP_DECISION`, and each `*_ADAPTER_PKG`.
2. **Register the adapter allowlist** — `DEPLOY.md` Step 4: `register_adapter<W>(registry, cap, protocol_id)`
   for Suilend (0), Scallop (1), NAVI (2), mock (255). Binds each `protocol_id` to its adapter witness.
3. **Deploy + register the enclave** — `m3-attestation.md`, but note the split: `enclave` module
   functions live in the **enclave framework package**, the `DECISION` type in **core**:
   ```bash
   # create_enclave_config  (framework pkg, core's DECISION type)
   sui client call --package $ENCLAVE_FRAMEWORK_PKG --module enclave --function create_enclave_config \
     --type-args ${CORE_PKG}::decision::DECISION \
     --args $CAP_DECISION "treasury-enclave" 0x$PCR0 0x$PCR1 0x$PCR2 0x$PCR16 --gas-budget 100000000
   # register_enclave (inline PTB — the old register-enclave.sh assumes one pkg for both)
   sui client ptb --assign v "$VEC" \
     --move-call 0x2::nitro_attestation::load_nitro_attestation v @0x6 --assign doc \
     --move-call "${ENCLAVE_FRAMEWORK_PKG}::enclave::register_enclave<${CORE_PKG}::decision::DECISION>" @$CONFIG doc \
     --gas-budget 200000000
   ```
4. **Create + fund the Treasury** — `DEPLOY.md` Step 5: `capability::create<USDC>(coin, per_tx_cap,
   period_cap, period_ms, expiry_ms, agent, 0x6)`. One shared Treasury serves all protocols.
5. **Resolve the protocol shared-object ids** (native USDC):
   - **Scallop** — `Version` + `Market` from `new Scallop({networkType:'mainnet'}).getScallopAddress()`
     (`core.version`, `core.market`). Upgrade-gated — resolve live, don't hardcode.
   - **NAVI** — `getConfig({env:'prod'})` → `storage`/`incentiveV2`/`incentiveV3`/`priceOracle`;
     `getPool(USDC)` → `id` (asset), `contract.pool` (Pool object).
   - **Suilend** — `LENDING_MARKET_ID` + `LENDING_MARKET_TYPE` (`@suilend/sdk` consts);
     `initializeSuilend` → `reserveMap[USDC].arrayIndex`; Pyth `PriceInfoObject` via `pythClient`.
6. **Wire `agent/.env`** — `TREASURY_PACKAGE_ID` = core; per protocol `TREASURY_<P>_ADAPTER_PKG`
   + its shared-object ids; `TREASURY_ENCLAVE_OBJECT_ID` + `TREASURY_ENCLAVE_URL`. The live mainnet
   ids are in `deployments/mainnet-v2.env`.

## The real round-trip

**Supply** — either the autonomous daemon or the direct script:
```bash
# autonomous: Claude reasons over rates → TEE optimizer allocates → submits the legs
cd agent && bun src/index.ts run-once          # one cycle   (run-daemon = 15-min loop)

# direct, per-protocol (dry-run by default; SUBMIT=1 to execute):
source deployments/mainnet-v2.env && cd agent
ENCLAVE=$ENCLAVE_OBJECT PROTOCOL=scallop bun scripts/mainnet-supply.ts   # or navi | suilend
```
`mainnet-supply.ts` prepends the Suilend Pyth reserve refresh automatically; Scallop and NAVI
deposits need no oracle. The released USDC flows into the real protocol and the receipt
(sCoin / AccountCap / ObligationOwnerCap) is custodied in the Treasury.

**Withdraw** (owner, OwnerCap-gated, no enclave) — `agent/scripts/owner-withdraw.ts`, with
`PKG` set to the protocol's adapter package:
```bash
cd agent
PROTOCOL=scallop PKG=$SCALLOP_ADAPTER_PKG TREASURY=… OWNERCAP=… ADDR=… COIN=$USDC_COIN_TYPE \
  SCALLOP_VERSION=… SCALLOP_MARKET=… bun scripts/owner-withdraw.ts          # whole position, no oracle
PROTOCOL=navi    PKG=$NAVI_ADAPTER_PKG    TREASURY=… OWNERCAP=… … NAVI_ORACLE=… AMOUNT=… \
  bun scripts/owner-withdraw.ts                                              # AMOUNT units + oracle refresh
```
Idle (un-deployed) principal comes back via `capability::withdraw_principal(treasury, owner, amount)`.

## Pre-flight dry-runs (no funds)

Before any live supply, the per-protocol dry-run probes hit the protocol packages directly
(split a tiny SUI coin from gas — no USDC, no signature): `agent/scripts/mainnet-dryrun.ts`
(Scallop), `mainnet-navi-dryrun.ts`, `mainnet-suilend-dryrun.ts`. A `✓ would SUCCEED` confirms
the object ids + asset are live. Then `mainnet-supply.ts` (without `SUBMIT=1`) dry-runs the
**full** verified path through your packages.

## Caveats

- **Scallop ids are upgrade-gated** — `mint` calls `assert_current_version`, so a stale package
  or `Version` aborts (`TypeMismatch` / `513`). Resolve live from the SDK each run.
- **Suilend deposit is oracle-gated.** `mainnet-supply.ts` prepends `SuilendClient.refreshReservePrices`
  (the `PriceInfoObject` for the reserve). On mainnet the Pyth pushers keep it fresh, so this
  alone passed live; on a **cold** reserve add a `pyth::update_price_feeds` (Hermes data via
  `pythClient` + `@pythnetwork/pyth-sui-js`) ahead of the refresh.
- **Caps are fixed at creation** — `per_tx_cap` / `period_cap` can't be raised on an existing
  Treasury (no setter). To deploy more than the daily cap allows, create a new Treasury.
- **Market data is protocol-API-sourced** for the optimizer's curves — on-chain caps + the
  adapter allowlist + receipt custody bound the risk to "suboptimal-but-recoverable," never theft.
