import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createEmptyAgentState,
  getMemorySummary,
  loadAgentState,
  recordPositionAction,
  recordTweet,
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

    expect(state.pending.some((task) => task.type === 'tweet_action')).toBe(true);
  });

  test('shouldSkipWriteAction blocks while a tweet_action is pending', () => {
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

  test('recordTweet clears pending tweet_action and marks the action tweeted', () => {
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
