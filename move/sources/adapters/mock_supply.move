/// PLACEHOLDER protocol adapter. Releases a bounded coin and custodies the
/// resulting position INSIDE the treasury, returning no Coin to the PTB. Stands in
/// for the real Suilend `ObligationOwnerCap` / Scallop `sCoin` until the protocol
/// spike. The custody mechanics are identical regardless of protocol.
module treasury_agent::mock_supply;

use sui::balance::Balance;
use sui::clock::Clock;
use sui::coin::Coin;
use treasury_agent::capability::{Self, Treasury, AgentCap, OwnerCap};

/// Reserved protocol id for the mock adapter.
const PROTOCOL_MOCK: u8 = 255;

/// A stand-in "lending position" holding the deposited balance.
public struct MockPosition<phantom T> has key, store {
    id: UID,
    deposited: Balance<T>,
}

/// Release `amount` (bounds enforced by capability) and custody the position in the
/// treasury. No Coin is returned to the PTB.
public fun supply_and_custody<T>(
    treasury: &mut Treasury<T>,
    cap: &AgentCap<T>,
    amount: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    // Bounds (active agent, per-tx cap, period cap, expiry) enforced here.
    let coin = capability::release_for_action(treasury, cap, amount, clock, ctx);

    if (treasury.has_position(PROTOCOL_MOCK)) {
        let pos = capability::borrow_receipt_mut<T, MockPosition<T>>(treasury, PROTOCOL_MOCK);
        pos.deposited.join(coin.into_balance());
    } else {
        let pos = MockPosition<T> { id: object::new(ctx), deposited: coin.into_balance() };
        capability::custody_receipt(treasury, PROTOCOL_MOCK, pos);
    }
}

/// OWNER-ONLY: take the position back and recover its funds as a Coin.
public fun owner_redeem<T>(
    treasury: &mut Treasury<T>,
    owner: &OwnerCap<T>,
    ctx: &mut TxContext,
): Coin<T> {
    let MockPosition { id, deposited } =
        capability::owner_take_receipt<T, MockPosition<T>>(treasury, owner, PROTOCOL_MOCK);
    id.delete();
    deposited.into_coin(ctx)
}

// === Tests ===

#[test_only]
use sui::coin::mint_for_testing;
#[test_only]
use sui::sui::SUI;
#[test_only]
use std::unit_test::{assert_eq, destroy};

#[test_only]
const DAY_MS: u64 = 86_400_000;

/// A supply moves funds out of the treasury balance and into a custodied position.
#[test]
fun supply_custodies_and_drains_balance() {
    let mut ctx = tx_context::dummy();
    let clock = sui::clock::create_for_testing(&mut ctx);
    let funds = mint_for_testing<SUI>(1_000, &mut ctx);
    let (mut treasury, owner_cap, agent_cap) =
        capability::new<SUI>(funds, 100, 300, DAY_MS, DAY_MS, &clock, &mut ctx);

    supply_and_custody(&mut treasury, &agent_cap, 100, &clock, &mut ctx);

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

    supply_and_custody(&mut treasury, &agent_cap, 100, &clock, &mut ctx);
    let recovered = owner_redeem(&mut treasury, &owner_cap, &mut ctx);

    assert_eq!(recovered.value(), 100);
    assert!(!treasury.has_position(PROTOCOL_MOCK));

    destroy(recovered);
    destroy(treasury);
    destroy(owner_cap);
    destroy(agent_cap);
    clock.destroy_for_testing();
}

/// Two supplies accumulate into the SAME position (one obligation per protocol).
#[test]
fun supplies_accumulate_in_one_position() {
    let mut ctx = tx_context::dummy();
    let clock = sui::clock::create_for_testing(&mut ctx);
    let funds = mint_for_testing<SUI>(1_000, &mut ctx);
    let (mut treasury, owner_cap, agent_cap) =
        capability::new<SUI>(funds, 100, 1_000, DAY_MS, DAY_MS, &clock, &mut ctx);

    supply_and_custody(&mut treasury, &agent_cap, 100, &clock, &mut ctx);
    supply_and_custody(&mut treasury, &agent_cap, 100, &clock, &mut ctx);

    assert_eq!(treasury.balance(), 800);
    let recovered = owner_redeem(&mut treasury, &owner_cap, &mut ctx);
    assert_eq!(recovered.value(), 200);

    destroy(recovered);
    destroy(treasury);
    destroy(owner_cap);
    destroy(agent_cap);
    clock.destroy_for_testing();
}

#[test_only]
public struct FAKE_USDC has drop {}

/// Two users with DIFFERENT coin types: positions and balances are fully isolated,
/// and the caps are distinct types (AgentCap<SUI> vs AgentCap<FAKE_USDC>).
#[test]
fun two_coin_types_are_isolated() {
    let mut ctx = tx_context::dummy();
    let clock = sui::clock::create_for_testing(&mut ctx);

    let sui_funds = mint_for_testing<SUI>(1_000, &mut ctx);
    let (mut t_sui, oc_sui, ac_sui) =
        capability::new<SUI>(sui_funds, 100, 300, DAY_MS, DAY_MS, &clock, &mut ctx);
    let usdc_funds = mint_for_testing<FAKE_USDC>(1_000, &mut ctx);
    let (t_usdc, oc_usdc, ac_usdc) =
        capability::new<FAKE_USDC>(usdc_funds, 100, 300, DAY_MS, DAY_MS, &clock, &mut ctx);

    supply_and_custody(&mut t_sui, &ac_sui, 100, &clock, &mut ctx);

    assert!(t_sui.has_position(PROTOCOL_MOCK));
    assert!(!t_usdc.has_position(PROTOCOL_MOCK));
    assert_eq!(t_sui.balance(), 900);
    assert_eq!(t_usdc.balance(), 1_000);

    destroy(t_sui); destroy(oc_sui); destroy(ac_sui);
    destroy(t_usdc); destroy(oc_usdc); destroy(ac_usdc);
    clock.destroy_for_testing();
}

/// Two independent treasuries (two users): positions are fully isolated.
#[test]
fun two_treasuries_are_isolated() {
    let mut ctx = tx_context::dummy();
    let clock = sui::clock::create_for_testing(&mut ctx);

    let funds_a = mint_for_testing<SUI>(1_000, &mut ctx);
    let (mut ta, oca, aca) =
        capability::new<SUI>(funds_a, 100, 300, DAY_MS, DAY_MS, &clock, &mut ctx);
    let funds_b = mint_for_testing<SUI>(1_000, &mut ctx);
    let (tb, ocb, acb) =
        capability::new<SUI>(funds_b, 100, 300, DAY_MS, DAY_MS, &clock, &mut ctx);

    supply_and_custody(&mut ta, &aca, 100, &clock, &mut ctx);

    assert!(ta.has_position(PROTOCOL_MOCK));
    assert!(!tb.has_position(PROTOCOL_MOCK));
    assert_eq!(ta.balance(), 900);
    assert_eq!(tb.balance(), 1_000);

    destroy(ta); destroy(oca); destroy(aca);
    destroy(tb); destroy(ocb); destroy(acb);
    clock.destroy_for_testing();
}
