# Architecture

The scaffold separates autonomous decision-making from protocol access.

## Layers

`src/clients`

Small clients for external services, grouped by kind: `chain/` (Sui execution sign/submit, Suilend primary lending, NAVI and Scallop read-only rate comparison), `http/` (OpenAI, X), and `storage/` (Walrus raw blobs + MemWal semantic memory). They do not decide whether an action is safe. They only shape requests and responses.

`src/core/policy.ts`

Central risk checks. Before a write action can execute, it must pass policy. Suilend supply, withdraw, borrow, and repay each have explicit gates including caps, allowlists, and borrow health-factor simulation.

`src/core/healthGuard.ts`

Runs before the LLM loop when borrows exist. If health factor drops below `SUI_MIN_HEALTH_FACTOR`, auto-repay executes on Suilend (or records a planned repay in dry-run).

`src/core/agentMemory.ts` + `src/core/memoryStore.ts`

`agentMemory` defines the persistent state shape (runs, position actions, tweets, snapshots, pending tasks, artifacts) and pure helpers to read/update it. `memoryStore` chooses where that state lives: a local JSON file (`FileMemoryStore`) or verifiable Walrus blobs with a local cache (`WalrusMemoryStore`), selected by `AGENT_MEMORY_BACKEND`.

`src/core/toolRegistry.ts`

Defines the function tools exposed to the model and their local handlers. Every write goes through policy and persists via the memory store.

`src/core/autonomousAgent.ts`

Runs the OpenAI tool-calling loop: load memory, recall long-term context, run health guard, build the prompt, expose tools, execute tool calls locally, then finalize the run (archive a report blob + store a reflection on the Walrus backend) and return an operational summary.

## Adding Live Transaction Execution

Keep these rules as the execution surface grows:

- never execute if `DRY_RUN=true` (except policy-simulated dry-run records)
- require explicit enable flags per action type
- cap supply/borrow/repay amounts via env config
- use allowlisted assets and pools only
- enforce minimum health factor before borrows and via auto-repay
- log every planned transaction before signing

This keeps the project contract-free while still allowing on-chain interaction with existing protocols.

## Branch layout

- **`base/fluid`** — frozen EVM/Fluid agent reference
- **`feat/sui-native` / `main`** — Suilend-first Sui treasury agent sharing the same agent loop and memory architecture
