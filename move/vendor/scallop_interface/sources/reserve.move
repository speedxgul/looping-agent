/// Interface mirror of `protocol::reserve` — the `MarketCoin` (sCoin) phantom type
/// that Scallop deposits mint (verified `has drop`).
module protocol::reserve;

public struct MarketCoin<phantom T> has drop {}
