import type { Transaction } from '@mysten/sui/transactions';
import { normalizeStructTag } from '@mysten/sui/utils';
import { Scallop, type ScallopClient as ScallopSdkClient } from '@scallop-io/sui-scallop-sdk';
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
  NormalizedPositions,
  SuiNetwork
} from '../../types.js';
import type { SuiExecutionClient } from './suiExecutionClient.js';

interface ScallopClientOptions {
  execution: SuiExecutionClient;
  network: SuiNetwork;
  config: AppConfig;
  logger: Logger;
}

/**
 * Scallop writes go through the high-level ScallopClient with `sign=false`, which
 * returns a @mysten/sui Transaction we sign via our single execution-client path.
 * "supply" maps to Scallop's lending `deposit` (yield-earning). Borrowing requires
 * an obligation backed by collateral that already exists (Scallop separates lending
 * deposits from collateral); executeBorrow/Repay resolve the obligation + key from
 * the wallet's obligations.
 */
export class ScallopClient implements LendingProtocolClient {
  readonly name: LendingProtocol = 'scallop';
  readonly requiresObligationForWrite = false;
  private readonly execution: SuiExecutionClient;
  private readonly network: SuiNetwork;
  private readonly config: AppConfig;
  private readonly logger: Logger;
  private scallop: Scallop | null = null;
  private sdkClient: ScallopSdkClient | null = null;

  constructor({ execution, network, config, logger }: ScallopClientOptions) {
    this.execution = execution;
    this.network = network;
    this.config = config;
    this.logger = logger;
  }

  get enabled(): boolean {
    return this.config.sui.protocols.scallop.enabled;
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

  private async getScallop(): Promise<Scallop> {
    if (this.scallop) {
      return this.scallop;
    }
    const scallop = new Scallop({
      networkType: this.network === 'mainnet' ? 'mainnet' : 'testnet',
      walletAddress: this.config.agent.walletAddress || undefined
    });
    await scallop.init();
    this.scallop = scallop;
    return scallop;
  }

  private async getSdkClient(): Promise<ScallopSdkClient> {
    if (this.sdkClient) {
      return this.sdkClient;
    }
    const scallop = await this.getScallop();
    this.sdkClient = await scallop.createScallopClient();
    return this.sdkClient;
  }

  async getRates(assets: string[]): Promise<LendingRateRow[]> {
    if (!this.enabled) {
      return [];
    }

    try {
      const pools = await this.fetchMarketPools();
      return assets.map((asset) => {
        const pool = this.findPool(pools, asset);
        if (!pool) {
          return { asset, coinType: this.resolveCoinType(asset) };
        }
        return {
          asset,
          coinType: this.resolveCoinType(asset),
          scallop: {
            supplyApr: readApr(pool, ['supplyApr', 'supplyApy', 'supplyRate']) * 100,
            borrowApr: readApr(pool, ['borrowApr', 'borrowApy', 'borrowRate']) * 100
          }
        };
      });
    } catch (error: unknown) {
      this.logger.warn('Scallop rate fetch failed', { error: errorMessage(error) });
      return [];
    }
  }

  async getMarkets(): Promise<LendingMarketsResponse> {
    const pools = await this.fetchMarketPools();
    const markets = pools
      .map((pool) => {
        const coinType = String(pool.coinType ?? '');
        const supplyApr = readApr(pool, ['supplyApr', 'supplyApy', 'supplyRate']) * 100;
        const borrowApr = readApr(pool, ['borrowApr', 'borrowApy', 'borrowRate']) * 100;
        return {
          coinType,
          symbol: String(pool.coinName ?? symbolForCoinType(coinType)).toUpperCase(),
          decimals: Number(pool.coinDecimals ?? 9) || 9,
          supplyApr,
          borrowApr,
          totalApr: supplyApr,
          price: Number(pool.coinPrice ?? 0) || 0,
          allowed: coinType ? this.isAssetAllowed(coinType) : false
        };
      })
      .filter((market) => market.coinType && market.allowed)
      .sort((a, b) => b.totalApr - a.totalApr);

    return { markets };
  }

  async getPositions(owner = this.config.agent.walletAddress): Promise<NormalizedPositions> {
    const empty: NormalizedPositions = {
      protocol: 'scallop',
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

    try {
      const client = await this.getSdkClient();
      const portfolio = await client.query.getUserPortfolio({ walletAddress: owner });
      const obligations = await client.getObligations(owner).catch(() => []);
      const primaryObligation = obligations[0];

      const deposits: NormalizedPosition[] = (portfolio.lendings ?? []).map((lending) => ({
        coinType: lending.coinType,
        symbol: lending.symbol,
        amount: String(lending.suppliedCoin ?? 0),
        amountUsd: Number(lending.suppliedValue ?? 0),
        side: 'deposit' as const
      }));

      const borrowing = (portfolio.borrowings ?? [])[0];
      const borrows: NormalizedPosition[] = (borrowing?.borrowedPools ?? []).map(
        (pool: Record<string, unknown>) => ({
          coinType: String(pool.coinType ?? ''),
          symbol: String(pool.symbol ?? ''),
          amount: String(pool.borrowedCoin ?? 0),
          amountUsd: Number(pool.borrowedValueInUsd ?? 0),
          side: 'borrow' as const
        })
      );

      const totalDebtUsd = Number(borrowing?.totalDebtsInUsd ?? 0);
      // Scallop liquidates when debt reaches the unhealthy-collateral threshold, so
      // HF = unhealthyCollateral / debt matches the Suilend (>1 healthy) convention.
      const unhealthyCollateralUsd = Number(borrowing?.totalUnhealthyCollateralInUsd ?? 0);
      const healthFactor =
        totalDebtUsd > 0 ? unhealthyCollateralUsd / totalDebtUsd : Number.POSITIVE_INFINITY;

      return {
        protocol: 'scallop',
        healthFactor,
        borrowLimitUsd: unhealthyCollateralUsd,
        weightedBorrowsUsd: totalDebtUsd,
        depositedAmountUsd: deposits.reduce((sum, d) => sum + d.amountUsd, 0),
        borrowedAmountUsd: totalDebtUsd,
        deposits,
        borrows,
        obligationId: borrowing?.obligationId ?? primaryObligation?.id ?? null,
        obligationKeyId: primaryObligation?.keyId ?? null
      };
    } catch (error: unknown) {
      this.logger.warn('Scallop positions fetch failed', { error: errorMessage(error) });
      return empty;
    }
  }

  async executeSupply({ asset, rawAmount }: LendingWriteParams): Promise<ExecuteTransactionResult> {
    const client = await this.getSdkClient();
    const tx = (await client.deposit(
      this.coinName(asset),
      Number(rawAmount),
      false,
      this.config.agent.walletAddress
    )) as unknown as Transaction;
    return this.execution.signAndExecute(tx);
  }

  async executeWithdraw({ asset, rawAmount }: LendingWriteParams): Promise<ExecuteTransactionResult> {
    const client = await this.getSdkClient();
    const coinName = this.coinName(asset);
    // Scallop's withdraw amount is in sCoin (market-coin) units, not underlying.
    // Convert the requested underlying via the sCoin balance / supplied-underlying ratio.
    const sCoinAmount = await this.underlyingToSCoinAmount(coinName, rawAmount);
    const tx = (await client.withdraw(
      coinName,
      sCoinAmount,
      false,
      this.config.agent.walletAddress
    )) as unknown as Transaction;
    return this.execution.signAndExecute(tx);
  }

  private async underlyingToSCoinAmount(coinName: string, underlyingRaw: string): Promise<number> {
    const client = await this.getSdkClient();
    const owner = this.config.agent.walletAddress;

    const sCoinType = client.utils.parseSCoinType(`s${coinName}`);
    const sCoinBalanceRaw = BigInt(await this.execution.getRawBalance(sCoinType, owner));
    if (sCoinBalanceRaw <= 0n) {
      throw new Error(`No Scallop ${coinName} market coin (s${coinName}) found to withdraw`);
    }

    const portfolio = await client.query.getUserPortfolio({ walletAddress: owner });
    const lending = (portfolio.lendings ?? []).find((l) => l.coinName === coinName);
    if (!lending) {
      // No portfolio entry but a balance exists — redeem the whole sCoin balance.
      return Number(sCoinBalanceRaw);
    }

    const suppliedUnderlyingRaw = BigInt(
      Math.round(Number(lending.suppliedCoin ?? 0) * 10 ** Number(lending.coinDecimals ?? 9))
    );
    const requested = BigInt(underlyingRaw);

    // Withdraw-all when the request meets/exceeds the supplied underlying.
    if (suppliedUnderlyingRaw <= 0n || requested >= suppliedUnderlyingRaw) {
      return Number(sCoinBalanceRaw);
    }

    const sCoinAmount = (requested * sCoinBalanceRaw) / suppliedUnderlyingRaw;
    return Number(sCoinAmount > sCoinBalanceRaw ? sCoinBalanceRaw : sCoinAmount);
  }

  async executeBorrow({
    asset,
    rawAmount,
    positions
  }: LendingWriteParams): Promise<ExecuteTransactionResult> {
    const { obligationId, obligationKeyId } = await this.requireObligation(positions);
    const client = await this.getSdkClient();
    const tx = (await client.borrow(
      this.coinName(asset),
      Number(rawAmount),
      false,
      obligationId,
      obligationKeyId,
      this.config.agent.walletAddress
    )) as unknown as Transaction;
    return this.execution.signAndExecute(tx);
  }

  async executeRepay({ asset, rawAmount, positions }: LendingWriteParams): Promise<ExecuteTransactionResult> {
    const { obligationId, obligationKeyId } = await this.requireObligation(positions);
    const client = await this.getSdkClient();
    const tx = (await client.repay(
      this.coinName(asset),
      Number(rawAmount),
      false,
      obligationId,
      obligationKeyId,
      this.config.agent.walletAddress
    )) as unknown as Transaction;
    return this.execution.signAndExecute(tx);
  }

  async simulateHealthFactorAfterBorrow({
    borrowUsd,
    positions
  }: {
    coinType: string;
    rawAmount: string;
    borrowUsd: number;
    positions: NormalizedPositions;
  }): Promise<number> {
    const newDebt = positions.weightedBorrowsUsd + borrowUsd;
    if (newDebt <= 0) {
      return Number.POSITIVE_INFINITY;
    }
    // No collateral threshold known → cannot borrow safely; fail closed.
    if (positions.borrowLimitUsd <= 0) {
      return 0;
    }
    return positions.borrowLimitUsd / newDebt;
  }

  private async requireObligation(
    positions?: NormalizedPositions
  ): Promise<{ obligationId: string; obligationKeyId: string }> {
    let obligationId = positions?.obligationId ?? undefined;
    let obligationKeyId = positions?.obligationKeyId ?? undefined;

    if (!obligationId || !obligationKeyId) {
      const client = await this.getSdkClient();
      const obligations = await client.getObligations(this.config.agent.walletAddress);
      const first = obligations[0];
      obligationId = obligationId ?? first?.id;
      obligationKeyId = obligationKeyId ?? first?.keyId;
    }

    if (!obligationId || !obligationKeyId) {
      throw new Error('No Scallop obligation found; deposit collateral to open one before borrowing');
    }
    return { obligationId, obligationKeyId };
  }

  /** Map an asset shorthand or coin type to a Scallop pool coin name (e.g. "usdc", "sui"). */
  private coinName(asset: string): string {
    const trimmed = asset.trim();
    if (!trimmed.includes('::')) {
      return trimmed.toLowerCase();
    }
    if (normalizeCoin(trimmed) === normalizeCoin(this.config.sui.usdcCoinType)) {
      return 'usdc';
    }
    if (normalizeCoin(trimmed) === normalizeCoin(this.config.sui.suiCoinType)) {
      return 'sui';
    }
    return (trimmed.split('::').pop() ?? trimmed).toLowerCase();
  }

  private async fetchMarketPools(): Promise<Record<string, unknown>[]> {
    const scallop = await this.getScallop();
    const indexer = await scallop.createScallopIndexer();
    const marketPools = await indexer.getMarketPools();
    return Array.isArray(marketPools)
      ? (marketPools as Record<string, unknown>[])
      : (Object.values(marketPools as Record<string, unknown>) as Record<string, unknown>[]);
  }

  private findPool(pools: Record<string, unknown>[], asset: string): Record<string, unknown> | undefined {
    const coinType = this.resolveCoinType(asset);
    const shorthand = asset.trim().toLowerCase();
    return pools.find((entry) => {
      const entryCoinType = normalizeCoin(String(entry.coinType ?? ''));
      const entryName = String(entry.coinName ?? '').toLowerCase();
      return entryCoinType === normalizeCoin(coinType) || entryName === shorthand;
    });
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
