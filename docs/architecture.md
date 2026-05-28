# Architecture

The scaffold separates autonomous decision-making from protocol access.

## Layers

`src/clients`

Small HTTP clients. They do not decide whether an action is safe. They only shape API requests and responses.

`src/core/policy.js`

Central risk checks. Before an action can execute, it must pass policy. Future strategies should reuse this instead of duplicating safety checks.

`src/core/autonomousAgent.js`

Runs the OpenAI tool-calling loop: build prompt, expose tools, execute tool calls locally, return an operational summary.

## Adding Live Transaction Execution

Keep these rules as the execution surface grows:

- never execute if `DRY_RUN=true`
- require explicit enable flags per action type
- check allowance targets from the swap quote before approving
- cap daily notional and per-trade notional
- use allowlisted tokens and chains only
- log every planned transaction before signing

This keeps the project contract-free while still allowing on-chain interaction with existing protocols.
