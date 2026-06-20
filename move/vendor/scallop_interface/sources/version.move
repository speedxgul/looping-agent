/// Interface mirror of `protocol::version` — the shared `Version` guard object.
module protocol::version;

public struct Version has key, store {
    id: UID,
}
