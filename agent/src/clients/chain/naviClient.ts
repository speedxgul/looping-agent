import { normalizeStructTag } from '@mysten/sui/utils';
import { getPools } from '@naviprotocol/lending';
import type { AppConfig, LendingRateRow, Logger } from '../../types.js';
import type { SuiExecutionClient } from './suiExecutionClient.js';

interface NaviClientOptions {
  execution: SuiExecutionClient;
  config: AppConfig;
  logger: Logger;
}

export class NaviClient {
  private readonly execution: SuiExecutionClient;
  private readonly config: AppConfig;
  private readonly logger: Logger;

  constructor({ execution, config, logger }: NaviClientOptions) {
    this.execution = execution;
    this.config = config;
    this.logger = logger;
  }

  get enabled(): boolean {
    return this.config.sui.protocols.navi.enabled;
  }

  async getRates(assets: string[]): Promise<LendingRateRow[]> {
    if (!this.enabled) {
      return [];
    }

    try {
      const pools = await getPools({
        client: this.execution.client,
        env: this.config.sui.network === 'mainnet' ? 'prod' : 'dev'
      } as unknown as Parameters<typeof getPools>[0]);

      return assets.map((asset) => {
        const coinType = this.resolveCoinType(asset);
        const pool = pools.find(
          (entry) => normalizeCoin(String(entry.coinType ?? '')) === normalizeCoin(coinType)
        );
        if (!pool) {
          return { asset, coinType };
        }

        const supplyApr = naviRateToPercent(pool, 'currentSupplyRate', 'supplyIncentiveApyInfo');
        const borrowApr = naviRateToPercent(pool, 'currentBorrowRate', 'borrowIncentiveApyInfo');

        return {
          asset,
          coinType,
          navi: { supplyApr, borrowApr }
        };
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn('NAVI rate fetch failed', { error: message });
      return [];
    }
  }

  private resolveCoinType(asset: string): string {
    const key = asset.toLowerCase();
    if (key === 'usdc') {
      return this.config.sui.usdcCoinType;
    }
    if (key === 'sui') {
      return this.config.sui.suiCoinType;
    }

    return asset;
  }
}

function normalizeCoin(value: string): string {
  try {
    return normalizeStructTag(value).toLowerCase();
  } catch {
    return value.toLowerCase().replace(/^0x/, '');
  }
}

// NAVI stores the base interest rate in RAY scale (1e27). Dividing by 1e25
// yields the APR as a percentage (e.g. 5.8047e25 / 1e25 = 5.8047%). Falls back
// to the incentive `vaultApr` (already a percentage string) when present.
const NAVI_RAY_TO_PERCENT = 1e25;

function naviRateToPercent(pool: Record<string, unknown>, rateKey: string, incentiveKey: string): number {
  const raw = pool[rateKey];
  if (typeof raw === 'string' && raw.trim()) {
    const parsed = Number(raw) / NAVI_RAY_TO_PERCENT;
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw / NAVI_RAY_TO_PERCENT;
  }

  const incentive = pool[incentiveKey];
  if (incentive && typeof incentive === 'object') {
    const vaultApr = (incentive as Record<string, unknown>).vaultApr;
    const parsed = Number(vaultApr);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return 0;
}
