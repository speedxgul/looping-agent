/// Interface mirror of `suilend::reserve` — only the type our adapter references.
/// `CToken<P, T>` is the protocol's internal cToken receipt (verified `has drop`).
module suilend::reserve;

public struct CToken<phantom P, phantom T> has drop {}
