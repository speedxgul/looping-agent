// Oracle-refresh prelude for the non-custodial treasury supply PTB.
//
// Some protocols' deposit aborts unless the price oracle was refreshed earlier in the
// SAME transaction — the value of the deposited coin is recomputed against a fresh price.
// Confirmed scope (DEPOSIT side): SUILEND needs a reserve-price refresh; NAVI deposit does
// NOT (only NAVI *withdraw* does); Scallop & mock need none.
//
// PTB commands execute in submission order, so any refresh command must be added BEFORE the
// `verified_supply_*` command. That's why `buildVerifiedAllocationTx` accepts a pre-built
// `tx`: the caller adds the refresh first, then hands the SAME tx to the builder, which
// appends the supply command after. The signed `ActionIntent`/nonce is unaffected — the
// refresh is plain price plumbing, not a value the enclave signs over.

import type { AllocationLeg } from './verifiedSupplyTx.js';

/** protocolId -> whether its DEPOSIT needs an oracle refresh prepended to the supply PTB. */
const SUPPLY_NEEDS_REFRESH: Record<number, boolean> = {
  0: true, // suilend  — deposit recomputes ctoken value against the reserve price
  1: false, // scallop — oracle-free mint
  2: false, // navi    — deposit needs none (its WITHDRAW does)
  255: false // mock    — no real oracle
};

/** The set of protocolIds in this allocation whose deposit needs an oracle refresh. */
export function supplyLegsNeedingRefresh(legs: AllocationLeg[]): Set<number> {
  const ids = new Set<number>();
  for (const { intent } of legs) {
    if (SUPPLY_NEEDS_REFRESH[intent.protocolId]) ids.add(intent.protocolId);
  }
  return ids;
}
