# Split-architecture mainnet deploy runbook

Protocol-free `treasury_core` + per-protocol adapter packages. One shared `Treasury`; the
agent allocates across Scallop / NAVI / Suilend from a single fund pool. Each adapter package
sees only its own protocol's deps, so the dependency diamond that blocked the all-in-one
package never forms.

## Package graph
```
enclave            (Nautilus attestation lib — no deps)
  └─ treasury_core (capability + decision + seal_policy; deps: enclave)
       ├─ scallop_adapter  (deps: treasury_core + real Scallop `protocol`)
       ├─ navi_adapter     (deps: treasury_core + real NAVI lending_core+oracle)
       ├─ suilend_adapter  (deps: treasury_core + real Suilend)
       └─ mock_adapter     (deps: treasury_core only — testnet/demo)
```

Publish in dependency order. New-style automated address management records each package's
published address in its `Move.lock` (mainnet env) on publish, so dependents link to the
on-chain package automatically — NO manual `published-at` edits, NO local stubs.

## Steps (run from `move/packages`, active CLI env = mainnet)

### 1. Publish the library + core
```bash
cd enclave        && sui client publish --gas-budget 200000000        # → ENCLAVE_PKG
cd ../core        && sui client publish --gas-budget 300000000        # → CORE_PKG
```
From the core publish effects, record:
- `CORE_PKG`            (the package id)
- `CAP_DECISION`        — `enclave::enclave::Cap<…::decision::DECISION>` (owned by deployer)
- `REGISTRY`            — shared `decision::DecisionRegistry`

### 2. Attest + register the enclave (same enclave image as before; PCRs unchanged)
```bash
# create the PCR-pinned config (deployer holds CAP_DECISION)
sui client call --package $CORE_PKG --module enclave --function create_enclave_config \
  --type-args "$CORE_PKG::decision::DECISION" \
  --args $CAP_DECISION "treasury-enclave" 0x$PCR0 0x$PCR1 0x$PCR2 0x$PCR16 \
  --gas-budget 100000000                                               # → ENCLAVE_CONFIG

# register with a fresh Nitro attestation document (from the running enclave :1301)
sui client call --package $CORE_PKG --module enclave --function register_enclave \
  --type-args "$CORE_PKG::decision::DECISION" \
  --args $ENCLAVE_CONFIG $ATTESTATION_DOC --gas-budget 200000000       # → ENCLAVE_OBJECT (Enclave<DECISION>)
```

### 3. Publish the adapter packages
```bash
cd ../scallop_adapter && sui client publish --gas-budget 300000000     # → SCALLOP_ADAPTER_PKG
cd ../navi_adapter    && sui client publish --gas-budget 300000000     # → NAVI_ADAPTER_PKG
cd ../suilend_adapter && sui client publish --gas-budget 300000000     # → SUILEND_ADAPTER_PKG
cd ../mock_adapter    && sui client publish --gas-budget 200000000     # → MOCK_ADAPTER_PKG (optional)
```

### 4. Register each adapter witness in the core allowlist (Cap-gated)
Binds `protocol_id → adapter witness type`, so only the registered package can release for it.
```bash
# Scallop = 1, NAVI = 2, Suilend = 0, mock = 255
sui client call --package $CORE_PKG --module decision --function register_adapter \
  --type-args "$SCALLOP_ADAPTER_PKG::scallop_adapter::SCALLOP" --args $REGISTRY $CAP_DECISION 1 --gas-budget 50000000
sui client call --package $CORE_PKG --module decision --function register_adapter \
  --type-args "$NAVI_ADAPTER_PKG::navi_adapter::NAVI"         --args $REGISTRY $CAP_DECISION 2 --gas-budget 50000000
sui client call --package $CORE_PKG --module decision --function register_adapter \
  --type-args "$SUILEND_ADAPTER_PKG::suilend_adapter::SUILEND" --args $REGISTRY $CAP_DECISION 0 --gas-budget 50000000
sui client call --package $CORE_PKG --module decision --function register_adapter \
  --type-args "$MOCK_ADAPTER_PKG::mock_supply::MOCK"          --args $REGISTRY $CAP_DECISION 255 --gas-budget 50000000
```

### 5. Create + fund the shared treasury
```bash
sui client call --package $CORE_PKG --module capability --function create \
  --type-args $USDC_COIN_TYPE \
  --args $USDC_COIN_OBJECT $PER_TX_CAP $PERIOD_CAP $PERIOD_MS $EXPIRY_MS $AGENT_ADDR 0x6 \
  --gas-budget 100000000                       # → TREASURY (shared), OWNERCAP (owner), AGENTCAP (agent)
```

### 6. Update `deployments/mainnet.env` + `agent/.env`
```
TREASURY_PACKAGE_ID=$CORE_PKG
TREASURY_MOCK_ADAPTER_PKG=$MOCK_ADAPTER_PKG
TREASURY_REGISTRY_ID=$REGISTRY
TREASURY_ENCLAVE_OBJECT_ID=$ENCLAVE_OBJECT
TREASURY_ID=$TREASURY
TREASURY_AGENT_CAP_ID=$AGENTCAP
TREASURY_SCALLOP_ADAPTER_PKG=$SCALLOP_ADAPTER_PKG
TREASURY_NAVI_ADAPTER_PKG=$NAVI_ADAPTER_PKG
TREASURY_SUILEND_ADAPTER_PKG=$SUILEND_ADAPTER_PKG
# + the existing TREASURY_SCALLOP_*, TREASURY_NAVI_*, TREASURY_SUILEND_* shared-object ids
```

## Linkage smoke-test (recommended BEFORE step 3 mainnet spend)
The enclave→core→mock_adapter chain has NO mainnet-only protocol deps, so it can publish on a
local/test network to prove the new-style multi-package publish linkage works end-to-end:
publish `enclave`, `core`, `mock_adapter` (in order) and confirm `mock_adapter` links the
already-published core. If that succeeds, the real adapters follow the same mechanism on mainnet.
