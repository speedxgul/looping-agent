/// Interface mirror of NAVI's `oracle::oracle` — the shared `PriceOracle` object that
/// NAVI's withdraw/borrow operations require for a price refresh.
module oracle::oracle;

public struct PriceOracle has key {
    id: UID,
}
