import { Transaction } from '@mysten/sui/transactions';
import { normalizeStructTag } from '@mysten/sui/utils';
import {
  borrowCoinPTB,
  depositCoinPTB,
  getHealthFactor,
  getLendingState,
  getPool,
  getPools,
  getSimulatedHealthFactor,
  PoolOperator,
  repayCoinPTB,
  updateOraclePriceBeforeUserOperationPTB,
  withdrawCoinPTB
} from '@naviprotocol/lending';
import type {
  AppConfig,
  ExecuteTransactionResult,
  LendingMarketsResponse,
  LendingProtocol,
  LendingProtocolClient,
  LendingRateRow,
  LendingWriteParams,
  Logger,
  NormalizedPosition,
  NormalizedPositions
} from '../../types.js';
import type { SuiExecutionClient } from './suiExecutionClient.js';

interface NaviClientOptions {
  execution: SuiExecutionClient;
  config: AppConfig;
  logger: Logger;
}

type NaviEnv = 'prod' | 'dev';

/**
 * NAVI is address-based: there is no obligation object, so writes operate on the
 * sender directly. Deposits/repays take a coin input (built via the execution
 * client's coinForAmount); withdraws/borrows return a coin we transfer back to the
 * wallet. Reads/positions/health use NAVI's own client; PTBs are signed through
 * our single execution-client signing path.
 */
export class NaviClient implements LendingProtocolClient {
  readonly name: LendingProtocol = 'navi';
  readonly requiresObligationForWrite = false;
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

  private get env(): NaviEnv {
    return this.config.sui.network === 'mainnet' ? 'prod' : 'dev';
  }

  resolveCoinType(asset: string): string {
    const key = asset.trim().toLowerCase();
    if (key === 'usdc') {
      return this.config.sui.usdcCoinType;
    }
    if (key === 'sui') {
      return this.config.sui.suiCoinType;
    }
    return asset;
  }

  isAssetAllowed(coinType: string): boolean {
    const allowed = this.config.sui.allowedAssets;
    if (allowed.length === 0) {
      return true;
    }
    const normalized = normalizeCoin(coinType);
    return allowed.some((entry) => normalizeCoin(this.resolveCoinType(entry)) === normalized);
  }

  async getRates(assets: string[]): Promise<LendingRateRow[]> {
    if (!this.enabled) {
      return [];
    }

    try {
      const pools = await this.fetchPools();
      return assets.map((asset) => {
        const coinType = this.resolveCoinType(asset);
        const pool = this.findPool(pools, coinType);
        if (!pool) {
          return { asset, coinType };
        }

        return {
          asset,
          coinType,
          navi: {
            supplyApr: naviRateToPercent(pool, 'currentSupplyRate', 'supplyIncentiveApyInfo'),
            borrowApr: naviRateToPercent(pool, 'currentBorrowRate', 'borrowIncentiveApyInfo')
          }
        };
      });
    } catch (error: unknown) {
      this.logger.warn('NAVI rate fetch failed', { error: errorMessage(error) });
      return [];
    }
  }

  /** Markets in the shared shape so the router can rank NAVI alongside Suilend. */
  async getMarkets(): Promise<LendingMarketsResponse> {
    const pools = await this.fetchPools();
    const markets = pools
      .map((pool) => {
        // NAVI returns coin types without the 0x prefix; canonicalize so downstream
        // matching against config coin types (which are 0x-prefixed) succeeds.
        const coinType = withHexPrefix(String(pool.coinType ?? ''));
        const supplyApr = naviRateToPercent(pool, 'currentSupplyRate', 'supplyIncentiveApyInfo');
        const borrowApr = naviRateToPercent(pool, 'currentBorrowRate', 'borrowIncentiveApyInfo');
        return {
          coinType,
          symbol: symbolForCoinType(coinType),
          decimals: oracleDecimals(pool),
          supplyApr,
          borrowApr,
          totalApr: supplyApr,
          price: oraclePrice(pool),
          allowed: this.isAssetAllowed(coinType)
        };
      })
      .filter((market) => market.coinType && market.allowed)
      .sort((a, b) => b.totalApr - a.totalApr);

    return { markets };
  }

  async getPositions(owner = this.config.agent.walletAddress): Promise<NormalizedPositions> {
    const empty: NormalizedPositions = {
      protocol: 'navi',
      healthFactor: Number.POSITIVE_INFINITY,
      borrowLimitUsd: 0,
      weightedBorrowsUsd: 0,
      depositedAmountUsd: 0,
      borrowedAmountUsd: 0,
      deposits: [],
      borrows: []
    };

    if (!owner) {
      return empty;
    }

    const [state, healthFactor] = await Promise.all([
      getLendingState(owner, { env: this.env, disableCache: true }),
      getHealthFactor(owner, { env: this.env }).catch(() => Number.POSITIVE_INFINITY)
    ]);

    const deposits: NormalizedPosition[] = [];
    const borrows: NormalizedPosition[] = [];
    let depositedAmountUsd = 0;
    let borrowedAmountUsd = 0;

    for (const info of state as unknown as Record<string, unknown>[]) {
      const pool = (info.pool ?? {}) as Record<string, unknown>;
      const coinType = withHexPrefix(String(pool.coinType ?? ''));
      const symbol = symbolForCoinType(coinType);
      const decimals = oracleDecimals(pool);
      const price = oraclePrice(pool);

      const supplyRaw = String(info.supplyBalance ?? '0');
      const borrowRaw = String(info.borrowBalance ?? '0');
      const supplyUsd = toUsd(supplyRaw, decimals, price);
      const borrowUsd = toUsd(borrowRaw, decimals, price);

      if (Number(supplyRaw) > 0) {
        depositedAmountUsd += supplyUsd;
        deposits.push({ coinType, symbol, amount: supplyRaw, amountUsd: supplyUsd, side: 'deposit' });
      }
      if (Number(borrowRaw) > 0) {
        borrowedAmountUsd += borrowUsd;
        borrows.push({ coinType, symbol, amount: borrowRaw, amountUsd: borrowUsd, side: 'borrow' });
      }
    }

    return {
      ...empty,
      healthFactor,
      // NAVI exposes a single HF; surface borrowed USD as the weighted figure so the
      // shared simulate fallback stays sane. borrowLimit is implied by the live HF.
      borrowLimitUsd: Number.isFinite(healthFactor) ? healthFactor * borrowedAmountUsd : 0,
      weightedBorrowsUsd: borrowedAmountUsd,
      depositedAmountUsd,
      borrowedAmountUsd,
      deposits,
      borrows
    };
  }

  async executeSupply({ coinType, rawAmount }: LendingWriteParams): Promise<ExecuteTransactionResult> {
    const tx = new Transaction();
    const coin = this.execution.coinForAmount(tx, coinType, rawAmount);
    await depositCoinPTB(tx, coinType, coin, { env: this.env });
    return this.execution.signAndExecute(tx);
  }

  async executeWithdraw({ coinType, rawAmount }: LendingWriteParams): Promise<ExecuteTransactionResult> {
    const tx = new Transaction();
    await this.refreshOraclePrices(tx, coinType);
    const withdrawn = await withdrawCoinPTB(tx, coinType, Number(rawAmount), { env: this.env });
    tx.transferObjects([withdrawn], this.config.agent.walletAddress);
    return this.execution.signAndExecute(tx);
  }

  async executeBorrow({ coinType, rawAmount }: LendingWriteParams): Promise<ExecuteTransactionResult> {
    const tx = new Transaction();
    await this.refreshOraclePrices(tx, coinType);
    const borrowed = await borrowCoinPTB(tx, coinType, Number(rawAmount), { env: this.env });
    tx.transferObjects([borrowed], this.config.agent.walletAddress);
    return this.execution.signAndExecute(tx);
  }

  /**
   * NAVI's value-computing ops (withdraw/borrow) abort with a stale-oracle error
   * (calculator::calculate_value, code 1502) unless Pyth prices are refreshed in the
   * same PTB. Deposit/repay don't need this.
   */
  private async refreshOraclePrices(tx: Transaction, coinType: string): Promise<void> {
    const pool = await getPool(coinType, { env: this.env });
    await updateOraclePriceBeforeUserOperationPTB(tx, this.config.agent.walletAddress, [pool], {
      env: this.env
    });
  }

  async executeRepay({ coinType, rawAmount }: LendingWriteParams): Promise<ExecuteTransactionResult> {
    const tx = new Transaction();
    const coin = this.execution.coinForAmount(tx, coinType, rawAmount);
    await repayCoinPTB(tx, coinType, coin, { env: this.env });
    return this.execution.signAndExecute(tx);
  }

  async simulateHealthFactorAfterBorrow({
    coinType,
    rawAmount
  }: {
    coinType: string;
    rawAmount: string;
    borrowUsd: number;
    positions: NormalizedPositions;
  }): Promise<number> {
    const owner = this.config.agent.walletAddress;
    if (!owner) {
      return 0;
    }

    try {
      return await getSimulatedHealthFactor(
        owner,
        coinType,
        [{ type: PoolOperator.Borrow, amount: Number(rawAmount) }],
        { env: this.env }
      );
    } catch (error: unknown) {
      this.logger.warn('NAVI health factor simulation failed; failing closed', {
        error: errorMessage(error)
      });
      // Fail closed: an unknown projected HF must not pass the policy floor.
      return 0;
    }
  }

  private async fetchPools(): Promise<Record<string, unknown>[]> {
    const pools = await getPools({
      client: this.execution.client,
      env: this.env
    } as unknown as Parameters<typeof getPools>[0]);
    return pools as unknown as Record<string, unknown>[];
  }

  private findPool(pools: Record<string, unknown>[], coinType: string): Record<string, unknown> | undefined {
    return pools.find((entry) => normalizeCoin(String(entry.coinType ?? '')) === normalizeCoin(coinType));
  }
}

function normalizeCoin(value: string): string {
  try {
    return normalizeStructTag(value).toLowerCase();
  } catch {
    return value.toLowerCase().replace(/^0x/, '');
  }
}

function symbolForCoinType(coinType: string): string {
  const tail = coinType.split('::').pop();
  return (tail ?? coinType).toUpperCase();
}

/** NAVI omits the 0x prefix on coin types; restore it for a canonical struct tag. */
function withHexPrefix(coinType: string): string {
  return coinType.includes('::') && !coinType.startsWith('0x') ? `0x${coinType}` : coinType;
}

function oraclePrice(pool: Record<string, unknown>): number {
  const oracle = pool.oracle as Record<string, unknown> | undefined;
  const price = Number(oracle?.price ?? 0);
  return Number.isFinite(price) ? price : 0;
}

function oracleDecimals(pool: Record<string, unknown>): number {
  const coinType = String(pool.coinType ?? '');
  if (coinType.toLowerCase().includes('usdc')) {
    return 6;
  }
  return 9;
}

function toUsd(rawAmount: string, decimals: number, price: number): number {
  const amount = Number(rawAmount) / 10 ** decimals;
  return Number.isFinite(amount) ? amount * price : 0;
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
