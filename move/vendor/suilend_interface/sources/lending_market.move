/// Interface mirror of `suilend::lending_market` — the exact public structs +
/// signatures our adapter calls, copied from Suilend's real source. Bodies `abort`:
/// this is a build-time stub, never executed (the real package runs at publish).
module suilend::lending_market;

use sui::clock::Clock;
use sui::coin::Coin;
use suilend::reserve::CToken;

public struct LendingMarket<phantom P> has key, store {
    id: UID,
}

public struct ObligationOwnerCap<phantom P> has key, store {
    id: UID,
    obligation_id: ID,
}

public struct RateLimiterExemption<phantom P, phantom T> has drop {}

public fun create_obligation<P>(
    _lending_market: &mut LendingMarket<P>,
    _ctx: &mut TxContext,
): ObligationOwnerCap<P> {
    abort 0
}

public fun deposit_liquidity_and_mint_ctokens<P, T>(
    _lending_market: &mut LendingMarket<P>,
    _reserve_array_index: u64,
    _clock: &Clock,
    _deposit: Coin<T>,
    _ctx: &mut TxContext,
): Coin<CToken<P, T>> {
    abort 0
}

public fun deposit_ctokens_into_obligation<P, T>(
    _lending_market: &mut LendingMarket<P>,
    _reserve_array_index: u64,
    _obligation_owner_cap: &ObligationOwnerCap<P>,
    _clock: &Clock,
    _deposit: Coin<CToken<P, T>>,
    _ctx: &mut TxContext,
) {
    abort 0
}

public fun withdraw_ctokens<P, T>(
    _lending_market: &mut LendingMarket<P>,
    _reserve_array_index: u64,
    _obligation_owner_cap: &ObligationOwnerCap<P>,
    _clock: &Clock,
    _amount: u64,
    _ctx: &mut TxContext,
): Coin<CToken<P, T>> {
    abort 0
}

public fun redeem_ctokens_and_withdraw_liquidity<P, T>(
    _lending_market: &mut LendingMarket<P>,
    _reserve_array_index: u64,
    _clock: &Clock,
    _ctokens: Coin<CToken<P, T>>,
    _rate_limiter_exemption: Option<RateLimiterExemption<P, T>>,
    _ctx: &mut TxContext,
): Coin<T> {
    abort 0
}
