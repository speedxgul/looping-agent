import { Transaction } from '@mysten/sui/transactions';
import { normalizeStructTag } from '@mysten/sui/utils';
import {
  initializeSuilend,
  LENDING_MARKET_ID,
  LENDING_MARKET_TYPE,
  type ParsedObligation,
  type ParsedReserve,
  parseObligation,
  SuilendClient as SuilendSdkClient
} from '@suilend/sdk';
import { createObligationIfNoneExists, sendObligationToUser } from '@suilend/sdk/lib/transactions';
import { BigNumber } from 'bignumber.js';
import { type BorrowAprPoint, type ReserveCurve, validatedBorrowAprPoints } from '../../core/allocation.js';
import type {
  AppConfig,
  ExecuteTransactionResult,
  LendingProtocol,
  LendingProtocolClient,
  LendingWriteParams,
  Logger,
  NormalizedPositions,
  SuilendMarketsResponse,
  SuilendObligationResponse
} from '../../types.js';
import type { SuiExecutionClient } from './suiExecutionClient.js';

interface AgentSuilendClientOptions {
  execution: SuiExecutionClient;
  config: AppConfig;
  logger: Logger;
}

interface SuilendContext {
  client: SuilendSdkClient;
  reserveMap: Record<string, ParsedReserve>;
}

export class SuilendClient implements LendingProtocolClient {
  readonly name: LendingProtocol = 'suilend';
  readonly requiresObligationForWrite = true;
  private readonly execution: SuiExecutionClient;
  private readonly config: AppConfig;
  private readonly logger: Logger;
  private context: SuilendContext | null = null;

  constructor({ execution, config, logger }: AgentSuilendClientOptions) {
    this.execution = execution;
    this.config = config;
    this.logger = logger;
  }

  get enabled(): boolean {
    return this.config.sui.protocols.suilend.enabled;
  }

  private async getContext(): Promise<SuilendContext> {
    if (this.context) {
      return this.context;
    }

    const client = await SuilendSdkClient.initialize(
      LENDING_MARKET_ID,
      LENDING_MARKET_TYPE,
      this.execution.client
    );
    const { reserveMap } = await initializeSuilend(this.execution.client, client);
    this.context = { client, reserveMap };
    return this.context;
  }

  isAssetAllowed(coinType: string): boolean {
    const allowed = this.config.sui.allowedAssets;
    if (allowed.length === 0) {
      return true;
    }

    const normalized = normalizeCoin(coinType);
    const shorthand = this.shorthandFor(coinType);
    return allowed.some((entry) => {
      const entryLower = entry.trim().toLowerCase();
      return entryLower === shorthand || normalizeCoin(entry) === normalized;
    });
  }

  resolveCoinType(asset: string): string {
    const trimmed = asset.trim();
    if (trimmed.includes('::')) {
      return trimmed;
    }

    const key = trimmed.toLowerCase();
    if (key === 'usdc') {
      return this.config.sui.usdcCoinType;
    }
    if (key === 'sui') {
      return this.config.sui.suiCoinType;
    }

    return trimmed;
  }

  async getMarkets(): Promise<SuilendMarketsResponse> {
    const { reserveMap } = await this.getContext();
    const markets = Object.values(reserveMap)
      .map((reserve) => ({
        coinType: reserve.coinType,
        symbol: reserve.token.symbol,
        decimals: reserve.mintDecimals,
        supplyApr: reserve.depositAprPercent.toNumber(),
        borrowApr: reserve.borrowAprPercent.toNumber(),
        totalApr: reserve.depositAprPercent.toNumber(),
        price: reserve.price.toNumber(),
        allowed: this.isAssetAllowed(reserve.coinType),
        curve: this.buildCurve(reserve)
      }))
      .filter((market) => market.allowed)
      .sort((a, b) => b.totalApr - a.totalApr);

    return { markets };
  }

  /**
   * Build the reserve rate curve for the allocation solver. Suilend is the richest
   * source: `config.interestRate` IS the borrow curve as `(utilPercent, aprPercent)`
   * control points, so we pass it through directly. Amounts are human BigNumbers, so
   * we re-scale to raw token units to match the solver's raw-amount contract.
   */
  private buildCurve(reserve: ParsedReserve): ReserveCurve {
    const decimals = reserve.mintDecimals;
    const scale = new BigNumber(10).pow(decimals);

    const points: BorrowAprPoint[] = reserve.config.interestRate
      .map((point) => ({ util: point.utilPercent.toNumber() / 100, apr: point.aprPercent.toNumber() }))
      .sort((a, b) => a.util - b.util);

    const utilization = reserve.utilizationPercent.toNumber() / 100;
    const spotBorrowApr = reserve.borrowAprPercent.toNumber();

    // depositLimit and depositedAmount are both human units; remaining headroom -> raw.
    const remainingDeposit = reserve.config.depositLimit.minus(reserve.depositedAmount);
    const depositCapRaw = remainingDeposit.gt(0)
      ? remainingDeposit.times(scale).integerValue(BigNumber.ROUND_FLOOR).toFixed(0)
      : '0';

    return {
      protocol: this.name,
      asset: reserve.token.symbol,
      coinType: reserve.coinType,
      borrowAprPoints: validatedBorrowAprPoints(points, utilization, spotBorrowApr),
      // spreadFeeBps is the reserve factor in basis points (2000 bps = 20%).
      reserveFactorPct: reserve.config.spreadFeeBps / 100,
      borrowedRaw: reserve.borrowedAmount.times(scale).integerValue(BigNumber.ROUND_FLOOR).toFixed(0),
      availableLiquidityRaw: reserve.availableAmount
        .times(scale)
        .integerValue(BigNumber.ROUND_FLOOR)
        .toFixed(0),
      depositCapRaw,
      decimals,
      price: reserve.price.toNumber(),
      // v1: base rate only. Suilend exposes depositsPoolRewardManager emissions
      // (totalRewards/start/end/totalShares) for a v2 reward-APR + share-decay model.
      rewardSupplyApr: 0
    };
  }

  async getObligation(owner = this.config.agent.walletAddress): Promise<SuilendObligationResponse> {
    const { client, reserveMap } = await this.getContext();
    const caps = await SuilendSdkClient.getObligationOwnerCaps(
      owner,
      [LENDING_MARKET_TYPE],
      this.execution.client
    );

    const cap = caps[0];
    if (!cap) {
      return emptyObligation();
    }

    const raw = await client.getObligation(cap.obligationId);
    const parsed = parseObligation(raw, reserveMap);
    return toObligationResponse(parsed, cap.id);
  }

  /** Interface-normalized view of the Suilend obligation. */
  async getPositions(owner = this.config.agent.walletAddress): Promise<NormalizedPositions> {
    const o = await this.getObligation(owner);
    return {
      protocol: 'suilend',
      healthFactor: o.healthFactor,
      borrowLimitUsd: o.borrowLimitUsd,
      weightedBorrowsUsd: o.weightedBorrowsUsd,
      depositedAmountUsd: o.depositedAmountUsd,
      borrowedAmountUsd: o.borrowedAmountUsd,
      deposits: o.deposits,
      borrows: o.borrows,
      obligationId: o.obligationId,
      obligationOwnerCapId: o.obligationOwnerCapId
    };
  }

  async buildSupplyTx({
    coinType,
    rawAmount,
    obligationOwnerCapId,
    obligationId
  }: {
    coinType: string;
    rawAmount: string;
    obligationOwnerCapId?: string;
    obligationId?: string;
  }): Promise<Transaction> {
    const { client } = await this.getContext();
    const owner = this.config.agent.walletAddress;
    const tx = new Transaction();

    let capId = obligationOwnerCapId;
    let resolvedObligationId = obligationId;

    // Discover an existing obligation/cap when not supplied by the caller.
    if (!capId || !resolvedObligationId) {
      const caps = await SuilendSdkClient.getObligationOwnerCaps(
        owner,
        [LENDING_MARKET_TYPE],
        this.execution.client
      );
      const cap = caps[0];
      if (cap) {
        capId = capId ?? cap.id;
        resolvedObligationId = resolvedObligationId ?? cap.obligationId;
      }
    }

    // First-ever supply: create the obligation inside this PTB. The cap is a
    // transaction argument (not a string id) and must be sent to the user
    // after the deposit completes.
    let createdCap: ReturnType<typeof createObligationIfNoneExists>['obligationOwnerCapId'] | undefined;
    let capArg: typeof capId | typeof createdCap = capId;
    if (!capId) {
      const created = createObligationIfNoneExists(client, tx);
      createdCap = created.obligationOwnerCapId;
      capArg = created.obligationOwnerCapId;
    }

    if (!capArg) {
      throw new Error('Unable to resolve Suilend obligation owner cap');
    }

    if (resolvedObligationId) {
      const obligation = await client.getObligation(resolvedObligationId);
      await client.refreshAll(tx, obligation);
    }

    await client.depositIntoObligation(owner, coinType, rawAmount, tx, capArg);

    if (createdCap) {
      sendObligationToUser(createdCap, owner, tx);
    }

    return tx;
  }

  async buildWithdrawTx({
    coinType,
    rawAmount,
    obligationOwnerCapId,
    obligationId
  }: {
    coinType: string;
    rawAmount: string;
    obligationOwnerCapId: string;
    obligationId: string;
  }): Promise<Transaction> {
    const { client, reserveMap } = await this.getContext();
    const tx = new Transaction();
    const obligation = await client.getObligation(obligationId);
    await client.refreshAll(tx, obligation);

    // Suilend's withdraw takes a cToken amount, not the underlying. Convert the
    // requested underlying raw amount into cTokens via the deposit's exchange rate
    // (depositedCtokenAmount / depositedUnderlyingRaw), clamped to what's held.
    const ctokenValue = this.underlyingToCtokenValue(obligation, reserveMap, coinType, rawAmount);
    const withdrawn = await client.withdraw(obligationOwnerCapId, obligationId, coinType, ctokenValue, tx);
    tx.transferObjects([withdrawn], this.config.agent.walletAddress);
    return tx;
  }

  private underlyingToCtokenValue(
    rawObligation: Parameters<typeof parseObligation>[0],
    reserveMap: Record<string, ParsedReserve>,
    coinType: string,
    underlyingRawAmount: string
  ): string {
    const parsed = parseObligation(rawObligation, reserveMap);
    const normalized = normalizeCoin(coinType);
    const deposit = parsed.deposits.find((d) => normalizeCoin(d.coinType) === normalized);
    if (!deposit) {
      throw new Error(`No Suilend deposit found for ${coinType}`);
    }

    const decimals = deposit.reserve.mintDecimals;
    const depositedUnderlyingRaw = deposit.depositedAmount.times(new BigNumber(10).pow(decimals));
    const requested = new BigNumber(underlyingRawAmount);

    // Withdraw-all (requested >= deposited): use the full cToken balance to avoid
    // rounding the request above what's held.
    if (requested.gte(depositedUnderlyingRaw)) {
      return deposit.depositedCtokenAmount.integerValue(BigNumber.ROUND_FLOOR).toFixed(0);
    }

    const ctokens = requested
      .times(deposit.depositedCtokenAmount)
      .div(depositedUnderlyingRaw)
      .integerValue(BigNumber.ROUND_FLOOR);
    return BigNumber.max(ctokens, new BigNumber(0)).toFixed(0);
  }

  async buildBorrowTx({
    coinType,
    rawAmount,
    obligationOwnerCapId,
    obligationId
  }: {
    coinType: string;
    rawAmount: string;
    obligationOwnerCapId: string;
    obligationId: string;
  }): Promise<Transaction> {
    const { client } = await this.getContext();
    const tx = new Transaction();
    const obligation = await client.getObligation(obligationId);
    await client.refreshAll(tx, obligation);
    await client.borrowAndSendToUser(
      this.config.agent.walletAddress,
      obligationOwnerCapId,
      obligationId,
      coinType,
      rawAmount,
      tx
    );
    return tx;
  }

  async buildRepayTx({
    coinType,
    rawAmount,
    obligationId
  }: {
    coinType: string;
    rawAmount: string;
    obligationId: string;
  }): Promise<Transaction> {
    const { client } = await this.getContext();
    const tx = new Transaction();
    const obligation = await client.getObligation(obligationId);
    await client.refreshAll(tx, obligation);
    await client.repayIntoObligation(this.config.agent.walletAddress, obligationId, coinType, rawAmount, tx);
    return tx;
  }

  async executeSupply({
    coinType,
    rawAmount,
    positions
  }: LendingWriteParams): Promise<ExecuteTransactionResult> {
    const tx = await this.buildSupplyTx({
      coinType,
      rawAmount,
      obligationOwnerCapId: positions?.obligationOwnerCapId ?? undefined,
      obligationId: positions?.obligationId ?? undefined
    });
    return this.execution.signAndExecute(tx);
  }

  async executeWithdraw({
    coinType,
    rawAmount,
    positions
  }: LendingWriteParams): Promise<ExecuteTransactionResult> {
    const tx = await this.buildWithdrawTx({
      coinType,
      rawAmount,
      ...this.requireObligationHandles(positions)
    });
    return this.execution.signAndExecute(tx);
  }

  async executeBorrow({
    coinType,
    rawAmount,
    positions
  }: LendingWriteParams): Promise<ExecuteTransactionResult> {
    const tx = await this.buildBorrowTx({
      coinType,
      rawAmount,
      ...this.requireObligationHandles(positions)
    });
    return this.execution.signAndExecute(tx);
  }

  async executeRepay({
    coinType,
    rawAmount,
    positions
  }: LendingWriteParams): Promise<ExecuteTransactionResult> {
    const { obligationId } = this.requireObligationHandles(positions);
    const tx = await this.buildRepayTx({ coinType, rawAmount, obligationId });
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
    const weighted = positions.weightedBorrowsUsd + borrowUsd;
    if (weighted <= 0) {
      return Number.POSITIVE_INFINITY;
    }

    return positions.borrowLimitUsd / weighted;
  }

  private requireObligationHandles(positions?: NormalizedPositions): {
    obligationOwnerCapId: string;
    obligationId: string;
  } {
    if (!positions?.obligationId || !positions.obligationOwnerCapId) {
      throw new Error('Suilend obligation and owner cap are required for this action');
    }
    return {
      obligationOwnerCapId: positions.obligationOwnerCapId,
      obligationId: positions.obligationId
    };
  }

  private shorthandFor(coinType: string): string {
    const normalized = normalizeCoin(coinType);
    if (normalized === normalizeCoin(this.config.sui.usdcCoinType)) {
      return 'usdc';
    }
    if (normalized === normalizeCoin(this.config.sui.suiCoinType)) {
      return 'sui';
    }

    return coinType.toLowerCase();
  }
}

function normalizeCoin(value: string): string {
  try {
    return normalizeStructTag(value).toLowerCase();
  } catch {
    return value.toLowerCase().replace(/^0x/, '');
  }
}

function emptyObligation(): SuilendObligationResponse {
  return {
    obligationId: null,
    obligationOwnerCapId: null,
    healthFactor: Number.POSITIVE_INFINITY,
    borrowLimitUsd: 0,
    weightedBorrowsUsd: 0,
    depositedAmountUsd: 0,
    borrowedAmountUsd: 0,
    deposits: [],
    borrows: []
  };
}

function toObligationResponse(
  parsed: ParsedObligation,
  obligationOwnerCapId: string
): SuilendObligationResponse {
  const weighted = parsed.weightedBorrowsUsd.toNumber();
  const healthFactor = weighted > 0 ? parsed.borrowLimitUsd.toNumber() / weighted : Number.POSITIVE_INFINITY;

  return {
    obligationId: parsed.id,
    obligationOwnerCapId,
    healthFactor,
    borrowLimitUsd: parsed.borrowLimitUsd.toNumber(),
    weightedBorrowsUsd: weighted,
    depositedAmountUsd: parsed.depositedAmountUsd.toNumber(),
    borrowedAmountUsd: parsed.borrowedAmountUsd.toNumber(),
    deposits: parsed.deposits.map((deposit) => ({
      coinType: deposit.coinType,
      symbol: deposit.reserve.token.symbol,
      amount: deposit.depositedAmount.toFixed(0),
      amountUsd: deposit.depositedAmountUsd.toNumber(),
      side: 'deposit' as const
    })),
    borrows: parsed.borrows.map((borrow) => ({
      coinType: borrow.coinType,
      symbol: borrow.reserve.token.symbol,
      amount: borrow.borrowedAmount.toFixed(0),
      amountUsd: borrow.borrowedAmountUsd.toNumber(),
      side: 'borrow' as const
    }))
  };
}

export function computeHealthFactorFromParsed(parsed: ParsedObligation): number {
  const weighted = parsed.weightedBorrowsUsd.toNumber();
  if (weighted <= 0) {
    return Number.POSITIVE_INFINITY;
  }

  return parsed.borrowLimitUsd.toNumber() / weighted;
}
