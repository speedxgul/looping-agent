/// Build-time interface for NAVI's `lending_core` modules. Structs + signatures copied
/// verbatim from the on-chain ABI (sui_getNormalizedMoveFunction / *Struct on
/// 0xd899…c81ca). Bodies `abort`; never published. Multiple modules in one file via
/// block syntax — they all live at the same `lending_core` package address.

/// `AccountCap` — NAVI's per-account capability (Key + Store). Holding it gates
/// deposits/withdrawals to one isolated NAVI account; we custody it in the Treasury.
module lending_core::account {
    public struct AccountCap has key, store {
        id: UID,
        owner: address,
    }
}

/// The shared global lending `Storage` object.
module lending_core::storage {
    public struct Storage has key {
        id: UID,
    }
}

/// The shared per-asset reserve `Pool<T>`.
module lending_core::pool {
    public struct Pool<phantom T> has key {
        id: UID,
    }
}

/// The shared v2 incentive accounting object.
module lending_core::incentive_v2 {
    public struct Incentive has key {
        id: UID,
    }
}

/// Public constructor returning a fresh `AccountCap` by value (so the adapter can
/// custody it in the same call).
module lending_core::lending {
    use lending_core::account::AccountCap;

    public fun create_account(_ctx: &mut TxContext): AccountCap {
        abort 0
    }
}

/// The v3 incentive object + the account-cap-gated deposit/withdraw entries.
module lending_core::incentive_v3 {
    use sui::balance::Balance;
    use sui::clock::Clock;
    use sui::coin::Coin;
    use lending_core::account::AccountCap;
    use lending_core::incentive_v2::Incentive as IncentiveV2;
    use lending_core::pool::Pool;
    use lending_core::storage::Storage;
    use oracle::oracle::PriceOracle;

    public struct Incentive has key {
        id: UID,
    }

    /// Deposit `deposit_coin` into the NAVI account behind `account_cap`. The coin is
    /// consumed; nothing is returned (the position lives in NAVI storage, gated by the cap).
    public fun deposit_with_account_cap<T>(
        _clock: &Clock,
        _storage: &mut Storage,
        _pool: &mut Pool<T>,
        _asset: u8,
        _deposit_coin: Coin<T>,
        _incentive_v2: &mut IncentiveV2,
        _incentive_v3: &mut Incentive,
        _account_cap: &AccountCap,
    ) {
        abort 0
    }

    /// Withdraw `amount` of the underlying from the account behind `account_cap`,
    /// returning it as a `Balance<T>`. Needs the `PriceOracle` for the value check.
    public fun withdraw_with_account_cap<T>(
        _clock: &Clock,
        _oracle: &PriceOracle,
        _storage: &mut Storage,
        _pool: &mut Pool<T>,
        _asset: u8,
        _amount: u64,
        _incentive_v2: &mut IncentiveV2,
        _incentive_v3: &mut Incentive,
        _account_cap: &AccountCap,
    ): Balance<T> {
        abort 0
    }
}
