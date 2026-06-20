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
import {
  type BorrowAprPoint,
  deriveReserveFactorPct,
  type ReserveCurve,
  validatedBorrowAprPoints
} from '../../core/allocation.js';
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
            // Base lending rate + boosted incentive APR, matching the NAVI dApp's
            // "Total" supply APY (and the netSupplyApr the allocator uses).
            supplyApr:
              naviRateToPercent(pool, 'currentSupplyRate', 'supplyIncentiveApyInfo') +
              naviSupplyBoostApr(pool),
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
        // Base lending rate calibrates the reserve curve; the boosted incentive APR is
        // additive on top for display/ranking (and mirrored by the curve's reward APR).
        const baseSupplyApr = naviRateToPercent(pool, 'currentSupplyRate', 'supplyIncentiveApyInfo');
        const supplyApr = baseSupplyApr + naviSupplyBoostApr(pool);
        const borrowApr = naviRateToPercent(pool, 'currentBorrowRate', 'borrowIncentiveApyInfo');
        const decimals = oracleDecimals(pool);
        const price = oraclePrice(pool);
        return {
          coinType,
          symbol: symbolForCoinType(coinType),
          decimals,
          supplyApr,
          borrowApr,
          totalApr: supplyApr,
          price,
          allowed: this.isAssetAllowed(coinType),
          curve: buildNaviCurve(pool, coinType, decimals, price, baseSupplyApr, borrowApr)
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

// Incremental supply incentive APR (percent), i.e. the boosted reward token APR that
// is additive on top of the base `currentSupplyRate`. NAVI reports these incentive
// fields already as percentages (not RAY-scaled). We use `boostedApr` rather than the
// `apy` field, which is the TOTAL (base vault APR + boost) and would double-count the
// base supply rate that the reserve curve already models.
function naviSupplyBoostApr(pool: Record<string, unknown>): number {
  const incentive = pool.supplyIncentiveApyInfo as Record<string, unknown> | undefined;
  return numberOr(incentive?.boostedApr, 0);
}

// NAVI's rate factors are RAY-scaled (1e27); /1e25 yields percent (matches the
// currentBorrowRate/currentSupplyRate convention used by naviRateToPercent).
function rayToPercent(raw: unknown): number {
  const value = Number(raw);
  return Number.isFinite(value) ? value / NAVI_RAY_TO_PERCENT : Number.NaN;
}

function numberOr(raw: unknown, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

/**
 * Build the allocation-solver reserve curve for a NAVI pool. NAVI exposes a classic
 * Aave one-kink model in `borrowRateFactors.fields` (baseRate, multiplier,
 * jumpRateMultiplier, optimalUtilization) -> 3 control points at U=0, U=optimal, U=1.
 *
 * Scale-safety: liquidity magnitude is derived from USD pool values + price (reliable)
 * rather than ambiguously-scaled raw totals; the reserve factor is derived from the
 * known spot relationship instead of guessing reserveFactor units; and the kink curve
 * is validated against the live spot borrow APR, falling back to a spot-anchored
 * linear curve if the RAY assumption doesn't reproduce it.
 */
function buildNaviCurve(
  pool: Record<string, unknown>,
  coinType: string,
  decimals: number,
  price: number,
  spotSupplyApr: number,
  spotBorrowApr: number
): ReserveCurve | undefined {
  const scale = 10 ** decimals;

  // Liquidity from USD values + price -> human -> raw token units.
  const supplyUsd = numberOr(pool.poolSupplyValue, Number.NaN);
  const borrowUsd = numberOr(pool.poolBorrowValue, Number.NaN);
  let humanSupply: number;
  let humanBorrow: number;
  if (price > 0 && Number.isFinite(supplyUsd) && Number.isFinite(borrowUsd)) {
    humanSupply = supplyUsd / price;
    humanBorrow = borrowUsd / price;
  } else {
    // Fallback: treat totals as raw token units.
    humanBorrow = numberOr(pool.totalBorrow, 0) / scale;
    humanSupply = numberOr(pool.totalSupply, 0) / scale;
  }
  const utilization = humanSupply > 0 ? clampFraction(humanBorrow / humanSupply) : 0;

  const factors = ((pool.borrowRateFactors as Record<string, unknown> | undefined)?.fields ?? {}) as Record<
    string,
    unknown
  >;
  const baseApr = rayToPercent(factors.baseRate);
  const multiplier = rayToPercent(factors.multiplier);
  const jump = rayToPercent(factors.jumpRateMultiplier);
  let optimalUtil = numberOr(factors.optimalUtilization, Number.NaN) / 1e27;
  if (optimalUtil > 1) {
    optimalUtil /= 100; // tolerate a percent-scaled value
  }

  const candidate: BorrowAprPoint[] = [];
  if (
    Number.isFinite(baseApr) &&
    Number.isFinite(multiplier) &&
    Number.isFinite(jump) &&
    optimalUtil > 0 &&
    optimalUtil < 1
  ) {
    candidate.push({ util: 0, apr: baseApr });
    candidate.push({ util: optimalUtil, apr: baseApr + multiplier });
    candidate.push({ util: 1, apr: baseApr + multiplier + jump });
  }

  // NAVI's `apy` field is the TOTAL supply APY (vaultApr + boostedApr), so adding it
  // on top of the curve-derived base supply rate would double-count the base. The
  // reward is the incremental incentive portion only: `boostedApr`.
  const rewardSupplyApr = naviSupplyBoostApr(pool);

  // Remaining deposit headroom from USD cap, scale-safe.
  const capUsd = numberOr(pool.poolSupplyCapValue, Number.NaN);
  let depositCapRaw: string | undefined;
  if (price > 0 && Number.isFinite(capUsd) && Number.isFinite(supplyUsd) && capUsd > supplyUsd) {
    depositCapRaw = String(Math.floor(((capUsd - supplyUsd) / price) * scale));
  }

  return {
    protocol: 'navi',
    asset: symbolForCoinType(coinType),
    coinType,
    borrowAprPoints: validatedBorrowAprPoints(candidate, utilization, spotBorrowApr),
    reserveFactorPct: deriveReserveFactorPct(spotBorrowApr, spotSupplyApr, utilization),
    borrowedRaw: String(Math.floor(Math.max(0, humanBorrow) * scale)),
    availableLiquidityRaw: String(Math.floor(Math.max(0, humanSupply - humanBorrow) * scale)),
    depositCapRaw,
    decimals,
    price,
    rewardSupplyApr
  };
}

function clampFraction(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
