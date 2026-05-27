# Architecture

The scaffold separates decision-making from protocol access.

## Layers

`src/clients`

Small HTTP clients. They do not decide whether an action is safe. They only shape API requests and responses.

`src/strategies`

Strategies inspect state and propose actions. The v1 strategy is `stablecoinTreasuryStrategy`.

`src/core/policy.js`

Central risk checks. Before an action can execute, it must pass policy. Future strategies should reuse this instead of duplicating safety checks.

`src/core/agent.js`

Runs one agent loop: collect state, ask the strategy for actions, apply policy, execute permitted actions.

`src/core/executor.js`

Executes approved actions. In v1, writes are skipped in dry-run mode. Swap execution and Fluid deposits are intentionally placeholders until a signer module is added.

## Adding Strategies

Create a new file in `src/strategies/` that exports:

```js
export async function myStrategy(context) {
  return {
    observations: [],
    actions: []
  };
}
```

Then import it in `src/index.js` and pass it to `createAgent`.

## Adding Live Transaction Execution

Add a signer-backed executor module, for example `src/execution/viemExecutor.js`, and keep these rules:

- never execute if `DRY_RUN=true`
- require explicit enable flags per action type
- check allowance targets from the swap quote before approving
- cap daily notional and per-trade notional
- use allowlisted tokens and chains only
- log every planned transaction before signing

This keeps the project contract-free while still allowing on-chain interaction with existing protocols.
