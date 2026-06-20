#!/usr/bin/env bash
# Register a deployed Oyster enclave on-chain. Fetches the :1301 attestation (which
# binds the enclave's secp256k1 key) and runs the PTB:
#   load_nitro_attestation(bytes, 0x6) -> register_enclave<DECISION>(config, doc)
# Nitro docs are time-bounded, so this fetches AND submits in one shot — if it ever
# fails on a stale document, just re-run.
#
# Usage:
#   ENCLAVE_IP=<ip> CONFIG=<EnclaveConfig<DECISION> id> [PKG=<pkg>] \
#     bash enclave/scripts/register-enclave.sh
set -euo pipefail

IP="${ENCLAVE_IP:?set ENCLAVE_IP to the Oyster enclave public IP}"
CONFIG="${CONFIG:?set CONFIG to your EnclaveConfig<DECISION> object id}"
PKG="${PKG:?set PKG to the published package id (see deployments/testnet.env)}"

echo "fetching attestation from $IP:1301 ..."
HEX=$(curl -s "http://$IP:1301/attestation/hex" | tr -d '[:space:]')
echo "attestation hex length = ${#HEX}"
[ "${#HEX}" -ge 1000 ] || { echo "attestation too short — is the enclave up on :1301?"; exit 1; }

VEC=$(python3 - "$HEX" <<'EOF'
import sys
h = sys.argv[1]
print("vector[" + ",".join(f"{int(h[i:i+2],16)}u8" for i in range(0, len(h), 2)) + "]")
EOF
)

echo "submitting register_enclave PTB ..."
sui client ptb \
  --assign v "$VEC" \
  --move-call 0x2::nitro_attestation::load_nitro_attestation v @0x6 \
  --assign doc \
  --move-call "${PKG}::enclave::register_enclave<${PKG}::decision::DECISION>" @"${CONFIG}" doc \
  --gas-budget 200000000
