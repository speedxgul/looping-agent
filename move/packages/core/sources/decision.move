/// Attested execution: gate a bounded fund release on a decision signed by the
/// registered TEE enclave. This is the third trust layer, in front of the
/// capability's own bounds (capability.move) — no single layer is trusted.
///
/// SPLIT ARCHITECTURE: this module is protocol-free. It verifies the enclave signature
/// over the canonical `ActionIntent`, checks an on-chain adapter allowlist that binds the
/// intent's `protocol_id` to a specific adapter witness type, then releases a bounded
/// `Coin` + `ReleaseTicket` to the calling adapter package. The adapter (a separate
/// package depending only on this core + its one protocol) supplies the coin and discharges
/// the ticket by custodying the protocol receipt — so the diamond of conflicting protocol
/// deps never forms in one package, yet the non-custodial guarantee holds across the boundary.
module treasury_core::decision;

use enclave::enclave::{Self, Enclave, Cap};
use std::type_name::{Self, TypeName};
use sui::clock::Clock;
use sui::coin::Coin;
use sui::table::{Self, Table};
use treasury_core::capability::{Self, AgentCap, Treasury, ReleaseTicket};

/// Domain separator so an enclave signature for one app can't be replayed in another.
const DECISION_INTENT: u8 = 0;
/// v1 action_kind: supply.
const ACTION_SUPPLY: u8 = 0;

#[error]
const EInvalidSignature: vector<u8> = b"Decision is not signed by the registered enclave";
#[error]
const EReplayedOrStaleNonce: vector<u8> = b"Decision nonce was already consumed or is stale (replay)";
#[error]
const EWrongTreasuryIntent: vector<u8> = b"ActionIntent does not target this treasury";
#[error]
const EWrongAgentCap: vector<u8> = b"ActionIntent does not authorize this AgentCap";
#[error]
const EIntentExpired: vector<u8> = b"ActionIntent has expired";
#[error]
const EUnsupportedAction: vector<u8> = b"Unsupported action_kind";
#[error]
const EUnsupportedProtocol: vector<u8> = b"No adapter registered for this protocol_id";
#[error]
const EWrongAdapter: vector<u8> = b"Caller witness is not the registered adapter for this protocol_id";

/// One-time witness binding the registered `Enclave<DECISION>` to this app.
public struct DECISION has drop {}

/// What the enclave signs in the simple-envelope path. Field order/types MUST match the
/// enclave's BCS serialization exactly. (Kept for wire-format parity / legacy verification.)
public struct DecisionPayload has copy, drop {
    treasury: ID,
    amount: u64,
    nonce: u64,
}

/// The full product action schema (design §10). Field order MUST match the BCS in
/// agent/src/core/actionIntent.ts and enclave/app/action_intent.ts.
public struct ActionIntent has copy, drop {
    schema_version: u16,
    chain_id: vector<u8>,
    treasury_id: ID,
    agent_cap_id: ID,
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
}

/// Tracks the highest decision nonce consumed per treasury (replay protection) and the
/// allowlist binding each `protocol_id` to the adapter witness type permitted to release
/// for it. Registering adapters is gated by the `Cap<DECISION>` (held by the deployer).
public struct DecisionRegistry has key {
    id: UID,
    last_nonce: Table<ID, u64>,
    adapters: Table<u8, TypeName>,
}

fun init(otw: DECISION, ctx: &mut TxContext) {
    // The deployer holds the Cap to create/update the EnclaveConfig (PCRs) AND register adapters.
    transfer::public_transfer(enclave::new_cap(otw, ctx), ctx.sender());
    transfer::share_object(DecisionRegistry {
        id: object::new(ctx),
        last_nonce: table::new(ctx),
        adapters: table::new(ctx),
    });
}

/// Bind `protocol_id` to the adapter witness type `W`. Only that adapter package can then
/// pass a `W {}` to `verified_release` for this protocol. Cap-gated (deployer-only).
/// Idempotent: re-registering overwrites (lets the owner swap adapter implementations).
public fun register_adapter<W: drop>(
    registry: &mut DecisionRegistry,
    _cap: &Cap<DECISION>,
    protocol_id: u8,
) {
    let tn = type_name::get<W>();
    if (registry.adapters.contains(protocol_id)) {
        *registry.adapters.borrow_mut(protocol_id) = tn;
    } else {
        registry.adapters.add(protocol_id, tn);
    };
}

/// True if an adapter is registered for `protocol_id`.
public fun adapter_registered(registry: &DecisionRegistry, protocol_id: u8): bool {
    registry.adapters.contains(protocol_id)
}

/// THE attested release primitive. Verify the enclave signature over the canonical
/// ActionIntent, check the witness `W` is the registered adapter for `protocol_id`, consume
/// the nonce, then release the bounded coin + a `ReleaseTicket`. The caller (an adapter
/// package) supplies the coin into its protocol and discharges the ticket via
/// `capability::custody_new` / `borrow_for_ticket` + `discharge_existing`. Returns into the
/// PTB so supply + custody compose in the same transaction.
///
/// Type args: `<C (treasury coin), W (adapter witness)>`.
public fun verified_release<C, W: drop>(
    _witness: W,
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
): (Coin<C>, ReleaseTicket) {
    let intent = build_intent(
        schema_version, chain_id, treasury_id, agent_cap_id, nonce, expires_at_ms,
        action_kind, protocol_id, asset_type, amount, min_health_factor_bps,
        max_protocol_exposure, policy_hash, input_hash, rationale_hash,
    );

    // 1. Enclave signature over the canonical intent.
    assert!(
        enclave.verify_signature(DECISION_INTENT, timestamp_ms, intent, &signature),
        EInvalidSignature,
    );

    // 2. Intent binding + expiry + action.
    assert_intent_valid(&intent, treasury, cap, clock);

    // 3. Adapter allowlist: the calling witness MUST be the one registered for this protocol.
    assert!(registry.adapters.contains(intent.protocol_id), EUnsupportedProtocol);
    assert!(*registry.adapters.borrow(intent.protocol_id) == type_name::get<W>(), EWrongAdapter);

    // 4. One enclave signature = one release.
    consume_nonce(registry, intent.treasury_id, intent.nonce);

    // 5. Bounded release (caps/expiry/revocation enforced in capability), with a hot-potato
    //    ticket the adapter MUST discharge by custodying its receipt.
    capability::release_with_ticket(treasury, cap, intent.protocol_id, intent.amount, clock, ctx)
}

/// Shared intent checks (binding + expiry + action), protocol-agnostic.
fun assert_intent_valid<C>(
    intent: &ActionIntent,
    treasury: &Treasury<C>,
    cap: &AgentCap<C>,
    clock: &Clock,
) {
    assert!(intent.treasury_id == object::id(treasury), EWrongTreasuryIntent);
    assert!(intent.agent_cap_id == object::id(cap), EWrongAgentCap);
    assert!(intent.expires_at_ms >= clock.timestamp_ms(), EIntentExpired);
    assert!(intent.action_kind == ACTION_SUPPLY, EUnsupportedAction);
}

/// Reconstruct the signed ActionIntent from pure fields (so it can be passed in a PTB).
fun build_intent(
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
): ActionIntent {
    ActionIntent {
        schema_version,
        chain_id,
        treasury_id: object::id_from_address(treasury_id),
        agent_cap_id: object::id_from_address(agent_cap_id),
        nonce,
        expires_at_ms,
        action_kind,
        protocol_id,
        asset_type,
        amount,
        min_health_factor_bps,
        max_protocol_exposure,
        policy_hash,
        input_hash,
        rationale_hash,
    }
}

/// Reject a replayed or stale nonce, then record it as the latest for the treasury.
/// Nonces are per-treasury and must strictly increase (so the first must be > 0).
fun consume_nonce(registry: &mut DecisionRegistry, treasury: ID, nonce: u64) {
    if (registry.last_nonce.contains(treasury)) {
        let last = registry.last_nonce.borrow_mut(treasury);
        assert!(nonce > *last, EReplayedOrStaleNonce);
        *last = nonce;
    } else {
        assert!(nonce > 0, EReplayedOrStaleNonce);
        registry.last_nonce.add(treasury, nonce);
    }
}

// === Tests ===

#[test_only]
use std::bcs;
#[test_only]
use std::unit_test::{assert_eq, destroy};

#[test_only]
fun new_registry(ctx: &mut TxContext): DecisionRegistry {
    DecisionRegistry { id: object::new(ctx), last_nonce: table::new(ctx), adapters: table::new(ctx) }
}

/// Pins the wire format the enclave must reproduce: a DecisionPayload is
/// id(32) + amount(8, LE) + nonce(8, LE) = 48 bytes, fields in this order.
#[test]
fun decision_payload_serde() {
    let payload = DecisionPayload {
        treasury: object::id_from_address(@0x1),
        amount: 1000,
        nonce: 7,
    };
    let bytes = bcs::to_bytes(&payload);
    assert_eq!(bytes.length(), 48);
    assert_eq!(
        bytes,
        x"0000000000000000000000000000000000000000000000000000000000000001e8030000000000000700000000000000",
    );
}

/// Round-trips a real secp256k1 signature produced off-chain by
/// agent/scripts/gen-decision-vectors.ts over the identical BCS envelope.
#[test]
fun verify_real_enclave_signature() {
    let mut ctx = tx_context::dummy();
    let pk = x"034f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa";
    let e = enclave::new_enclave_for_testing<DECISION>(pk, &mut ctx);
    let sig =
        x"f02f7e72ff9eae4a8762df11bff89ff9e1cb2c87f734b3958f650cc031baec532bb1f6e8b62f3a7f185bd9ce5b2f9d0807b90e6b5f62ac8f2eed63d4dd92dea4";

    let payload = DecisionPayload { treasury: object::id_from_address(@0x1), amount: 1000, nonce: 7 };
    assert!(e.verify_signature(DECISION_INTENT, 1_700_000_000_000, payload, &sig));

    // Any tamper (here: amount 1000 -> 1001) breaks verification.
    let tampered = DecisionPayload { treasury: object::id_from_address(@0x1), amount: 1001, nonce: 7 };
    assert!(!e.verify_signature(DECISION_INTENT, 1_700_000_000_000, tampered, &sig));

    e.destroy();
}

#[test]
fun nonce_strictly_increases() {
    let mut ctx = tx_context::dummy();
    let mut reg = new_registry(&mut ctx);
    let t = object::id_from_address(@0x2);
    consume_nonce(&mut reg, t, 1);
    consume_nonce(&mut reg, t, 2);
    consume_nonce(&mut reg, t, 99);
    destroy(reg);
}

#[test, expected_failure(abort_code = EReplayedOrStaleNonce)]
fun replayed_nonce_aborts() {
    let mut ctx = tx_context::dummy();
    let mut reg = new_registry(&mut ctx);
    let t = object::id_from_address(@0x2);
    consume_nonce(&mut reg, t, 7);
    consume_nonce(&mut reg, t, 7); // replay of the same nonce — aborts
    abort
}

#[test, expected_failure(abort_code = EReplayedOrStaleNonce)]
fun stale_nonce_aborts() {
    let mut ctx = tx_context::dummy();
    let mut reg = new_registry(&mut ctx);
    let t = object::id_from_address(@0x2);
    consume_nonce(&mut reg, t, 10);
    consume_nonce(&mut reg, t, 9); // lower than last — aborts
    abort
}

#[test]
fun action_intent_serde() {
    let intent = ActionIntent {
        schema_version: 1,
        chain_id: x"04",
        treasury_id: object::id_from_address(@0x1),
        agent_cap_id: object::id_from_address(@0x2),
        nonce: 7,
        expires_at_ms: 1_700_000_100_000,
        action_kind: 0,
        protocol_id: 0,
        asset_type: b"USDC",
        amount: 1000,
        min_health_factor_bps: 0,
        max_protocol_exposure: 0,
        policy_hash: x"1111111111111111111111111111111111111111111111111111111111111111",
        input_hash: x"2222222222222222222222222222222222222222222222222222222222222222",
        rationale_hash: x"3333333333333333333333333333333333333333333333333333333333333333",
    };
    let bytes = bcs::to_bytes(&intent);
    assert_eq!(bytes, x"01000104000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000020700000000000000a0eee6cf8b01000000000455534443e80300000000000000000000000000000000000000000000201111111111111111111111111111111111111111111111111111111111111111202222222222222222222222222222222222222222222222222222222222222222203333333333333333333333333333333333333333333333333333333333333333");
}

/// Verifies a real secp256k1 signature over the canonical ActionIntent envelope.
#[test]
fun verify_real_action_intent() {
    let mut ctx = tx_context::dummy();
    let pk = x"034f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa";
    let e = enclave::new_enclave_for_testing<DECISION>(pk, &mut ctx);
    let sig = x"3eff101a6e656813555c38d1ba4a48ddc29bc356abfcc21b2548eb5a4a7b702d2cc6d9f86bdc40d417872662f6c19ba9b5fa52e0148984026278d8d74383fe89";

    let intent = ActionIntent {
        schema_version: 1, chain_id: x"04",
        treasury_id: object::id_from_address(@0x1),
        agent_cap_id: object::id_from_address(@0x2),
        nonce: 7, expires_at_ms: 1_700_000_100_000,
        action_kind: 0, protocol_id: 0, asset_type: b"USDC", amount: 1000,
        min_health_factor_bps: 0, max_protocol_exposure: 0,
        policy_hash: x"1111111111111111111111111111111111111111111111111111111111111111",
        input_hash: x"2222222222222222222222222222222222222222222222222222222222222222",
        rationale_hash: x"3333333333333333333333333333333333333333333333333333333333333333",
    };
    assert!(e.verify_signature(DECISION_INTENT, 1_700_000_000_000, intent, &sig));

    let mut tampered = intent;
    tampered.amount = 1001;
    assert!(!e.verify_signature(DECISION_INTENT, 1_700_000_000_000, tampered, &sig));

    e.destroy();
}

#[test]
fun entry_build_intent_matches_canonical() {
    let intent = build_intent(
        1, x"04", @0x1, @0x2, 7, 1_700_000_100_000, 0, 0, b"USDC", 1000, 0, 0,
        x"1111111111111111111111111111111111111111111111111111111111111111",
        x"2222222222222222222222222222222222222222222222222222222222222222",
        x"3333333333333333333333333333333333333333333333333333333333333333",
    );
    assert_eq!(
        bcs::to_bytes(&intent),
        x"01000104000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000020700000000000000a0eee6cf8b01000000000455534443e80300000000000000000000000000000000000000000000201111111111111111111111111111111111111111111111111111111111111111202222222222222222222222222222222222222222222222222222222222222222203333333333333333333333333333333333333333333333333333333333333333",
    );
}
