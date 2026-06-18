import { describe, expect, test } from 'bun:test';
import {
  beginRun,
  createEmptyAgentState,
  recordPositionAction,
  type AgentStateV1
} from '../src/core/agentMemory.js';
import { createToolRegistry } from '../src/core/toolRegistry.js';
import type { AppConfig, Clients, Logger } from '../src/types.js';
import { baseConfig } from './fixtures/baseConfig.js';

const usdcCoinType = '0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf::coin::COIN';
const logger = quietLogger();

describe('post_action_update', () => {
  test('blocks when X posting is disabled and leaves pending task intact', async () => {
    const state = stateWithConfirmedSupply();
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
    const state = stateWithConfirmedSupply();
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

  test('successful X post clears pending tweet and marks action tweeted', async () => {
    const state = stateWithConfirmedSupply();
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
      'Treasury update: supplied 5 USDC into Suilend USDC on Sui. Current market APR: ~4.3%. Tx: https://suiscan.xyz/testnet/tx/0xabc'
    );
    expect(state.pending).toHaveLength(0);
    expect(state.actions.positionActions[0]?.tweeted).toBe(true);
    expect(state.actions.positionActions[0]?.tweetId).toBe('x-post-1');
    expect(state.actions.tweets[0]).toMatchObject({
      actionId: state.actions.positionActions[0]?.id,
      status: 'posted',
      externalId: 'x-post-1',
      text: result.text
    });
  });

  test('failed X post records failure and keeps pending tweet', async () => {
    const state = stateWithConfirmedSupply();
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
    expect(state.actions.positionActions[0]?.tweeted).toBe(false);
    expect(state.actions.positionActions[0]?.tweetId).toBeUndefined();
    expect(state.actions.tweets[0]).toMatchObject({
      actionId: state.actions.positionActions[0]?.id,
      status: 'failed',
      text: 'Treasury update'
    });
  });
});

function stateWithConfirmedSupply(): AgentStateV1 {
  const state = createEmptyAgentState(baseConfig());
  const runId = beginRun(state);
  recordPositionAction(state, {
    runId,
    protocol: 'suilend',
    action: 'supply',
    asset: 'usdc',
    rawAmount: '5000000',
    status: 'confirmed',
    digest: '0xabc',
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
        enablePosting: true,
        userAccessToken: 'user-token',
        ...overrides.x
      }
    },
    clients,
    logger,
    memory: {
      state,
      runId: 'test-run',
      statePath: 'test-state.json',
      persist: async () => undefined
    }
  });
}

async function executePost(
  registry: ReturnType<typeof createToolRegistry>,
  args: Record<string, unknown> = {}
): Promise<Record<string, unknown>> {
  return registry.execute({
    type: 'function_call',
    name: 'post_action_update',
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
    suiExecution: {
      isConfigured: () => true,
      getAddress: () => '0x0000000000000000000000000000000000000001',
      assertWalletMatches: async () => ({ address: '0x0000000000000000000000000000000000000001' }),
      getCoinBalances: async () => ({
        wallet: '0x0000000000000000000000000000000000000001',
        sui: { symbol: 'SUI', coinType: '0x2::sui::SUI', decimals: 9, raw: '0', formatted: '0' },
        usdc: { symbol: 'USDC', coinType: usdcCoinType, decimals: 6, raw: '0', formatted: '0' }
      }),
      signAndExecute: async () => ({ digest: '0xabc', effects: {} })
    },
    suilend: {
      resolveCoinType: (asset: string) => (asset === 'usdc' ? usdcCoinType : asset),
      getMarkets: async () => ({
        markets: [
          {
            coinType: usdcCoinType,
            symbol: 'USDC',
            decimals: 6,
            supplyApr: 4.2,
            borrowApr: 5.1,
            totalApr: 4.3,
            price: 1,
            allowed: true
          }
        ]
      }),
      getObligation: async () => ({
        obligationId: null,
        deposits: [],
        borrows: [],
        healthFactor: null,
        borrowLimitUsd: 0,
        liquidationThresholdUsd: 0
      }),
      executeSupply: async () => ({ digest: '0xabc' }),
      executeWithdraw: async () => ({ digest: '0xabc' }),
      executeBorrow: async () => ({ digest: '0xabc' }),
      executeRepay: async () => ({ digest: '0xabc' })
    },
    navi: {
      isEnabled: () => false,
      getRates: async () => ({ rates: [] })
    },
    scallop: {
      isEnabled: () => false,
      getRates: async () => ({ rates: [] })
    },
    openai: {
      create: async () => ({ output: [] })
    },
    x: {
      createPost: async (text: string) => ({ id: 'x-post-1', text })
    },
    walrusBlob: {
      upload: async () => ({ blobId: 'blob-1', url: 'https://example.com/blob-1' }),
      download: async () => null
    },
    walrusMemory: {
      recall: async () => [],
      remember: async () => undefined
    },
    ...overrides
  } as unknown as Clients;
}

function quietLogger(): Logger {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined
  };
}
