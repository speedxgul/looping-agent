/// REAL Scallop protocol adapter — its own package, depending only on `treasury_core` +
/// the real published Scallop `protocol`. Sees no other lending protocol's deps, so no
/// dependency diamond forms.
///
/// Scallop's lending deposit returns a fungible `Coin<MarketCoin<T>>` (sCoin) where
/// possession IS redemption. The adapter mints the sCoin from a verified, bounded release
/// and custodies its `Balance` INSIDE the `Treasury` via the core hot-potato ticket, so the
/// agent can deposit but only the `OwnerCap` holder can redeem.
module scallop_adapter::scallop_adapter;

use enclave::enclave::Enclave;
use protocol::market::Market;
use protocol::mint;
use protocol::redeem;
use protocol::reserve::MarketCoin;
use protocol::version::Version;
use sui::balance::Balance;
use sui::clock::Clock;
use sui::coin::Coin;
use treasury_core::capability::{Self, Treasury, AgentCap, OwnerCap};
use treasury_core::decision::{Self, DecisionRegistry, DECISION};

/// Scallop protocol id. The deployer binds this id to the `SCALLOP` witness via
/// `decision::register_adapter`, so only this package can release for Scallop.
const PROTOCOL_SCALLOP: u8 = 1;

/// Adapter witness: presented to `decision::verified_release` to prove the caller is the
/// registered Scallop adapter.
public struct SCALLOP has drop {}

/// The custodied Scallop position: the sCoin balance held inside the Treasury.
public struct ScallopPosition<phantom T> has key, store {
    id: UID,
    scoin: Balance<MarketCoin<T>>,
}

/// PTB entry: verify the enclave-signed ActionIntent (in core), then supply the released
/// bounded coin into Scallop and custody the minted sCoin in the Treasury. Repeat supplies
/// accumulate into the same position. No `Coin` (underlying or sCoin) reaches the host PTB.
public fun verified_supply_scallop_entry<C>(
    registry: &mut DecisionRegistry,
    treasury: &mut Treasury<C>,
    enclave: &Enclave<DECISION>,
    cap: &AgentCap<C>,
    version: &Version,
    market: &mut Market,
    schema_version: u16,
    chain_id: vector<u8>,
    treasury_id: address,
    agent_cap_id: address,
    nonce: u64,
    expires_at_ms: u64,
    action_kind: u8,
    protocol_id: u8,
    asset_type: vector<u8>,
    amount: u64,
    min_health_factor_bps: u64,
    max_protocol_exposure: u64,
    policy_hash: vector<u8>,
    input_hash: vector<u8>,
    rationale_hash: vector<u8>,
    timestamp_ms: u64,
    signature: vector<u8>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    let (coin, ticket) = decision::verified_release<C, SCALLOP>(
        SCALLOP {}, registry, treasury, enclave, cap,
        schema_version, chain_id, treasury_id, agent_cap_id, nonce, expires_at_ms,
        action_kind, protocol_id, asset_type, amount, min_health_factor_bps,
        max_protocol_exposure, policy_hash, input_hash, rationale_hash,
        timestamp_ms, signature, clock, ctx,
    );
    let scoin = mint::mint<C>(version, market, coin, clock, ctx);

    if (capability::ticket_has_position(treasury, &ticket)) {
        let pos = capability::borrow_for_ticket<C, ScallopPosition<C>>(treasury, &ticket);
        pos.scoin.join(scoin.into_balance());
        capability::discharge_existing(treasury, ticket);
    } else {
        let pos = ScallopPosition<C> { id: object::new(ctx), scoin: scoin.into_balance() };
        capability::custody_new(treasury, ticket, pos);
    }
}

/// OWNER-ONLY: take the custodied sCoin position and redeem it back to underlying `Coin<C>`.
public fun owner_redeem<C>(
    treasury: &mut Treasury<C>,
    owner: &OwnerCap<C>,
    version: &Version,
    market: &mut Market,
    clock: &Clock,
    ctx: &mut TxContext,
): Coin<C> {
    let ScallopPosition { id, scoin } =
        capability::owner_take_receipt<C, ScallopPosition<C>>(treasury, owner, PROTOCOL_SCALLOP);
    id.delete();
    redeem::redeem<C>(version, market, scoin.into_coin(ctx), clock, ctx)
}
