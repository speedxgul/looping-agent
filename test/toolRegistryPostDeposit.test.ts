import { describe, expect, test } from 'bun:test';
import {
  beginRun,
  createEmptyAgentState,
  recordDeposit,
  type AgentStateV1
} from '../src/core/agentMemory.js';
import { createToolRegistry } from '../src/core/toolRegistry.js';
import type { AppConfig, Clients, Logger } from '../src/types.js';

const fToken = '0xf42f5795D9ac7e9D757dB633D693cD548Cfd9169';
const logger = quietLogger();

describe('post_deposit_update', () => {
  test('blocks when X posting is disabled and leaves pending task intact', async () => {
    const state = stateWithConfirmedDeposit();
    const clients = createClients();
    const registry = createRegistry(state, clients, { x: { enablePosting: false } });

    const result = await executePost(registry);

    expect(result.ok).toBe(false);
    expect(result.blocked).toBe(true);
    expect(result.reason).toBe('ENABLE_X_POSTING is false');
    expect(state.pending).toHaveLength(1);
    expect(state.actions.tweets).toHaveLength(0);
  });

  test('blocks when X token is missing and leaves pending task intact', async () => {
    const state = stateWithConfirmedDeposit();
    const clients = createClients();
    const registry = createRegistry(state, clients, {
      x: { enablePosting: true, userAccessToken: '' }
    });

    const result = await executePost(registry);

    expect(result.ok).toBe(false);
    expect(result.blocked).toBe(true);
    expect(result.reason).toBe('X_USER_ACCESS_TOKEN is missing');
    expect(state.pending).toHaveLength(1);
    expect(state.actions.tweets).toHaveLength(0);
  });

  test('successful X post clears pending tweet and marks deposit tweeted', async () => {
    const state = stateWithConfirmedDeposit();
    const clients = createClients({
      x: {
        createPost: async (text: string) => ({ id: 'x-post-1', text })
      }
    });
    const registry = createRegistry(state, clients);

    const result = await executePost(registry);

    expect(result.ok).toBe(true);
    expect(result.tweetId).toBe('x-post-1');
    expect(result.text).toBe(
      'Treasury update: supplied 5 USDC into Fluid fUSDC on Base. Current market APR: ~4.3%. Tx: https://basescan.org/tx/0xabc'
    );
    expect(state.pending).toHaveLength(0);
    expect(state.actions.deposits[0]?.tweeted).toBe(true);
    expect(state.actions.deposits[0]?.tweetId).toBe('x-post-1');
    expect(state.actions.tweets[0]).toMatchObject({
      depositId: state.actions.deposits[0]?.id,
      status: 'posted',
      externalId: 'x-post-1',
      text: result.text
    });
  });

  test('failed X post records failure and keeps pending tweet', async () => {
    const state = stateWithConfirmedDeposit();
    const clients = createClients({
      x: {
        createPost: async () => {
          throw new Error('HTTP 403 for https://api.x.com/2/tweets');
        }
      }
    });
    const registry = createRegistry(state, clients);

    const result = await executePost(registry, { text: 'Treasury update' });

    expect(result.ok).toBe(false);
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain('HTTP 403');
    expect(state.pending).toHaveLength(1);
    expect(state.actions.deposits[0]?.tweeted).toBe(false);
    expect(state.actions.deposits[0]?.tweetId).toBeUndefined();
    expect(state.actions.tweets[0]).toMatchObject({
      depositId: state.actions.deposits[0]?.id,
      status: 'failed',
      text: 'Treasury update'
    });
  });
});

function stateWithConfirmedDeposit(): AgentStateV1 {
  const state = createEmptyAgentState(baseConfig());
  const runId = beginRun(state);
  recordDeposit(state, {
    runId,
    fToken,
    rawAmount: '5000000',
    symbol: 'USDC',
    underlying: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    status: 'confirmed',
    txHash: '0xabc',
    dryRun: false
  });
  return state;
}

function createRegistry(
  state: AgentStateV1,
  clients: Clients,
  overrides: { x?: Partial<AppConfig['x']> } = {}
) {
  return createToolRegistry({
    config: {
      ...baseConfig(),
      x: {
        ...baseConfig().x,
        ...overrides.x
      }
    },
    clients,
    logger,
    memory: {
      state,
      runId: 'test-run',
      statePath: 'test-state.json',
      persist: () => undefined
    }
  });
}

async function executePost(
  registry: ReturnType<typeof createToolRegistry>,
  args: Record<string, unknown> = {}
): Promise<Record<string, unknown>> {
  return registry.execute({
    type: 'function_call',
    name: 'post_deposit_update',
    call_id: 'call-1',
    arguments: JSON.stringify(args)
  });
}

function createClients(overrides: Partial<Clients> = {}): Clients {
  return {
    social: {
      globalFeed: async () => ({})
    },
    swap: {
      getQuote: async () => ({ validRoutes: [], bestRoute: null })
    },
    fluid: {
      getPositions: async () => ({ positions: [] })
    },
    fluidExecution: {
      getMarkets: async () => ({
        markets: [
          {
            fToken,
            underlying: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
            symbol: 'fUSDC',
            name: 'Fluid USDC',
            decimals: 6,
            isNativeUnderlying: false,
            totalAssets: '0',
            supplyRate: 4.2,
            rewardsRate: 0.1,
            totalApr: 4.3
          }
        ]
      }),
      getWalletBalances: async () => {
        throw new Error('not used');
      },
      assertWalletMatches: async () => ({ address: '0x0000000000000000000000000000000000000001' }),
      supplyToFluid: async () => ({ txHash: '0xabc' })
    },
    openai: {
      create: async () => ({ output: [] })
    },
    x: {
      createPost: async (text: string) => ({ id: 'x-post-1', text })
    },
    ...overrides
  } as unknown as Clients;
}

function baseConfig(): AppConfig {
  return {
    runtime: { dryRun: false, nodeEnv: 'test', autonomyIntervalMs: 1000 },
    logLevel: 'info',
    agent: {
      name: 'TestAgent',
      walletAddress: '0x0000000000000000000000000000000000000001',
      mission: 'test',
      statePath: '',
      depositCooldownMs: 86400000
    },
    openai: { apiKey: '', model: 'gpt-5.1', baseUrl: 'https://api.openai.com/v1', maxToolRounds: 4 },
    moltx: { apiBase: 'https://moltx.io/v1' },
    x: {
      enablePosting: true,
      userAccessToken: 'user-token',
      apiBase: 'https://api.x.com'
    },
    swap: {
      baseUrl: 'https://swap.moltx.io',
      enableQuotes: true,
      enableAutonomousSwaps: false,
      quoteNetwork: 'base',
      quoteSellToken: '',
      quoteBuyToken: '',
      quoteSellAmount: '0',
      maxSlippagePercent: 0.5,
      maxPriceImpactPercent: 1
    },
    fluid: {
      baseUrl: 'https://defi.moltx.io',
      enabled: true,
      enablePositionCreation: true,
      minIdleUsdcRaw: 0n,
      maxSupplyAmountRaw: 1000n,
      allowedFTokens: [],
      defaultFTokens: { usdc: '', weth: '' }
    },
    evm: {
      accountMode: 'eoa',
      baseRpcUrl: 'https://base.example',
      privateKey: `0x${'11'.repeat(32)}`,
      smartAccountType: 'coinbase',
      smartAccountBundlerUrl: '',
      smartAccountUsePaymaster: false
    }
  };
}

function quietLogger(): Logger {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined
  };
}
