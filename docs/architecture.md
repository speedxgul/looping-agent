# Architecture

The scaffold separates autonomous decision-making from protocol access.

## Layers

`src/clients`

Small clients for external services: MoltX (social, swap), Fluid (reads), Fluid execution (Base signer / smart account writes), OpenAI, X, and Walrus (raw blobs + MemWal semantic memory). They do not decide whether an action is safe. They only shape requests and responses.

`src/core/policy.ts`

Central risk checks. Before a write action can execute, it must pass policy. Future strategies should reuse this instead of duplicating safety checks.

`src/core/agentMemory.ts` + `src/core/memoryStore.ts`

`agentMemory` defines the persistent state shape (runs, deposits, tweets, snapshots, pending tasks, artifacts) and pure helpers to read/update it. `memoryStore` chooses where that state lives: a local JSON file (`FileMemoryStore`) or verifiable Walrus blobs with a local cache (`WalrusMemoryStore`), selected by `AGENT_MEMORY_BACKEND`.

`src/core/toolRegistry.ts`

Defines the function tools exposed to the model and their local handlers. Every write goes through policy and persists via the memory store.

`src/core/autonomousAgent.ts`

Runs the OpenAI tool-calling loop: load memory, recall long-term context, build the prompt, expose tools, execute tool calls locally, then finalize the run (archive a report blob + store a reflection on the Walrus backend) and return an operational summary.

## Adding Live Transaction Execution

Keep these rules as the execution surface grows:

- never execute if `DRY_RUN=true`
- require explicit enable flags per action type
- check allowance targets from the swap quote before approving
- cap daily notional and per-trade notional
- use allowlisted tokens and chains only
- log every planned transaction before signing

This keeps the project contract-free while still allowing on-chain interaction with existing protocols.
