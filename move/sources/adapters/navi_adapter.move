/// REAL NAVI protocol adapter — production counterpart to `mock_supply`.
///
/// NAVI lending is normally *address-based* (the position belongs to whoever sends the
/// tx), which would break our non-custodial model. This adapter instead uses NAVI's
/// **AccountCap** path: it mints an `AccountCap` (an isolated NAVI account), deposits
/// into that account, and custodies the cap INSIDE the `Treasury`. The agent can deposit
/// but only the `OwnerCap` holder can withdraw — the cap never reaches the host PTB.
///
/// Compiles + type-checks against NAVI's exact published ABI (fetched on-chain via
/// `sui_getNormalizedMoveFunction`; see `vendor/navi_interface` + `vendor/navi_oracle`,
/// mirroring @navi-protocol/lending). Verified by compilation; a live run needs NAVI's
/// shared `Storage` / `Pool<T>` / `Incentive` (v2+v3) objects + the asset index, and
/// (for withdraw) the `PriceOracle` (mainnet). `T` = underlying coin.
module treasury_agent::navi_adapter;

use sui::clock::Clock;
use sui::coin::Coin;
use lending_core::account::AccountCap;
use lending_core::incentive_v2::Incentive as IncentiveV2;
use lending_core::incentive_v3::{Self, Incentive as IncentiveV3};
use lending_core::lending;
use lending_core::pool::Pool;
use lending_core::storage::Storage;
use oracle::oracle::PriceOracle;
use treasury_agent::capability::{Self, Treasury, AgentCap, OwnerCap};

/// NAVI protocol id (matches `decision`'s NAVI protocol id).
const PROTOCOL_NAVI: u8 = 2;

/// Supply `amount` from the treasury into NAVI under a custodied `AccountCap`. The first
/// supply creates the account; later supplies deposit against the custodied cap. The
/// deposited coin is consumed by NAVI; no `Coin` or cap is returned to the PTB.
public fun supply_and_custody<T>(
    treasury: &mut Treasury<T>,
    cap: &AgentCap<T>,
    storage: &mut Storage,
    pool: &mut Pool<T>,
    incentive_v2: &mut IncentiveV2,
    incentive_v3: &mut IncentiveV3,
    asset: u8,
    amount: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    // Bounds (active agent, per-tx cap, rolling-period cap, expiry) enforced here.
    let coin = capability::release_for_action(treasury, cap, amount, clock, ctx);

    if (treasury.has_position(PROTOCOL_NAVI)) {
        let account_cap = capability::borrow_receipt_mut<T, AccountCap>(treasury, PROTOCOL_NAVI);
        incentive_v3::deposit_with_account_cap<T>(
            clock,
            storage,
            pool,
            asset,
            coin,
            incentive_v2,
            incentive_v3,
            account_cap,
        );
    } else {
        let account_cap = lending::create_account(ctx);
        incentive_v3::deposit_with_account_cap<T>(
            clock,
            storage,
            pool,
            asset,
            coin,
            incentive_v2,
            incentive_v3,
            &account_cap,
        );
        capability::custody_receipt(treasury, PROTOCOL_NAVI, account_cap);
    };
}

/// OWNER-ONLY: withdraw `amount` of the underlying from the custodied NAVI account and
/// recover it as a `Coin`. The `AccountCap` is taken under `OwnerCap` authority, used,
/// then re-custodied so the account persists across partial unwinds.
public fun owner_redeem<T>(
    treasury: &mut Treasury<T>,
    owner: &OwnerCap<T>,
    price_oracle: &PriceOracle,
    storage: &mut Storage,
    pool: &mut Pool<T>,
    incentive_v2: &mut IncentiveV2,
    incentive_v3: &mut IncentiveV3,
    asset: u8,
    amount: u64,
    clock: &Clock,
    ctx: &mut TxContext,
): Coin<T> {
    let account_cap = capability::owner_take_receipt<T, AccountCap>(treasury, owner, PROTOCOL_NAVI);
    let withdrawn = incentive_v3::withdraw_with_account_cap<T>(
        clock,
        price_oracle,
        storage,
        pool,
        asset,
        amount,
        incentive_v2,
        incentive_v3,
        &account_cap,
    );
    // Re-custody the cap so the NAVI account survives a partial withdraw.
    capability::custody_receipt(treasury, PROTOCOL_NAVI, account_cap);
    withdrawn.into_coin(ctx)
}
