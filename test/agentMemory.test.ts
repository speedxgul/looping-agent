import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import {
  createEmptyAgentState,
  getMemorySummary,
  loadAgentState,
  normalizeAgentState,
  recordDeposit,
  recordPositionAction,
  recordTweet,
  shouldSkipDeposit,
  shouldSkipWriteAction
} from '../src/core/agentMemory.js';
import { baseConfig } from './fixtures/baseConfig.js';

function tempStatePath(): string {
  return path.join(os.tmpdir(), `agent-state-${Date.now()}-${Math.random()}.json`);
}

describe('agentMemory', () => {
  test('load initializes empty state when file missing', () => {
    const statePath = tempStatePath();
    const state = loadAgentState(baseConfig(), statePath);
    expect(state.version).toBe(1);
    expect(state.actions.positionActions).toEqual([]);
  });

  test('recordPositionAction queues tweet_action for confirmed supply', () => {
    const statePath = tempStatePath();
    const state = loadAgentState(baseConfig(), statePath);
    recordPositionAction(state, {
      runId: 'run-1',
      protocol: 'suilend',
      action: 'supply',
      asset: 'usdc',
      rawAmount: '1000',
      status: 'confirmed',
      dryRun: false
    });

    expect(state.pending.some((task) => task.type === 'tweet_action')).toBe(true);
  });

  test('migrates legacy deposits into positionActions', () => {
    const migrated = normalizeAgentState(baseConfig(), {
      version: 1,
      walletAddress: baseConfig().agent.walletAddress,
      actions: {
        deposits: [
          {
            id: 'dep-1',
            runId: 'run-1',
            fToken: '0xfToken',
            rawAmount: '1000',
            status: 'confirmed',
            dryRun: false,
            createdAt: new Date().toISOString(),
            tweeted: false
          }
        ]
      }
    });

    expect(migrated?.actions.positionActions[0]?.action).toBe('supply');
    expect(migrated?.actions.positionActions[0]?.digest).toBeUndefined();
  });

  test('shouldSkipWriteAction blocks while tweet pending', () => {
    const state = createEmptyAgentState(baseConfig());
    recordPositionAction(state, {
      runId: 'run-1',
      protocol: 'suilend',
      action: 'supply',
      asset: 'usdc',
      rawAmount: '1000',
      status: 'confirmed',
      dryRun: false
    });

    const skip = shouldSkipWriteAction(state, baseConfig(), 'usdc', 'supply');
    expect(skip.skip).toBe(true);
  });

  test('recordTweet clears pending tweet_action', () => {
    const state = createEmptyAgentState(baseConfig());
    const action = recordPositionAction(state, {
      runId: 'run-1',
      protocol: 'suilend',
      action: 'supply',
      asset: 'usdc',
      rawAmount: '1000',
      status: 'confirmed',
      dryRun: false
    });

    recordTweet(state, { actionId: action.id, status: 'posted', externalId: 'tweet-1' });
    expect(state.pending.some((task) => task.type === 'tweet_action')).toBe(false);
    expect(action.tweeted).toBe(true);
  });

  test('recordDeposit wrapper maps legacy deposit shape', () => {
    const state = createEmptyAgentState(baseConfig());
    const action = recordDeposit(state, {
      runId: 'run-1',
      fToken: '0xfToken',
      rawAmount: '1000',
      status: 'confirmed',
      dryRun: false
    });

    expect(action.action).toBe('supply');
    expect(action.asset).toBe('0xfToken');
    expect(shouldSkipDeposit(state, baseConfig(), '0xfToken').skip).toBe(true);
  });

  test('getMemorySummary exposes recent actions', () => {
    const state = createEmptyAgentState(baseConfig());
    const summary = getMemorySummary(state, baseConfig(), 'run-1');
    expect(summary.recentActions).toEqual([]);
    expect(summary.actionSkipReason).toBeNull();
  });
});

afterEach(() => {
  // no-op placeholder for future temp cleanup
  void fs;
});
