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

function postingEnabledConfig() {
  const config = baseConfig();
  return {
    ...config,
    x: { ...config.x, enablePosting: true, userAccessToken: 'token' }
  };
}

describe('agentMemory', () => {
  test('load initializes empty state when file missing', () => {
    const statePath = tempStatePath();
    const state = loadAgentState(baseConfig(), statePath);
    expect(state.version).toBe(1);
    expect(state.actions.positionActions).toEqual([]);
  });

  test('recordPositionAction queues tweet_action for confirmed supply when posting enabled', () => {
    const state = createEmptyAgentState(baseConfig());
    recordPositionAction(
      state,
      {
        runId: 'run-1',
        protocol: 'suilend',
        action: 'supply',
        asset: 'usdc',
        rawAmount: '1000',
        status: 'confirmed',
        dryRun: false
      },
      { enablePosting: true }
    );

    expect(state.pending.some((task) => task.type === 'tweet_action')).toBe(true);
  });

  test('recordPositionAction does not queue tweet_action when posting disabled', () => {
    const state = createEmptyAgentState(baseConfig());
    recordPositionAction(
      state,
      {
        runId: 'run-1',
        protocol: 'suilend',
        action: 'supply',
        asset: 'usdc',
        rawAmount: '1000',
        status: 'confirmed',
        dryRun: false
      },
      { enablePosting: false }
    );

    expect(state.pending.some((task) => task.type === 'tweet_action')).toBe(false);
  });

  test('shouldSkipWriteAction blocks while a tweet_action is pending and posting is enabled', () => {
    const state = createEmptyAgentState(baseConfig());
    recordPositionAction(
      state,
      {
        runId: 'run-1',
        protocol: 'suilend',
        action: 'supply',
        asset: 'usdc',
        rawAmount: '1000',
        status: 'confirmed',
        dryRun: false
      },
      { enablePosting: true }
    );

    const skip = shouldSkipWriteAction(state, postingEnabledConfig(), 'usdc', 'supply');
    expect(skip.skip).toBe(true);
  });

  test('shouldSkipWriteAction does not block on a pending tweet_action when posting is disabled', () => {
    const state = createEmptyAgentState(baseConfig());
    // Simulate a tweet_action queued by an earlier run (e.g. before posting was disabled).
    state.pending.push({
      type: 'tweet_action',
      actionId: 'stale-action',
      createdAt: new Date().toISOString()
    });

    const skip = shouldSkipWriteAction(state, baseConfig(), 'usdc', 'supply');
    expect(skip.skip).toBe(false);
  });

  test('recordTweet clears pending tweet_action and marks the action tweeted', () => {
    const state = createEmptyAgentState(baseConfig());
    const action = recordPositionAction(
      state,
      {
        runId: 'run-1',
        protocol: 'suilend',
        action: 'supply',
        asset: 'usdc',
        rawAmount: '1000',
        status: 'confirmed',
        dryRun: false
      },
      { enablePosting: true }
    );

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
