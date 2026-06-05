import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  beginRun,
  loadAgentState,
  recordDeposit,
  recordTweet,
  saveAgentState,
  shouldSkipDeposit
} from '../src/core/agentMemory.js';
import type { AppConfig } from '../src/types.js';

const baseConfig: AppConfig = {
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

const tempFiles: string[] = [];

afterEach(() => {
  for (const file of tempFiles) {
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
  }
  tempFiles.length = 0;
});

function tempStatePath(): string {
  const file = path.join(os.tmpdir(), `agent-state-${Date.now()}-${Math.random()}.json`);
  tempFiles.push(file);
  return file;
}

describe('agentMemory', () => {
  test('load initializes empty state when file missing', () => {
    const statePath = tempStatePath();
    const state = loadAgentState(baseConfig, statePath);
    expect(state.version).toBe(1);
    expect(state.actions.deposits).toEqual([]);
    expect(state.pending).toEqual([]);
  });

  test('recordDeposit queues tweet_deposit for confirmed deposits', () => {
    const statePath = tempStatePath();
    const state = loadAgentState(baseConfig, statePath);
    const runId = beginRun(state);

    recordDeposit(state, {
      runId,
      fToken: '0xf42f5795D9ac7e9D757dB633D693cD548Cfd9169',
      rawAmount: '5000000',
      status: 'confirmed',
      txHash: '0xdeadbeef',
      dryRun: false
    });

    expect(state.pending).toHaveLength(1);
    expect(state.pending[0]?.type).toBe('tweet_deposit');
    expect(state.actions.deposits[0]?.tweeted).toBe(false);

    saveAgentState(statePath, state);
    const reloaded = loadAgentState(baseConfig, statePath);
    expect(reloaded.pending).toHaveLength(1);
    expect(reloaded.actions.deposits[0]?.txHash).toBe('0xdeadbeef');
  });

  test('shouldSkipDeposit blocks while tweet pending', () => {
    const state = loadAgentState(baseConfig, tempStatePath());
    const runId = beginRun(state);
    recordDeposit(state, {
      runId,
      fToken: '0xf42f5795D9ac7e9D757dB633D693cD548Cfd9169',
      rawAmount: '5000000',
      status: 'confirmed',
      txHash: '0xabc',
      dryRun: false
    });

    const skip = shouldSkipDeposit(state, baseConfig, '0xf42f5795D9ac7e9D757dB633D693cD548Cfd9169');
    expect(skip.skip).toBe(true);
    expect(skip.reason).toContain('tweet');
  });

  test('recordTweet clears pending tweet_deposit', () => {
    const state = loadAgentState(baseConfig, tempStatePath());
    const runId = beginRun(state);
    const deposit = recordDeposit(state, {
      runId,
      fToken: '0xf42f5795D9ac7e9D757dB633D693cD548Cfd9169',
      rawAmount: '5000000',
      status: 'confirmed',
      txHash: '0xabc',
      dryRun: false
    });

    recordTweet(state, { depositId: deposit.id, status: 'posted', externalId: 'tweet-1' });

    expect(state.pending).toHaveLength(0);
    expect(state.actions.deposits[0]?.tweeted).toBe(true);
    expect(shouldSkipDeposit(state, baseConfig).skip).toBe(false);
  });
});
