import { normalizeStructTag } from '@mysten/sui/utils';
import { Scallop } from '@scallop-io/sui-scallop-sdk';
import type { AppConfig, LendingRateRow, Logger, SuiNetwork } from '../../types.js';

interface ScallopClientOptions {
  network: SuiNetwork;
  config: AppConfig;
  logger: Logger;
}

export class ScallopClient {
  private readonly network: SuiNetwork;
  private readonly config: AppConfig;
  private readonly logger: Logger;
  private scallop: Scallop | null = null;

  constructor({ network, config, logger }: ScallopClientOptions) {
    this.network = network;
    this.config = config;
    this.logger = logger;
  }

  get enabled(): boolean {
    return this.config.sui.protocols.scallop.enabled;
  }

  private async getScallop(): Promise<Scallop> {
    if (this.scallop) {
      return this.scallop;
    }

    const scallop = new Scallop({
      networkType: this.network === 'mainnet' ? 'mainnet' : 'testnet'
    });
    await scallop.init();
    this.scallop = scallop;
    return scallop;
  }

  async getRates(assets: string[]): Promise<LendingRateRow[]> {
    if (!this.enabled) {
      return [];
    }

    try {
      const scallop = await this.getScallop();
      const indexer = await scallop.createScallopIndexer();
      const marketPools = await indexer.getMarketPools();
      // getMarketPools() returns an object keyed by coin name, not an array.
      const pools = Array.isArray(marketPools)
        ? (marketPools as Record<string, unknown>[])
        : (Object.values(marketPools as Record<string, unknown>) as Record<string, unknown>[]);

      return assets.map((asset) => {
        const coinType = this.resolveCoinType(asset);
        const shorthand = asset.trim().toLowerCase();
        const pool = pools.find((entry) => {
          const entryCoinType = normalizeCoin(String(entry.coinType ?? ''));
          const entryName = String(entry.coinName ?? '').toLowerCase();
          return entryCoinType === normalizeCoin(coinType) || entryName === shorthand;
        });
        if (!pool) {
          return { asset, coinType };
        }

        // Scallop APRs are fractions (0.052 = 5.2%); scale to percent.
        const supplyApr = readApr(pool, ['supplyApr', 'supplyApy', 'supplyRate']) * 100;
        const borrowApr = readApr(pool, ['borrowApr', 'borrowApy', 'borrowRate']) * 100;

        return {
          asset,
          coinType,
          scallop: { supplyApr, borrowApr }
        };
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn('Scallop rate fetch failed', { error: message });
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

function readApr(pool: Record<string, unknown>, keys: string[]): number {
  for (const key of keys) {
    const value = pool[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }

  return 0;
}
