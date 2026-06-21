#!/usr/bin/env bash
# Mainnet linkage swap for the vendor interface stubs.
#
# The four `move/vendor/*` packages are BUILD-TIME stubs: their named addresses are `0x0`
# and they have no `published-at`, so on testnet/localnet (and `sui move test`) they get
# published alongside our package with `abort` bodies — only the `mock` adapter runs there.
#
# For a MAINNET publish we instead want the adapters to LINK to the REAL protocol packages.
# This script sets each stub's named address AND `published-at` to the real on-chain
# type-origin package, so `sui client publish` records a linkage to it (and does NOT publish
# the stub). The verbatim-copied signatures mean the on-chain package satisfies the stub's
# declared modules. Run `--revert` to restore the `0x0` state before any testnet work / tests.
#
#   ./set-mainnet-linkage.sh            # set real mainnet addresses + published-at
#   ./set-mainnet-linkage.sh --revert   # restore 0x0 (and remove published-at)
#
# AFTER setting, VERIFY before spending gas (the runbook's gate):
#   sui move build --build-env mainnet           # type-checks + resolves the linkage
#   sui client publish --gas-budget 300000000 --dry-run   # confirms publish-time linking
# If Sui rejects the abort-body stubs at publish, the fallback is MVR deps
# (e.g. `suilend = { r.mvr = "@suilend/core" }`) — see each stub's Move.toml header.
set -euo pipefail

VENDOR="$(cd "$(dirname "$0")/../vendor" && pwd)"

# file:named_address:real_mainnet_type_origin_package
LINKS=(
  "scallop_interface:protocol:0xefe8b36d5b2e43728cc323298626b83177803521d195cfb11e15b910e892fddf"
  "suilend_interface:suilend:0xf95b06141ed4a174f239417323bde3f209b972f5930d8521ea38a52aff3a6ddf"
  "navi_interface:lending_core:0xd899cf7d2b5db716bd2cf55599fb0d5ee38a3061e7b6bb6eebf73fa5bc4c81ca"
  "navi_oracle:oracle:0xca441b44943c16be0e6e23c5a955bb971537ea3289ae8016fbf33fffe1fd210f"
)

REVERT="${1:-}"

for link in "${LINKS[@]}"; do
  IFS=':' read -r pkg named addr <<< "$link"
  toml="$VENDOR/$pkg/Move.toml"
  [ -f "$toml" ] || { echo "missing $toml" >&2; exit 1; }

  if [ "$REVERT" = "--revert" ]; then
    # named address -> 0x0, and drop any published-at line.
    perl -i -pe "s/^(\\s*$named\\s*=\\s*).*$/\${1}\"0x0\"/" "$toml"
    perl -i -ne "print unless /^published-at\\s*=/" "$toml"
    echo "reverted $pkg -> 0x0"
  else
    # named address -> real package.
    perl -i -pe "s/^(\\s*$named\\s*=\\s*).*$/\${1}\"$addr\"/" "$toml"
    # ensure a single published-at under [package] (insert after the edition line if absent).
    if ! grep -q '^published-at' "$toml"; then
      perl -i -pe "s/^(edition\\s*=.*)$/\$1\npublished-at = \"$addr\"/" "$toml"
    else
      perl -i -pe "s/^(published-at\\s*=\\s*).*$/\${1}\"$addr\"/" "$toml"
    fi
    echo "linked $pkg::$named -> $addr"
  fi
done

echo "done. (default state is 0x0; remember to --revert before tests / testnet)"
