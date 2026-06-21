import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig, LendingProtocol, MemoryBackend, SuiNetwork } from '../types.js';
import { normalizeSuiPrivateKey } from './privateKey.js';
import { defaultExplorerBaseUrl, defaultRpcUrl, defaultUsdcCoinType } from './suiNetwork.js';

const DEFAULT_ENV_PATH = path.resolve(process.cwd(), '.env');

export function loadConfig(): AppConfig {
  loadDotEnv(DEFAULT_ENV_PATH);

  const network = readSuiNetwork('SUI_NETWORK', 'testnet');
  const rpcUrl = readString('SUI_RPC_URL', defaultRpcUrl(network));

  return {
    runtime: {
      dryRun: readBoolean('DRY_RUN', true),
      nodeEnv: readString('NODE_ENV', 'development'),
      autonomyIntervalMs: readNumber('AUTONOMY_INTERVAL_MS', 900000),
      subagentIntervalsMs: {
        coordinator: readNumber('COORDINATOR_INTERVAL_MS', 300000),
        'rate-scout': readNumber('RATE_SCOUT_INTERVAL_MS', 600000),
        'position-risk': readNumber('POSITION_RISK_INTERVAL_MS', 180000),
        'loop-strategist': readNumber('LOOP_STRATEGIST_INTERVAL_MS', 900000),
        executor: readNumber('EXECUTOR_INTERVAL_MS', 60000),
        'unwind-guard': readNumber('UNWIND_GUARD_INTERVAL_MS', 60000)
      },
      supervisorRoles: readSupervisorRoles('SUPERVISOR_ROLES', [
        'main',
        'rate-scout',
        'position-risk',
        'loop-strategist',
        'coordinator',
        'executor',
        'unwind-guard'
      ])
    },
    logLevel: readString('LOG_LEVEL', 'info'),
    agent: {
      name: readString('AGENT_NAME', 'SuiTreasuryAgent'),
      walletAddress: readString('AGENT_WALLET_ADDRESS', ''),
      mission: readString(
        'AGENT_MISSION',
        'Manage a Sui USDC treasury on Suilend: monitor markets and health factor, supply into best-yield allowlisted pools, borrow within safe limits, rebalance on Suilend, and post concise status updates when enabled.'
      ),
      statePath: readString('AGENT_STATE_PATH', 'data/agent-state.json'),
      actionCooldownMs: readNumber('ACTION_COOLDOWN_MS', readNumber('DEPOSIT_COOLDOWN_MS', 86400000))
    },
    openai: {
      apiKey: readString('OPENAI_API_KEY', ''),
      model: readString('OPENAI_MODEL', 'gpt-5.1'),
      baseUrl: readString('OPENAI_BASE_URL', 'https://api.openai.com/v1'),
      maxToolRounds: readNumber('MAX_TOOL_ROUNDS', 6)
    },
    anthropic: {
      apiKey: readString('ANTHROPIC_API_KEY', ''),
      model: readString('ANTHROPIC_MODEL', 'claude-sonnet-4-6'),
      baseUrl: readString('ANTHROPIC_BASE_URL', 'https://api.anthropic.com/v1')
    },
    x: {
      enablePosting: readBoolean('ENABLE_X_POSTING', false),
      userAccessToken: readString('X_USER_ACCESS_TOKEN', ''),
      apiBase: readString('X_API_BASE', 'https://api.x.com')
    },
    sui: {
      enabled: readBoolean('ENABLE_SUI_LENDING', true),
      enablePositionCreation: readBoolean('ENABLE_SUI_POSITION_CREATION', false),
      enableBorrow: readBoolean('ENABLE_SUI_BORROW', false),
      rpcUrl,
      network,
      privateKey: normalizeSuiPrivateKey(readString('AGENT_SUI_PRIVATE_KEY', '')),
      walletAddress: readString('AGENT_WALLET_ADDRESS', ''),
      usdcCoinType: readString('SUI_USDC_COIN_TYPE', defaultUsdcCoinType(network)),
      suiCoinType: readString('SUI_COIN_TYPE', '0x2::sui::SUI'),
      allowedAssets: readCsv('SUI_ALLOWED_ASSETS'),
      allowedPools: readCsv('SUI_ALLOWED_POOLS'),
      minIdleRaw: BigInt(readString('MIN_IDLE_USDC_RAW', '5000000')),
      maxSupplyRaw: BigInt(readString('SUI_MAX_SUPPLY_AMOUNT_RAW', '10000000')),
      maxBorrowRaw: BigInt(readString('SUI_MAX_BORROW_AMOUNT_RAW', '5000000')),
      minHealthFactor: readNumber('SUI_MIN_HEALTH_FACTOR', 1.25),
      explorerBaseUrl: readString('SUI_EXPLORER_TX_BASE', defaultExplorerBaseUrl(network)),
      allowedProtocols: readLendingProtocols('SUI_ALLOWED_PROTOCOLS', ['suilend', 'navi', 'scallop']),
      rebalanceMinAprDeltaBps: readNumber('SUI_REBALANCE_MIN_APR_DELTA_BPS', 50),
      defaultAssets: {
        usdc: readString('SUI_DEFAULT_USDC_ASSET', 'usdc'),
        sui: readString('SUI_DEFAULT_SUI_ASSET', 'sui')
      },
      protocols: {
        // `enabled` gates reads; `write` gates supply/withdraw/borrow/repay.
        // Suilend writes default on (proven path); NAVI/Scallop writes are opt-in.
        suilend: {
          enabled: readBoolean('ENABLE_SUILEND', true),
          write: readBoolean('ENABLE_SUILEND', true)
        },
        navi: {
          enabled: readBoolean('ENABLE_NAVI_READS', true),
          write: readBoolean('ENABLE_NAVI', true)
        },
        scallop: {
          enabled: readBoolean('ENABLE_SCALLOP_READS', true),
          write: readBoolean('ENABLE_SCALLOP', true)
        }
      }
    },
    treasury: {
      enabled: readBoolean('TREASURY_MODE', false),
      // Split architecture: `packageId` is the protocol-free `treasury_core` package (decision +
      // capability + enclave registration). Each protocol's supply/redeem lives in its own
      // adapter package (`*AdapterPackageId`), which depends on core + that one protocol.
      packageId: readString('TREASURY_PACKAGE_ID', ''),
      mockAdapterPackageId: readString('TREASURY_MOCK_ADAPTER_PKG', ''),
      treasuryId: readString('TREASURY_ID', ''),
      agentCapId: readString('TREASURY_AGENT_CAP_ID', ''),
      registryId: readString('TREASURY_REGISTRY_ID', ''),
      enclaveId: readString('TREASURY_ENCLAVE_OBJECT_ID', ''),
      enclaveConfigId: readString('TREASURY_ENCLAVE_CONFIG_ID', ''),
      enclaveUrl: readString('TREASURY_ENCLAVE_URL', ''),
      protocols: {
        suilend: {
          adapterPackageId: readString('TREASURY_SUILEND_ADAPTER_PKG', ''),
          marketType: readString('TREASURY_SUILEND_MARKET_TYPE', ''),
          lendingMarketId: readString('TREASURY_SUILEND_LENDING_MARKET_ID', ''),
          reserveArrayIndex: readNumber('TREASURY_SUILEND_RESERVE_INDEX', 0),
          pythPriceInfoObjectId: readString('TREASURY_SUILEND_PYTH_PRICE_INFO_ID', '')
        },
        scallop: {
          adapterPackageId: readString('TREASURY_SCALLOP_ADAPTER_PKG', ''),
          versionId: readString('TREASURY_SCALLOP_VERSION_ID', ''),
          marketId: readString('TREASURY_SCALLOP_MARKET_ID', '')
        },
        navi: {
          adapterPackageId: readString('TREASURY_NAVI_ADAPTER_PKG', ''),
          storageId: readString('TREASURY_NAVI_STORAGE_ID', ''),
          poolId: readString('TREASURY_NAVI_POOL_ID', ''),
          incentiveV2Id: readString('TREASURY_NAVI_INCENTIVE_V2_ID', ''),
          incentiveV3Id: readString('TREASURY_NAVI_INCENTIVE_V3_ID', ''),
          assetId: readNumber('TREASURY_NAVI_ASSET_ID', 0)
        }
      }
    },
    walrus: {
      memoryBackend: readMemoryBackend('AGENT_MEMORY_BACKEND', 'file'),
      publisherUrl: readString('WALRUS_PUBLISHER_URL', 'https://publisher.walrus-testnet.walrus.space'),
      aggregatorUrl: readString('WALRUS_AGGREGATOR_URL', 'https://aggregator.walrus-testnet.walrus.space'),
      epochs: readNumber('WALRUS_STATE_EPOCHS', 5),
      stateBlobId: readString('WALRUS_STATE_BLOB_ID', ''),
      memwal: {
        enabled: readBoolean('MEMWAL_ENABLED', false),
        accountId: readString('MEMWAL_ACCOUNT_ID', ''),
        delegateKey: readString('MEMWAL_DELEGATE_KEY', ''),
        relayerUrl: readString('MEMWAL_RELAYER_URL', 'https://relayer-staging.memory.walrus.xyz'),
        namespace: readString('MEMWAL_NAMESPACE', 'defi-agent')
      }
    },
    loopStrategy: {
      ledgerPath: readString('STRATEGY_LEDGER_PATH', 'data/strategy-ledger.json'),
      enabled: readBoolean('LOOP_STRATEGY_ENABLED', false),
      executionEnabled: readBoolean('LOOP_EXECUTION_ENABLED', false),
      collateralAsset: readString('LOOP_COLLATERAL_ASSET', 'usdc').toLowerCase(),
      borrowAsset: readString('LOOP_BORROW_ASSET', 'sui').toLowerCase(),
      maxDepth: readNumber('LOOP_MAX_DEPTH', 1),
      minHealthFactor: readNumber('LOOP_MIN_HEALTH_FACTOR', 1.75),
      criticalHealthFactor: readNumber('LOOP_CRITICAL_HEALTH_FACTOR', 1.45),
      maxBorrowUsd: readNumber('LOOP_MAX_BORROW_USD', 25),
      maxCollateralUsd: readNumber('LOOP_MAX_COLLATERAL_USD', 100),
      minNetAprBps: readNumber('LOOP_MIN_NET_APR_BPS', 100),
      proposalTtlMs: readNumber('LOOP_PROPOSAL_TTL_MS', 300000),
      staleHeartbeatMs: readNumber('SUBAGENT_STALE_HEARTBEAT_MS', 600000),
      staleSnapshotMs: readNumber('LOOP_STALE_SNAPSHOT_MS', 600000),
      useExistingCollateral: readBoolean('LOOP_USE_EXISTING_COLLATERAL', true),
      borrowCapacityFraction: readNumber('LOOP_BORROW_CAPACITY_FRACTION', 0.25),
      executionClaimTtlMs: readNumber('LOOP_EXECUTION_CLAIM_TTL_MS', 120000),
      llmStrategistEnabled: readBoolean('SUBAGENT_LLM_STRATEGIST_ENABLED', false),
      mainAgentSupplyWhenLoopEnabled: readBoolean('MAIN_AGENT_SUPPLY_WHEN_LOOP_ENABLED', false)
    }
  };
}

function loadDotEnv(filePath: string): void {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const contents = fs.readFileSync(filePath, 'utf8');
  for (const line of contents.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const separator = trimmed.indexOf('=');
    if (separator === -1) {
      continue;
    }

    const key = trimmed.slice(0, separator).trim();
    const value = stripQuotes(trimmed.slice(separator + 1).trim());
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

function stripQuotes(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }

  return value;
}

function readString(name: string, fallback: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    return fallback;
  }

  return value;
}

function readBoolean(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined || value === '') {
    return fallback;
  }

  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function readNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    return fallback;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be a number`);
  }

  return parsed;
}

function readSuiNetwork(name: string, fallback: SuiNetwork): SuiNetwork {
  const value = readString(name, fallback).toLowerCase();
  if (value === 'mainnet' || value === 'testnet' || value === 'devnet') {
    return value;
  }

  throw new Error(`${name} must be one of mainnet, testnet, devnet`);
}

function readMemoryBackend(name: string, fallback: MemoryBackend): MemoryBackend {
  const value = readString(name, fallback).toLowerCase();
  if (value === 'file' || value === 'walrus') {
    return value;
  }

  throw new Error(`${name} must be either file or walrus`);
}

function readCsv(name: string): string[] {
  const raw = process.env[name];
  if (!raw) {
    return [];
  }

  return raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

function readLendingProtocols(name: string, fallback: LendingProtocol[]): LendingProtocol[] {
  const csv = readCsv(name).map((value) => value.toLowerCase());
  const valid = csv.filter(
    (value): value is LendingProtocol => value === 'suilend' || value === 'navi' || value === 'scallop'
  );
  return valid.length > 0 ? valid : fallback;
}

function readSupervisorRoles(
  name: string,
  fallback: Array<
    'main' | 'coordinator' | 'rate-scout' | 'position-risk' | 'loop-strategist' | 'executor' | 'unwind-guard'
  >
): Array<
  'main' | 'coordinator' | 'rate-scout' | 'position-risk' | 'loop-strategist' | 'executor' | 'unwind-guard'
> {
  const csv = readCsv(name).map((value) => value.toLowerCase());
  const valid = csv.filter(
    (
      value
    ): value is
      | 'main'
      | 'coordinator'
      | 'rate-scout'
      | 'position-risk'
      | 'loop-strategist'
      | 'executor'
      | 'unwind-guard' =>
      value === 'main' ||
      value === 'coordinator' ||
      value === 'rate-scout' ||
      value === 'position-risk' ||
      value === 'loop-strategist' ||
      value === 'executor' ||
      value === 'unwind-guard'
  );
  return valid.length > 0 ? valid : fallback;
}
