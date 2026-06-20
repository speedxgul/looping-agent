/// Interface mirror of `protocol::market` — the shared `Market` object.
module protocol::market;

public struct Market has key, store {
    id: UID,
}
