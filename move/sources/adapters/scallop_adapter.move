/// REAL Scallop protocol adapter — production counterpart to `mock_supply`.
///
/// Scallop's lending deposit returns a fungible `Coin<MarketCoin<T>>` (sCoin) where
/// possession IS redemption. This adapter mints the sCoin from treasury funds and
/// custodies its `Balance` INSIDE the `Treasury`, so the agent can deposit but only the
/// `OwnerCap` holder can redeem — the sCoin never reaches the host PTB.
///
/// Compiles + type-checks against Scallop's exact published `mint`/`redeem` signatures
/// via the local `scallop_interface` build stub (see `vendor/scallop_interface/`,
/// mirroring `ScallopProtocol`). Verified by compilation; a live run needs Scallop's
/// shared `Version` + `Market` objects (mainnet). `T` = underlying coin.
module treasury_agent::scallop_adapter;

use sui::balance::Balance;
use sui::clock::Clock;
use sui::coin::Coin;
use protocol::market::Market;
use protocol::mint;
use protocol::redeem;
use protocol::reserve::MarketCoin;
use protocol::version::Version;
use treasury_agent::capability::{Self, Treasury, AgentCap, OwnerCap};

/// Scallop protocol id (matches `decision`'s Scallop protocol id).
const PROTOCOL_SCALLOP: u8 = 1;

/// The custodied Scallop position: the sCoin balance held inside the Treasury.
public struct ScallopPosition<phantom T> has key, store {
    id: UID,
    scoin: Balance<MarketCoin<T>>,
}

/// Supply `amount` from the treasury into Scallop, minting sCoin and custodying its
/// balance in the `Treasury`. Repeat supplies accumulate into the same position. No
/// `Coin` (underlying or sCoin) is returned to the PTB.
public fun supply_and_custody<T>(
    treasury: &mut Treasury<T>,
    cap: &AgentCap<T>,
    version: &Version,
    market: &mut Market,
    amount: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    // Bounds (active agent, per-tx cap, rolling-period cap, expiry) enforced here.
    let coin = capability::release_for_action(treasury, cap, amount, clock, ctx);
    let scoin = mint::mint<T>(version, market, coin, clock, ctx);

    if (treasury.has_position(PROTOCOL_SCALLOP)) {
        let pos = capability::borrow_receipt_mut<T, ScallopPosition<T>>(treasury, PROTOCOL_SCALLOP);
        pos.scoin.join(scoin.into_balance());
    } else {
        let pos = ScallopPosition<T> { id: object::new(ctx), scoin: scoin.into_balance() };
        capability::custody_receipt(treasury, PROTOCOL_SCALLOP, pos);
    }
}

/// OWNER-ONLY: take the custodied sCoin position and redeem it back to underlying `Coin<T>`.
public fun owner_redeem<T>(
    treasury: &mut Treasury<T>,
    owner: &OwnerCap<T>,
    version: &Version,
    market: &mut Market,
    clock: &Clock,
    ctx: &mut TxContext,
): Coin<T> {
    let ScallopPosition { id, scoin } =
        capability::owner_take_receipt<T, ScallopPosition<T>>(treasury, owner, PROTOCOL_SCALLOP);
    id.delete();
    redeem::redeem<T>(version, market, scoin.into_coin(ctx), clock, ctx)
}
