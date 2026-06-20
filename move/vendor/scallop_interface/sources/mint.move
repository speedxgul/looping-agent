/// Interface mirror of `protocol::mint::mint` — Scallop's lending deposit: supply
/// `Coin<T>`, receive the fungible `Coin<MarketCoin<T>>` (sCoin) receipt.
module protocol::mint;

use sui::clock::Clock;
use sui::coin::Coin;
use protocol::market::Market;
use protocol::reserve::MarketCoin;
use protocol::version::Version;

public fun mint<T>(
    _version: &Version,
    _market: &mut Market,
    _coin: Coin<T>,
    _clock: &Clock,
    _ctx: &mut TxContext,
): Coin<MarketCoin<T>> {
    abort 0
}
