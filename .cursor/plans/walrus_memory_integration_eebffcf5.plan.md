---
name: Walrus Memory Integration
overview: Adapt the existing Bun/TypeScript DeFi agent for the Walrus track by adding (A) verifiable agent-state persistence on Walrus via a swappable MemoryStore, (B) semantic long-term memory via MemWal recall/remember injected into the agent loop, and (C) an artifact-driven workflow that stores each run's report as a Walrus blob. Targets Walrus testnet + MemWal staging relayer.
todos:
  - id: creds
    content: Create MemWal staging account + delegate key (playground or generateDelegateKey/createAccount); capture MEMWAL_ACCOUNT_ID and MEMWAL_DELEGATE_KEY
    status: completed
  - id: deps
    content: Add @mysten-incubation/memwal dependency via bun
    status: completed
  - id: config
    content: Add walrus + memwal config block to src/types.ts and src/utils/config.ts, plus .env.example entries
    status: completed
  - id: blob-client
    content: Implement src/clients/walrusBlobClient.ts (PUT/GET against testnet publisher/aggregator via http util)
    status: completed
  - id: memory-store
    content: Implement src/core/memoryStore.ts with MemoryStore interface, FileMemoryStore, WalrusMemoryStore (pointer file + env bootstrap + fallback)
    status: completed
  - id: memwal-client
    content: Implement src/clients/walrusMemoryClient.ts wrapping MemWal (recall/remember/analyze/health, disabled-stub mode)
    status: completed
  - id: async-persist
    content: Make persist async/durable-aware in autonomousAgent.ts and toolRegistry.ts; await all call sites
    status: completed
  - id: loop-recall
    content: Inject MemWal recall into the run prompt and remember/analyze the run reflection at end of run
    status: completed
  - id: memory-tools
    content: Add recall_memory and remember_insight tools to toolRegistry + instructions
    status: completed
  - id: artifacts
    content: Add artifacts to AgentStateV1, store run report as Walrus blob, surface URLs in summary
    status: completed
  - id: wire-index
    content: Wire new clients + MemoryStore selection into src/index.ts and Clients type
    status: completed
  - id: tests
    content: Add memoryStore/walrusBlobClient tests; update AppConfig fixtures in policy.test.ts and agentMemory.test.ts; run bun test
    status: completed
  - id: docs
    content: Update README with Walrus/MemWal setup, env vars, and portability demo steps
    status: completed
isProject: false
---

## Goal

Make the agent's memory portable, persistent, and verifiable on Walrus, hitting all three track criteria: long-term memory, persistent data/file access, and developer-friendly integration. Target **testnet** (Walrus public testnet publisher/aggregator) + **MemWal staging relayer** (`https://relayer-staging.memory.walrus.xyz`).

## Prerequisite: MemWal credentials (manual, one-time)

Create a MemWal account + delegate key on staging (track reference: "MemWal Playground"):
- Use the playground at `https://staging.memory.walrus.xyz` to create an account and generate a delegate key, OR programmatically via `generateDelegateKey()` + `createAccount()` from `@mysten-incubation/memwal/account`.
- You'll get a `MEMWAL_ACCOUNT_ID` (Sui object id) and `MEMWAL_DELEGATE_KEY` (ed25519 hex). These go in `.env` (never committed).

## Design decisions (chosen for fastest reliable demo)

- Walrus raw blobs via the **HTTP publisher/aggregator** (testnet, `PUT /v1/blobs`, `GET /v1/blobs/{blobId}`) using the existing [`src/utils/http.ts`](src/utils/http.ts) `requestJson`/fetch helper. No funded Sui wallet, no new Walrus SDK dep needed. Endpoints come from the Walrus Network Reference and are env-configurable.
- MemWal via the default relayer-backed client `@mysten-incubation/memwal` (the only new runtime dependency).
- Keep the existing pure memory mutators in [`src/core/agentMemory.ts`](src/core/agentMemory.ts) untouched; only the two I/O functions (`loadAgentState`/`saveAgentState`) get abstracted behind a `MemoryStore`.

## A. Verifiable state persistence (`MemoryStore` + Walrus blobs)

- New file `src/core/memoryStore.ts`: define `interface MemoryStore { load(): Promise<AgentStateV1>; save(state: AgentStateV1): Promise<void> }`.
  - `FileMemoryStore`: wraps current `loadAgentState`/`saveAgentState` behavior (default, unchanged semantics).
  - `WalrusMemoryStore`: on `save`, uploads `JSON.stringify(state)` to the Walrus publisher, records the returned `blobId` in a small local pointer `data/walrus-pointer.json`; on `load`, reads latest `blobId` (from pointer file, or from env `WALRUS_STATE_BLOB_ID` to bootstrap/port onto a fresh machine), fetches from the aggregator, and parses. Reuse the existing version/wallet guards from `loadAgentState` (`agentMemory.ts:125-154`). Fall back to `FileMemoryStore` on network error so a run never hard-fails.
- New client `src/clients/walrusBlobClient.ts`: `storeBlob(bytes): Promise<{ blobId, url }>` and `readBlob(blobId): Promise<Uint8Array>` against configured publisher/aggregator base URLs.
- Backend selected by env `AGENT_MEMORY_BACKEND=file|walrus` (default `file`).

## B. Semantic long-term memory (MemWal)

- New client `src/clients/walrusMemoryClient.ts`: wraps `MemWal.create({ key, accountId, serverUrl, namespace })`. Methods: `recall(query)`, `remember(text)` / `rememberAndWait`, `analyze(text)`, `health()`. No-op stub when `MEMWAL_ENABLED=false` so the agent still runs without credentials.
- Inject recalled context into the run prompt in [`src/core/autonomousAgent.ts`](src/core/autonomousAgent.ts:50-65): before building `input`, `await clients.walrusMemory.recall("<wallet> recent deposit decisions, APRs, blockers")` and append the top results next to the existing `getMemorySummary(...)` block.
- After each run (`autonomousAgent.ts:76-79` finally block): `await clients.walrusMemory.analyze(result.outputText)` (or `remember` a concise reflection) so insights persist across sessions.
- Add two tools to [`src/core/toolRegistry.ts`](src/core/toolRegistry.ts): `recall_memory({ query })` and `remember_insight({ text })`, so the LLM can read/write memory explicitly. Register definitions and handlers alongside the existing 9 tools; document them in `buildInstructions` (`autonomousAgent.ts:150-178`).

## C. Artifact-driven workflow (run reports on Walrus)

- At end of run, generate a Markdown run report (markets ranked by APR, deposit/tweet decisions, blockers) and store it via `walrusBlobClient.storeBlob`.
- Add an `artifacts: { runId, blobId, url, createdAt }[]` field to `AgentStateV1` (`agentMemory.ts:55-67`) + a bounded helper `recordArtifact(state, ...)`; surface recent artifact URLs in `getMemorySummary` and the final summary so reports are discoverable/reusable.

## D. Wiring, async persistence, config, tests

- `src/index.ts`: instantiate `walrusBlobClient` + `walrusMemoryClient`, add to `Clients`; choose `MemoryStore` and pass it into `createAutonomousAgent`.
- Async persistence: change the `persist` closure (`autonomousAgent.ts:33`, `toolRegistry.ts:29` `AgentMemoryContext.persist`) from `() => void` to `() => Promise<void>` and `await` it at all call sites. To control Walrus latency/cost, make `persist({ durable })`: snapshot-only updates stay local/cheap; durable saves (after confirmed deposits and at end-of-run) trigger the Walrus upload.
- Config: add a `walrus` block to `AppConfig` in [`src/types.ts`](src/types.ts) and readers in [`src/utils/config.ts`](src/utils/config.ts:11-73): `memoryBackend`, publisher/aggregator URLs, `stateBlobId`, and `memwal` `{ enabled, accountId, delegateKey, relayerUrl, namespace }`.
- `.env.example`: add the new vars with testnet/staging defaults and comments.
- Tests: add `test/memoryStore.test.ts` and `test/walrusBlobClient.test.ts` (mock fetch). Update the inline `AppConfig` fixtures in [`test/policy.test.ts`](test/policy.test.ts) and [`test/agentMemory.test.ts`](test/agentMemory.test.ts) to include the new `walrus` config block. Run `bun test`.
- `README.md`: document the Walrus/MemWal setup, env vars, and how to demo portability (restore state on a fresh machine via `WALRUS_STATE_BLOB_ID`).

## Out of scope (can add later)

- Mainnet (requires a funded Sui/WAL wallet + authenticated publisher).
- `MemWalManual` client-side Seal encryption (extra `@mysten/sui|seal|walrus` deps).
- Multi-agent shared memory space (separate follow-up).