/// Interface mirror of `protocol::redeem::redeem` — burn the `Coin<MarketCoin<T>>`
/// (sCoin) receipt to withdraw the underlying `Coin<T>` (principal + interest).
module protocol::redeem;

use sui::clock::Clock;
use sui::coin::Coin;
use protocol::market::Market;
use protocol::reserve::MarketCoin;
use protocol::version::Version;

public fun redeem<T>(
    _version: &Version,
    _market: &mut Market,
    _coin: Coin<MarketCoin<T>>,
    _clock: &Clock,
    _ctx: &mut TxContext,
): Coin<T> {
    abort 0
}
