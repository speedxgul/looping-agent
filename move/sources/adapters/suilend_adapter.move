/// REAL Suilend protocol adapter — the production counterpart to `mock_supply`.
///
/// Supplies treasury funds into Suilend and custodies the withdrawal-gating
/// `ObligationOwnerCap` INSIDE the `Treasury` (a dynamic object field), so the agent
/// can deposit but only the `OwnerCap` holder can unwind. The minted `CToken` and the
/// owner-cap never reach the host PTB — identical custody guarantees to `mock_supply`,
/// against Suilend's real API.
///
/// Compiles + type-checks against Suilend's exact published signatures via the local
/// `suilend_interface` build stub (see `vendor/suilend_interface/`, mirroring
/// @suilend/core). Live execution additionally needs a Suilend market for the asset and
/// a Pyth reserve-price refresh in the PTB (mainnet; no Suilend testnet market exists —
/// see `docs/spikes/m0-protocol-choice.md`), so this module is verified by compilation,
/// not by unit tests (Suilend's `LendingMarket` can't be constructed off-chain).
///
/// Type params: `P` = Suilend lending-market type (mainnet `…::suilend::MAIN_POOL`),
/// `T` = underlying coin. `reserve_array_index` is resolved off-chain from the coin type.
module treasury_agent::suilend_adapter;

use sui::clock::Clock;
use sui::coin::Coin;
use suilend::lending_market::{Self, LendingMarket, ObligationOwnerCap};
use treasury_agent::capability::{Self, Treasury, AgentCap, OwnerCap};

/// Protocol id for Suilend (matches `decision`'s Suilend protocol id).
const PROTOCOL_SUILEND: u8 = 0;

/// Supply `amount` from the treasury into Suilend, minting cTokens into a Suilend
/// obligation whose owner-cap stays custodied in the `Treasury`. The first supply
/// creates the obligation; later supplies deposit against the custodied cap (one
/// obligation per protocol). No `Coin` or cap is returned to the PTB.
public fun supply_and_custody<P, T>(
    treasury: &mut Treasury<T>,
    cap: &AgentCap<T>,
    lending_market: &mut LendingMarket<P>,
    reserve_array_index: u64,
    amount: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    // Bounds (active agent, per-tx cap, rolling-period cap, expiry) enforced here; the
    // released Coin flows straight into Suilend and never touches the host PTB.
    let coin = capability::release_for_action(treasury, cap, amount, clock, ctx);
    let ctokens = lending_market::deposit_liquidity_and_mint_ctokens<P, T>(
        lending_market,
        reserve_array_index,
        clock,
        coin,
        ctx,
    );

    if (treasury.has_position(PROTOCOL_SUILEND)) {
        // Reuse the custodied obligation owner-cap (no new obligation).
        let obligation = capability::borrow_receipt_mut<T, ObligationOwnerCap<P>>(
            treasury,
            PROTOCOL_SUILEND,
        );
        lending_market::deposit_ctokens_into_obligation<P, T>(
            lending_market,
            reserve_array_index,
            obligation,
            clock,
            ctokens,
            ctx,
        );
    } else {
        // First supply: create the obligation, deposit, then custody its owner-cap.
        let obligation = lending_market::create_obligation<P>(lending_market, ctx);
        lending_market::deposit_ctokens_into_obligation<P, T>(
            lending_market,
            reserve_array_index,
            &obligation,
            clock,
            ctokens,
            ctx,
        );
        capability::custody_receipt(treasury, PROTOCOL_SUILEND, obligation);
    }
}

/// OWNER-ONLY: withdraw `amount` cTokens from the custodied obligation and recover the
/// underlying as a `Coin`. The owner-cap is taken under `OwnerCap` authority, used, then
/// re-custodied so the obligation persists across partial unwinds.
public fun owner_redeem<P, T>(
    treasury: &mut Treasury<T>,
    owner: &OwnerCap<T>,
    lending_market: &mut LendingMarket<P>,
    reserve_array_index: u64,
    amount: u64,
    clock: &Clock,
    ctx: &mut TxContext,
): Coin<T> {
    let obligation = capability::owner_take_receipt<T, ObligationOwnerCap<P>>(
        treasury,
        owner,
        PROTOCOL_SUILEND,
    );
    let ctokens = lending_market::withdraw_ctokens<P, T>(
        lending_market,
        reserve_array_index,
        &obligation,
        clock,
        amount,
        ctx,
    );
    let redeemed = lending_market::redeem_ctokens_and_withdraw_liquidity<P, T>(
        lending_market,
        reserve_array_index,
        clock,
        ctokens,
        option::none(),
        ctx,
    );
    // Re-custody the owner-cap so the obligation survives a partial withdraw.
    capability::custody_receipt(treasury, PROTOCOL_SUILEND, obligation);
    redeemed
}
