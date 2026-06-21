/// REAL Suilend protocol adapter — its own package, depending only on `treasury_core` +
/// the real published Suilend `suilend`. No other protocol's deps, no diamond.
///
/// Supplies a verified bounded release into Suilend and custodies the withdrawal-gating
/// `ObligationOwnerCap` INSIDE the `Treasury`, so the agent can deposit but only the
/// `OwnerCap` holder can unwind. The minted cTokens and the owner-cap never reach the PTB.
///
/// Type params: `P` = Suilend lending-market type (mainnet `…::suilend::MAIN_POOL`),
/// `C` = underlying coin. `reserve_array_index` is resolved off-chain from the coin type.
module suilend_adapter::suilend_adapter;

use enclave::enclave::Enclave;
use suilend::lending_market::{Self, LendingMarket, ObligationOwnerCap};
use sui::clock::Clock;
use sui::coin::Coin;
use treasury_core::capability::{Self, Treasury, AgentCap, OwnerCap};
use treasury_core::decision::{Self, DecisionRegistry, DECISION};

/// Suilend protocol id. Bound to the `SUILEND` witness via `decision::register_adapter`.
const PROTOCOL_SUILEND: u8 = 0;

/// Adapter witness proving the caller is the registered Suilend adapter.
public struct SUILEND has drop {}

/// PTB entry: verify the enclave-signed ActionIntent (in core), then supply the released
/// bounded coin into Suilend, minting cTokens into an obligation whose owner-cap stays
/// custodied in the Treasury. First supply creates the obligation; later supplies deposit
/// into it. No `Coin`/cap reaches the host PTB.
public fun verified_supply_suilend_entry<P, C>(
    registry: &mut DecisionRegistry,
    treasury: &mut Treasury<C>,
    enclave: &Enclave<DECISION>,
    cap: &AgentCap<C>,
    lending_market: &mut LendingMarket<P>,
    reserve_array_index: u64,
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
    let (coin, ticket) = decision::verified_release<C, SUILEND>(
        SUILEND {}, registry, treasury, enclave, cap,
        schema_version, chain_id, treasury_id, agent_cap_id, nonce, expires_at_ms,
        action_kind, protocol_id, asset_type, amount, min_health_factor_bps,
        max_protocol_exposure, policy_hash, input_hash, rationale_hash,
        timestamp_ms, signature, clock, ctx,
    );
    let ctokens = lending_market::deposit_liquidity_and_mint_ctokens<P, C>(
        lending_market, reserve_array_index, clock, coin, ctx,
    );

    if (capability::ticket_has_position(treasury, &ticket)) {
        let obligation = capability::borrow_for_ticket<C, ObligationOwnerCap<P>>(treasury, &ticket);
        lending_market::deposit_ctokens_into_obligation<P, C>(
            lending_market, reserve_array_index, obligation, clock, ctokens, ctx,
        );
        capability::discharge_existing(treasury, ticket);
    } else {
        let obligation = lending_market::create_obligation<P>(lending_market, ctx);
        lending_market::deposit_ctokens_into_obligation<P, C>(
            lending_market, reserve_array_index, &obligation, clock, ctokens, ctx,
        );
        capability::custody_new(treasury, ticket, obligation);
    }
}

/// OWNER-ONLY: withdraw `amount` cTokens from the custodied obligation and recover the
/// underlying as a `Coin`. The owner-cap is taken under `OwnerCap` authority, used, then
/// re-custodied so the obligation survives partial unwinds.
public fun owner_redeem<P, C>(
    treasury: &mut Treasury<C>,
    owner: &OwnerCap<C>,
    lending_market: &mut LendingMarket<P>,
    reserve_array_index: u64,
    amount: u64,
    clock: &Clock,
    ctx: &mut TxContext,
): Coin<C> {
    let obligation = capability::owner_take_receipt<C, ObligationOwnerCap<P>>(
        treasury, owner, PROTOCOL_SUILEND,
    );
    let ctokens = lending_market::withdraw_ctokens<P, C>(
        lending_market, reserve_array_index, &obligation, clock, amount, ctx,
    );
    let redeemed = lending_market::redeem_ctokens_and_withdraw_liquidity<P, C>(
        lending_market, reserve_array_index, clock, ctokens, option::none(), ctx,
    );
    capability::owner_recustody(treasury, owner, PROTOCOL_SUILEND, obligation);
    redeemed
}
