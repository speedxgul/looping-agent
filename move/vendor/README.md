# vendor/ — build-time protocol interface stubs

These are **not** our code and are **never published**. Each is a minimal Move package that
mirrors the **exact public signatures** of a real on-chain lending protocol, so our
adapters in `sources/adapters/` compile and type-check against the real API without
dragging the protocol's full (often unbuildable) source.

| Package | Mirrors | Real address / source |
|---|---|---|
| `suilend_interface` | `suilend::lending_market` / `reserve` | `@suilend/core` (MVR), `0xe53906c2…` |
| `scallop_interface` | `protocol::mint` / `redeem` / `market` / `version` / `reserve` | `ScallopProtocol`, `0xefe8b36d…` |
| `navi_interface` | `lending_core::{lending,account,storage,pool,incentive_v2,incentive_v3}` | `@navi-protocol/lending`, types at `0xd899…` |
| `navi_oracle` | `oracle::oracle::PriceOracle` | NAVI oracle, `0xca44…` |

## Why stubs instead of real deps

- **Suilend** — its published `Move.lock` pins a `MystenLabs/sui` framework rev GitHub no
  longer serves (`not our ref`), and its source pulls Pyth/Wormhole/Switchboard.
- **Scallop** — buildable from source, but the stub keeps our build dep-free + fast.
- **NAVI** — closed source; signatures were fetched from the live chain via
  `sui_getNormalizedMoveFunction` and transcribed verbatim.

Every function body is `abort 0` — the stub is a compile-time type surface only. At mainnet
publish, point each named address at the real package (or swap to the MVR dependency, e.g.
`suilend = { r.mvr = "@suilend/core" }`). See `docs/runbooks/` / `docs/spikes/m0-protocol-choice.md`.

## Updating a stub

If a protocol upgrades a signature, re-fetch the truth and edit the stub to match:

```bash
# from-chain ABI (authoritative):
curl -s https://fullnode.mainnet.sui.io:443 -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"sui_getNormalizedMoveFunction","params":["<PKG>","<module>","<function>"]}'
```
