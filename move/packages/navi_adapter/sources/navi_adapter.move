/// REAL NAVI protocol adapter — its own package, depending only on `treasury_core` + the
/// real published NAVI `lending_core` + `oracle`. No other protocol's deps, no diamond.
///
/// NAVI lending is normally address-based; this adapter instead uses NAVI's **AccountCap**
/// path: it mints an isolated NAVI account, deposits the verified bounded release into it,
/// and custodies the cap INSIDE the `Treasury`. The agent can deposit but only the
/// `OwnerCap` holder can withdraw.
module navi_adapter::navi_adapter;

use enclave::enclave::Enclave;
use lending_core::account::AccountCap;
use lending_core::incentive_v2::Incentive as IncentiveV2;
use lending_core::incentive_v3::{Self, Incentive as IncentiveV3};
use lending_core::lending;
use lending_core::pool::Pool;
use lending_core::storage::Storage;
use oracle::oracle::PriceOracle;
use sui::clock::Clock;
use sui::coin::Coin;
use treasury_core::capability::{Self, Treasury, AgentCap, OwnerCap};
use treasury_core::decision::{Self, DecisionRegistry, DECISION};

/// NAVI protocol id. Bound to the `NAVI` witness via `decision::register_adapter`.
const PROTOCOL_NAVI: u8 = 2;

/// Adapter witness proving the caller is the registered NAVI adapter.
public struct NAVI has drop {}

/// PTB entry: verify the enclave-signed ActionIntent (in core), then supply the released
/// bounded coin into NAVI under a custodied `AccountCap`. The first supply creates the
/// account; later supplies deposit against the custodied cap. No `Coin`/cap reaches the PTB.
public fun verified_supply_navi_entry<C>(
    registry: &mut DecisionRegistry,
    treasury: &mut Treasury<C>,
    enclave: &Enclave<DECISION>,
    cap: &AgentCap<C>,
    storage: &mut Storage,
    pool: &mut Pool<C>,
    incentive_v2: &mut IncentiveV2,
    incentive_v3: &mut IncentiveV3,
    asset: u8,
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
    let (coin, ticket) = decision::verified_release<C, NAVI>(
        NAVI {}, registry, treasury, enclave, cap,
        schema_version, chain_id, treasury_id, agent_cap_id, nonce, expires_at_ms,
        action_kind, protocol_id, asset_type, amount, min_health_factor_bps,
        max_protocol_exposure, policy_hash, input_hash, rationale_hash,
        timestamp_ms, signature, clock, ctx,
    );

    if (capability::ticket_has_position(treasury, &ticket)) {
        let account_cap = capability::borrow_for_ticket<C, AccountCap>(treasury, &ticket);
        incentive_v3::deposit_with_account_cap<C>(
            clock, storage, pool, asset, coin, incentive_v2, incentive_v3, account_cap,
        );
        capability::discharge_existing(treasury, ticket);
    } else {
        let account_cap = lending::create_account(ctx);
        incentive_v3::deposit_with_account_cap<C>(
            clock, storage, pool, asset, coin, incentive_v2, incentive_v3, &account_cap,
        );
        capability::custody_new(treasury, ticket, account_cap);
    };
}

/// OWNER-ONLY: withdraw `amount` of the underlying from the custodied NAVI account. The
/// `AccountCap` is taken under `OwnerCap` authority, used, then re-custodied so the account
/// survives partial unwinds.
public fun owner_redeem<C>(
    treasury: &mut Treasury<C>,
    owner: &OwnerCap<C>,
    price_oracle: &PriceOracle,
    storage: &mut Storage,
    pool: &mut Pool<C>,
    incentive_v2: &mut IncentiveV2,
    incentive_v3: &mut IncentiveV3,
    asset: u8,
    amount: u64,
    clock: &Clock,
    ctx: &mut TxContext,
): Coin<C> {
    let account_cap = capability::owner_take_receipt<C, AccountCap>(treasury, owner, PROTOCOL_NAVI);
    let withdrawn = incentive_v3::withdraw_with_account_cap<C>(
        clock, price_oracle, storage, pool, asset, amount, incentive_v2, incentive_v3, &account_cap,
    );
    capability::owner_recustody(treasury, owner, PROTOCOL_NAVI, account_cap);
    withdrawn.into_coin(ctx)
}
