/// Non-custodial treasury with a scoped, revocable agent capability.
///
/// Funds live in a `Treasury` object the owner controls via an `OwnerCap`. The
/// agent holds an `AgentCap` that authorises *bounded* fund release — capped per
/// transaction and per rolling window, expiring at a deadline — but can never
/// withdraw principal and is revocable by the owner at any time.
///
/// SPLIT ARCHITECTURE: this core package is protocol-free. The bounded release returns
/// a `Coin<T>` PLUS a `ReleaseTicket` hot-potato (no abilities → MUST be discharged in
/// the same tx) to an out-of-package protocol adapter, which supplies the coin and then
/// custodies the resulting receipt back INTO the treasury via the ticket. The ticket is
/// only mintable by `decision::verified_release` (enclave-signature + adapter-allowlist
/// gated), so an arbitrary PTB can never obtain a raw coin from the treasury.
module treasury_core::capability;

use sui::balance::Balance;
use sui::clock::Clock;
use sui::coin::Coin;
use sui::dynamic_object_field as dof;
use sui::event;

// === Errors ===

#[error]
const EWrongTreasury: vector<u8> = b"Capability does not belong to this treasury";
#[error]
const ENotActiveAgent: vector<u8> = b"AgentCap is not the treasury's active agent (revoked or replaced)";
#[error]
const ECapabilityExpired: vector<u8> = b"AgentCap has expired";
#[error]
const EExceedsPerTxCap: vector<u8> = b"Amount exceeds the per-transaction cap";
#[error]
const EExceedsPeriodCap: vector<u8> = b"Amount exceeds the rolling-period spend cap";
#[error]
const EPositionAlreadyExists: vector<u8> = b"A position is already custodied for this protocol";
#[error]
const ENoPositionForProtocol: vector<u8> = b"No custodied position for this protocol";

// === Structs ===

/// Shared treasury holding the owner's funds plus the agent's spend bounds.
public struct Treasury<phantom T> has key {
    id: UID,
    owner: address,
    /// The currently authorised AgentCap id; `none` once revoked.
    agent: Option<ID>,
    funds: Balance<T>,
    per_tx_cap: u64,
    period_cap: u64,
    period_ms: u64,
    expiry_ms: u64,
    spent_in_period: u64,
    period_start_ms: u64,
}

/// Held by the owner. Authorises revocation and principal withdrawal.
public struct OwnerCap<phantom T> has key, store {
    id: UID,
    treasury: ID,
}

/// Held by the agent. Authorises bounded, non-custodial fund release only.
public struct AgentCap<phantom T> has key, store {
    id: UID,
    treasury: ID,
}

/// Key for a protocol position receipt held inside the Treasury, one per protocol.
public struct PositionKey(u8) has copy, drop, store;

/// Hot-potato proof of a verified, bounded release. Has NO abilities, so the adapter
/// that receives it (alongside the released `Coin`) MUST discharge it in the same tx —
/// either by custodying a fresh receipt (`custody_new`) or by depositing into an
/// existing custodied position (`borrow_for_ticket` + `discharge_existing`). This is
/// what forces every release to end as a treasury-held position (never loose funds).
public struct ReleaseTicket {
    treasury_id: ID,
    protocol_id: u8,
}

// === Events (on-chain receipts) ===

public struct TreasuryCreated has copy, drop {
    treasury: ID,
    owner: address,
    agent: ID,
}

public struct FundsReleased has copy, drop {
    treasury: ID,
    amount: u64,
    spent_in_period: u64,
}

public struct AgentRevoked has copy, drop {
    treasury: ID,
}

public struct PrincipalWithdrawn has copy, drop {
    treasury: ID,
    amount: u64,
}

// === Create ===

/// Create a bounded treasury. Pure/composable: returns the objects so the caller
/// (or `create` below) decides ownership.
public fun new<T>(
    funds: Coin<T>,
    per_tx_cap: u64,
    period_cap: u64,
    period_ms: u64,
    expiry_ms: u64,
    clock: &Clock,
    ctx: &mut TxContext,
): (Treasury<T>, OwnerCap<T>, AgentCap<T>) {
    let id = object::new(ctx);
    let treasury_id = id.to_inner();
    let agent_cap = AgentCap<T> { id: object::new(ctx), treasury: treasury_id };
    let owner_cap = OwnerCap<T> { id: object::new(ctx), treasury: treasury_id };

    let treasury = Treasury<T> {
        id,
        owner: ctx.sender(),
        agent: option::some(object::id(&agent_cap)),
        funds: funds.into_balance(),
        per_tx_cap,
        period_cap,
        period_ms,
        expiry_ms,
        spent_in_period: 0,
        period_start_ms: clock.timestamp_ms(),
    };

    event::emit(TreasuryCreated {
        treasury: treasury_id,
        owner: ctx.sender(),
        agent: object::id(&agent_cap),
    });

    (treasury, owner_cap, agent_cap)
}

/// Transaction endpoint: create, share the treasury, send the OwnerCap to the
/// sender and the AgentCap to the delegated agent address.
entry fun create<T>(
    funds: Coin<T>,
    per_tx_cap: u64,
    period_cap: u64,
    period_ms: u64,
    expiry_ms: u64,
    agent: address,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    let (treasury, owner_cap, agent_cap) = new<T>(
        funds,
        per_tx_cap,
        period_cap,
        period_ms,
        expiry_ms,
        clock,
        ctx,
    );
    transfer::share_object(treasury);
    transfer::public_transfer(owner_cap, ctx.sender());
    transfer::public_transfer(agent_cap, agent);
}

// === Agent action (bounded, non-custodial) ===

/// Release up to `amount` and mint a `ReleaseTicket` binding the release to `protocol_id`.
/// Package-internal: only `decision::verified_release` (after an enclave-signature +
/// adapter-allowlist check) calls this, so the raw coin can never escape to an arbitrary
/// PTB. Enforces: cap is the active agent, not expired, within per-tx and rolling-period
/// caps. The returned ticket has no abilities, forcing the caller to custody.
public(package) fun release_with_ticket<T>(
    treasury: &mut Treasury<T>,
    cap: &AgentCap<T>,
    protocol_id: u8,
    amount: u64,
    clock: &Clock,
    ctx: &mut TxContext,
): (Coin<T>, ReleaseTicket) {
    assert!(cap.treasury == object::id(treasury), EWrongTreasury);
    assert!(treasury.agent == option::some(object::id(cap)), ENotActiveAgent);

    let now = clock.timestamp_ms();
    assert!(now < treasury.expiry_ms, ECapabilityExpired);
    assert!(amount <= treasury.per_tx_cap, EExceedsPerTxCap);

    // Roll the spend window if the current period has elapsed.
    if (now >= treasury.period_start_ms + treasury.period_ms) {
        treasury.period_start_ms = now;
        treasury.spent_in_period = 0;
    };
    assert!(treasury.spent_in_period + amount <= treasury.period_cap, EExceedsPeriodCap);
    treasury.spent_in_period = treasury.spent_in_period + amount;

    event::emit(FundsReleased {
        treasury: object::id(treasury),
        amount,
        spent_in_period: treasury.spent_in_period,
    });

    let coin = treasury.funds.split(amount).into_coin(ctx);
    let ticket = ReleaseTicket { treasury_id: object::id(treasury), protocol_id };
    (coin, ticket)
}

// === Receipt custody (ticket-gated, cross-package) ===

/// True if the ticket's protocol already has a custodied position. Adapters branch on
/// this: deposit into the existing position vs. create a new one.
public fun ticket_has_position<T>(treasury: &Treasury<T>, ticket: &ReleaseTicket): bool {
    assert!(ticket.treasury_id == object::id(treasury), EWrongTreasury);
    dof::exists_(&treasury.id, PositionKey(ticket.protocol_id))
}

/// Discharge a ticket by custodying a FRESH receipt under its protocol (first supply).
/// Consumes the ticket; aborts if a position already exists.
public fun custody_new<T, R: key + store>(
    treasury: &mut Treasury<T>,
    ticket: ReleaseTicket,
    receipt: R,
) {
    let ReleaseTicket { treasury_id, protocol_id } = ticket;
    assert!(treasury_id == object::id(treasury), EWrongTreasury);
    assert!(!dof::exists_(&treasury.id, PositionKey(protocol_id)), EPositionAlreadyExists);
    dof::add(&mut treasury.id, PositionKey(protocol_id), receipt);
}

/// Borrow the existing custodied receipt mutably so an adapter can deposit into it.
/// Ticket-gated (only obtainable from a verified release). Pair with `discharge_existing`.
public fun borrow_for_ticket<T, R: key + store>(
    treasury: &mut Treasury<T>,
    ticket: &ReleaseTicket,
): &mut R {
    assert!(ticket.treasury_id == object::id(treasury), EWrongTreasury);
    assert!(dof::exists_(&treasury.id, PositionKey(ticket.protocol_id)), ENoPositionForProtocol);
    dof::borrow_mut(&mut treasury.id, PositionKey(ticket.protocol_id))
}

/// Discharge a ticket after depositing into an already-custodied position. Consumes the
/// ticket; aborts if no position exists for the protocol.
public fun discharge_existing<T>(treasury: &Treasury<T>, ticket: ReleaseTicket) {
    let ReleaseTicket { treasury_id, protocol_id } = ticket;
    assert!(treasury_id == object::id(treasury), EWrongTreasury);
    assert!(dof::exists_(&treasury.id, PositionKey(protocol_id)), ENoPositionForProtocol);
}

/// True if a position for `protocol_id` is already custodied.
public fun has_position<T>(treasury: &Treasury<T>, protocol_id: u8): bool {
    dof::exists_(&treasury.id, PositionKey(protocol_id))
}

// === Owner operations ===

/// OWNER-ONLY: remove the custodied receipt (to unwind / withdraw). Requires the
/// OwnerCap, so the agent can never reach it.
public fun owner_take_receipt<T, R: key + store>(
    treasury: &mut Treasury<T>,
    owner: &OwnerCap<T>,
    protocol_id: u8,
): R {
    assert!(owner.treasury == object::id(treasury), EWrongTreasury);
    assert!(dof::exists_(&treasury.id, PositionKey(protocol_id)), ENoPositionForProtocol);
    dof::remove(&mut treasury.id, PositionKey(protocol_id))
}

/// OWNER-ONLY: re-custody a receipt the owner previously took (e.g. after a partial
/// withdraw, so the protocol account/obligation survives). OwnerCap-gated.
public fun owner_recustody<T, R: key + store>(
    treasury: &mut Treasury<T>,
    owner: &OwnerCap<T>,
    protocol_id: u8,
    receipt: R,
) {
    assert!(owner.treasury == object::id(treasury), EWrongTreasury);
    assert!(!dof::exists_(&treasury.id, PositionKey(protocol_id)), EPositionAlreadyExists);
    dof::add(&mut treasury.id, PositionKey(protocol_id), receipt);
}

/// Revoke the agent. After this, `release_with_ticket` aborts with `ENotActiveAgent`.
public fun revoke<T>(treasury: &mut Treasury<T>, owner: &OwnerCap<T>) {
    assert!(owner.treasury == object::id(treasury), EWrongTreasury);
    treasury.agent = option::none();
    event::emit(AgentRevoked { treasury: object::id(treasury) });
}

/// Owner-only principal withdrawal — the agent can never call this.
public fun withdraw_principal<T>(
    treasury: &mut Treasury<T>,
    owner: &OwnerCap<T>,
    amount: u64,
    ctx: &mut TxContext,
): Coin<T> {
    assert!(owner.treasury == object::id(treasury), EWrongTreasury);
    event::emit(PrincipalWithdrawn { treasury: object::id(treasury), amount });
    treasury.funds.split(amount).into_coin(ctx)
}

/// Top up the treasury (anyone may add funds; only the owner may withdraw).
public fun deposit<T>(treasury: &mut Treasury<T>, funds: Coin<T>) {
    treasury.funds.join(funds.into_balance());
}

// === Getters ===

public fun balance<T>(treasury: &Treasury<T>): u64 {
    treasury.funds.value()
}

public fun owner<T>(treasury: &Treasury<T>): address {
    treasury.owner
}

public fun is_agent_active<T>(treasury: &Treasury<T>, cap: &AgentCap<T>): bool {
    treasury.agent == option::some(object::id(cap))
}

// === Test-only helpers (used by adapter packages' tests too) ===

/// Mint a ReleaseTicket directly, bypassing the signature/allowlist gate. For unit tests
/// of adapters that can't construct an `Enclave`/signature off-chain.
#[test_only]
public fun release_with_ticket_for_testing<T>(
    treasury: &mut Treasury<T>,
    cap: &AgentCap<T>,
    protocol_id: u8,
    amount: u64,
    clock: &Clock,
    ctx: &mut TxContext,
): (Coin<T>, ReleaseTicket) {
    release_with_ticket(treasury, cap, protocol_id, amount, clock, ctx)
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

#[test_only]
public struct DummyReceipt has key, store { id: UID }

#[test]
fun release_within_bounds() {
    let mut ctx = tx_context::dummy();
    let clock = sui::clock::create_for_testing(&mut ctx);
    let funds = mint_for_testing<SUI>(1_000, &mut ctx);

    let (mut treasury, owner_cap, agent_cap) = new<SUI>(funds, 100, 300, DAY_MS, DAY_MS, &clock, &mut ctx);

    let (released, ticket) = treasury.release_with_ticket(&agent_cap, 1, 100, &clock, &mut ctx);
    assert_eq!(released.value(), 100);
    assert_eq!(treasury.balance(), 900);

    // Discharge the ticket by custodying a dummy position.
    custody_new(&mut treasury, ticket, DummyReceipt { id: object::new(&mut ctx) });
    assert!(has_position(&treasury, 1));

    destroy(released);
    destroy(treasury);
    destroy(owner_cap);
    destroy(agent_cap);
    clock.destroy_for_testing();
}

#[test, expected_failure(abort_code = EExceedsPerTxCap)]
fun release_over_per_tx_cap_aborts() {
    let mut ctx = tx_context::dummy();
    let clock = sui::clock::create_for_testing(&mut ctx);
    let funds = mint_for_testing<SUI>(1_000, &mut ctx);
    let (mut treasury, _owner_cap, agent_cap) = new<SUI>(funds, 100, 300, DAY_MS, DAY_MS, &clock, &mut ctx);

    // 101 > per_tx_cap of 100 — aborts here.
    let (_c, _t) = treasury.release_with_ticket(&agent_cap, 1, 101, &clock, &mut ctx);
    abort
}

#[test, expected_failure(abort_code = ENotActiveAgent)]
fun release_after_revoke_aborts() {
    let mut ctx = tx_context::dummy();
    let clock = sui::clock::create_for_testing(&mut ctx);
    let funds = mint_for_testing<SUI>(1_000, &mut ctx);
    let (mut treasury, owner_cap, agent_cap) = new<SUI>(funds, 100, 300, DAY_MS, DAY_MS, &clock, &mut ctx);

    treasury.revoke(&owner_cap);
    // Agent is revoked — aborts here.
    let (_c, _t) = treasury.release_with_ticket(&agent_cap, 1, 50, &clock, &mut ctx);
    abort
}

/// custody_new stores a position; has_position sees it; owner_take_receipt (OwnerCap-gated)
/// removes it. There is intentionally NO function that lets an AgentCap holder take a
/// custodied receipt.
#[test]
fun custody_store_and_owner_take() {
    let mut ctx = tx_context::dummy();
    let clock = sui::clock::create_for_testing(&mut ctx);
    let funds = mint_for_testing<SUI>(1_000, &mut ctx);
    let (mut treasury, owner_cap, agent_cap) =
        new<SUI>(funds, 100, 300, DAY_MS, DAY_MS, &clock, &mut ctx);

    let (released, ticket) = treasury.release_with_ticket(&agent_cap, 7, 100, &clock, &mut ctx);
    assert!(!has_position(&treasury, 7));
    custody_new(&mut treasury, ticket, DummyReceipt { id: object::new(&mut ctx) });
    assert!(has_position(&treasury, 7));

    let DummyReceipt { id } =
        owner_take_receipt<SUI, DummyReceipt>(&mut treasury, &owner_cap, 7);
    id.delete();
    assert!(!has_position(&treasury, 7));

    destroy(released);
    destroy(treasury);
    destroy(owner_cap);
    destroy(agent_cap);
    clock.destroy_for_testing();
}

#[test, expected_failure(abort_code = EWrongTreasury)]
fun owner_take_receipt_wrong_cap_aborts() {
    let mut ctx = tx_context::dummy();
    let clock = sui::clock::create_for_testing(&mut ctx);

    let funds_a = mint_for_testing<SUI>(1_000, &mut ctx);
    let (mut ta, _oca, aca) = new<SUI>(funds_a, 100, 300, DAY_MS, DAY_MS, &clock, &mut ctx);
    let (ca, ticket) = ta.release_with_ticket(&aca, 7, 100, &clock, &mut ctx);
    custody_new(&mut ta, ticket, DummyReceipt { id: object::new(&mut ctx) });

    let funds_b = mint_for_testing<SUI>(1_000, &mut ctx);
    let (_tb, ocb, _acb) = new<SUI>(funds_b, 100, 300, DAY_MS, DAY_MS, &clock, &mut ctx);

    // Treasury B's OwnerCap used on Treasury A — aborts with EWrongTreasury.
    destroy(ca);
    let DummyReceipt { id } = owner_take_receipt<SUI, DummyReceipt>(&mut ta, &ocb, 7);
    id.delete();
    abort
}
