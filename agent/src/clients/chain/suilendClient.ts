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
import type {
  AppConfig,
  ExecuteTransactionResult,
  Logger,
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

export class SuilendClient {
  private readonly execution: SuiExecutionClient;
  private readonly config: AppConfig;
  private readonly logger: Logger;
  private context: SuilendContext | null = null;

  constructor({ execution, config, logger }: AgentSuilendClientOptions) {
    this.execution = execution;
    this.config = config;
    this.logger = logger;
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
        allowed: this.isAssetAllowed(reserve.coinType)
      }))
      .filter((market) => market.allowed)
      .sort((a, b) => b.totalApr - a.totalApr);

    return { markets };
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
    const { client } = await this.getContext();
    const tx = new Transaction();
    const obligation = await client.getObligation(obligationId);
    await client.refreshAll(tx, obligation);
    const withdrawn = await client.withdraw(obligationOwnerCapId, obligationId, coinType, rawAmount, tx);
    tx.transferObjects([withdrawn], this.config.agent.walletAddress);
    return tx;
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

  async executeSupply(params: {
    coinType: string;
    rawAmount: string;
    obligationOwnerCapId?: string;
    obligationId?: string;
  }): Promise<ExecuteTransactionResult> {
    const tx = await this.buildSupplyTx(params);
    return this.execution.signAndExecute(tx);
  }

  async executeWithdraw(params: {
    coinType: string;
    rawAmount: string;
    obligationOwnerCapId: string;
    obligationId: string;
  }): Promise<ExecuteTransactionResult> {
    const tx = await this.buildWithdrawTx(params);
    return this.execution.signAndExecute(tx);
  }

  async executeBorrow(params: {
    coinType: string;
    rawAmount: string;
    obligationOwnerCapId: string;
    obligationId: string;
  }): Promise<ExecuteTransactionResult> {
    const tx = await this.buildBorrowTx(params);
    return this.execution.signAndExecute(tx);
  }

  async executeRepay(params: {
    coinType: string;
    rawAmount: string;
    obligationId: string;
  }): Promise<ExecuteTransactionResult> {
    const tx = await this.buildRepayTx(params);
    return this.execution.signAndExecute(tx);
  }

  simulateHealthFactorAfterBorrow(obligation: SuilendObligationResponse, borrowUsd: number): number {
    const weighted = obligation.weightedBorrowsUsd + borrowUsd;
    if (weighted <= 0) {
      return Number.POSITIVE_INFINITY;
    }

    return obligation.borrowLimitUsd / weighted;
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
