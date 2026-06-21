/// PLACEHOLDER protocol adapter (testnet/demo). Its own package, depending only on
/// `treasury_core` — no protocol deps. Releases a bounded coin via the core verified path
/// and custodies the resulting position INSIDE the treasury, returning no Coin to the PTB.
/// The custody mechanics mirror the real adapters; useful where no protocol market exists.
module mock_adapter::mock_supply;

use enclave::enclave::Enclave;
use sui::balance::Balance;
use sui::clock::Clock;
use sui::coin::Coin;
use treasury_core::capability::{Self, Treasury, AgentCap, OwnerCap, ReleaseTicket};
use treasury_core::decision::{Self, DecisionRegistry, DECISION};

/// Reserved protocol id for the mock adapter.
const PROTOCOL_MOCK: u8 = 255;

/// Adapter witness proving the caller is the registered mock adapter.
public struct MOCK has drop {}

/// A stand-in "lending position" holding the deposited balance.
public struct MockPosition<phantom T> has key, store {
    id: UID,
    deposited: Balance<T>,
}

/// PTB entry: verify the enclave-signed ActionIntent (in core), then custody the released
/// bounded coin as a mock position. No Coin is returned to the PTB.
public fun verified_supply_mock_entry<C>(
    registry: &mut DecisionRegistry,
    treasury: &mut Treasury<C>,
    enclave: &Enclave<DECISION>,
    cap: &AgentCap<C>,
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
    let (coin, ticket) = decision::verified_release<C, MOCK>(
        MOCK {}, registry, treasury, enclave, cap,
        schema_version, chain_id, treasury_id, agent_cap_id, nonce, expires_at_ms,
        action_kind, protocol_id, asset_type, amount, min_health_factor_bps,
        max_protocol_exposure, policy_hash, input_hash, rationale_hash,
        timestamp_ms, signature, clock, ctx,
    );
    deposit_and_custody(treasury, coin, ticket, ctx);
}

/// Shared custody logic (also exercised by unit tests via a test-minted ticket).
fun deposit_and_custody<C>(
    treasury: &mut Treasury<C>,
    coin: Coin<C>,
    ticket: ReleaseTicket,
    ctx: &mut TxContext,
) {
    if (capability::ticket_has_position(treasury, &ticket)) {
        let pos = capability::borrow_for_ticket<C, MockPosition<C>>(treasury, &ticket);
        pos.deposited.join(coin.into_balance());
        capability::discharge_existing(treasury, ticket);
    } else {
        let pos = MockPosition<C> { id: object::new(ctx), deposited: coin.into_balance() };
        capability::custody_new(treasury, ticket, pos);
    }
}

/// OWNER-ONLY: take the position back and recover its funds as a Coin.
public fun owner_redeem<C>(
    treasury: &mut Treasury<C>,
    owner: &OwnerCap<C>,
    ctx: &mut TxContext,
): Coin<C> {
    let MockPosition { id, deposited } =
        capability::owner_take_receipt<C, MockPosition<C>>(treasury, owner, PROTOCOL_MOCK);
    id.delete();
    deposited.into_coin(ctx)
}

// === Tests ===
// These drive the custody flow through a test-minted ReleaseTicket (the signature/allowlist
// gate itself is covered by treasury_core::decision's tests).

#[test_only]
use sui::coin::mint_for_testing;
#[test_only]
use sui::sui::SUI;
#[test_only]
use std::unit_test::{assert_eq, destroy};

#[test_only]
const DAY_MS: u64 = 86_400_000;

#[test_only]
fun supply_via_test_ticket<C>(
    treasury: &mut Treasury<C>,
    cap: &AgentCap<C>,
    amount: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    let (coin, ticket) =
        capability::release_with_ticket_for_testing(treasury, cap, PROTOCOL_MOCK, amount, clock, ctx);
    deposit_and_custody(treasury, coin, ticket, ctx);
}

/// A supply moves funds out of the treasury balance and into a custodied position.
#[test]
fun supply_custodies_and_drains_balance() {
    let mut ctx = tx_context::dummy();
    let clock = sui::clock::create_for_testing(&mut ctx);
    let funds = mint_for_testing<SUI>(1_000, &mut ctx);
    let (mut treasury, owner_cap, agent_cap) =
        capability::new<SUI>(funds, 100, 300, DAY_MS, DAY_MS, &clock, &mut ctx);

    supply_via_test_ticket(&mut treasury, &agent_cap, 100, &clock, &mut ctx);

    assert_eq!(treasury.balance(), 900);
    assert!(treasury.has_position(PROTOCOL_MOCK));

    destroy(treasury);
    destroy(owner_cap);
    destroy(agent_cap);
    clock.destroy_for_testing();
}

/// The owner can recover funds; the position is gone afterwards.
#[test]
fun owner_redeems_funds() {
    let mut ctx = tx_context::dummy();
    let clock = sui::clock::create_for_testing(&mut ctx);
    let funds = mint_for_testing<SUI>(1_000, &mut ctx);
    let (mut treasury, owner_cap, agent_cap) =
        capability::new<SUI>(funds, 100, 300, DAY_MS, DAY_MS, &clock, &mut ctx);

    supply_via_test_ticket(&mut treasury, &agent_cap, 100, &clock, &mut ctx);
    let recovered = owner_redeem(&mut treasury, &owner_cap, &mut ctx);

    assert_eq!(recovered.value(), 100);
    assert!(!treasury.has_position(PROTOCOL_MOCK));

    destroy(recovered);
    destroy(treasury);
    destroy(owner_cap);
    destroy(agent_cap);
    clock.destroy_for_testing();
}

/// Two supplies accumulate into the SAME position (one position per protocol).
#[test]
fun supplies_accumulate_in_one_position() {
    let mut ctx = tx_context::dummy();
    let clock = sui::clock::create_for_testing(&mut ctx);
    let funds = mint_for_testing<SUI>(1_000, &mut ctx);
    let (mut treasury, owner_cap, agent_cap) =
        capability::new<SUI>(funds, 100, 1_000, DAY_MS, DAY_MS, &clock, &mut ctx);

    supply_via_test_ticket(&mut treasury, &agent_cap, 100, &clock, &mut ctx);
    supply_via_test_ticket(&mut treasury, &agent_cap, 100, &clock, &mut ctx);

    assert_eq!(treasury.balance(), 800);
    let recovered = owner_redeem(&mut treasury, &owner_cap, &mut ctx);
    assert_eq!(recovered.value(), 200);

    destroy(recovered);
    destroy(treasury);
    destroy(owner_cap);
    destroy(agent_cap);
    clock.destroy_for_testing();
}
