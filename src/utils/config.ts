import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig, MemoryBackend, SuiNetwork } from '../types.js';
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
      autonomyIntervalMs: readNumber('AUTONOMY_INTERVAL_MS', 900000)
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
      defaultAssets: {
        usdc: readString('SUI_DEFAULT_USDC_ASSET', 'usdc'),
        sui: readString('SUI_DEFAULT_SUI_ASSET', 'sui')
      },
      protocols: {
        suilend: { enabled: readBoolean('ENABLE_SUILEND', true) },
        navi: { enabled: readBoolean('ENABLE_NAVI_READS', true) },
        scallop: { enabled: readBoolean('ENABLE_SCALLOP_READS', true) }
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
