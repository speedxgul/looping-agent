import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { createBundlerClient, toCoinbaseSmartAccount } from 'viem/account-abstraction';
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  http,
  parseAbi,
  type Address,
  type Hex
} from 'viem';
import { BASE_USDC_ADDRESS } from '../core/agentMemory.js';
import type { FluidMarket, FluidMarketsResponse, Logger, WalletBalancesResponse } from '../types.js';
import { formatUnits } from '../utils/amounts.js';
import { requestJson } from '../utils/http.js';

const LENDING_RESOLVER_BASE = '0x3aF6FBEc4a2FE517F56E402C65e3f4c3e18C1D86' as const; // fluid lending resolver contract exposes public data
const FLUID_LENDING_RATES_API = 'https://api.fluid.instadapp.io/v2/lending';
const BASE_CHAIN_ID = 8453;
const POST_APPROVAL_DEPOSIT_RETRY_DELAY_MS = 2500;

interface FluidLendingApiToken {
  address: string;
  supplyRate?: string | number;
  rewardsRate?: string | number;
  totalRate?: string | number;
  asset?: { stakingApr?: string | number };
  rewards?: Array<{ rewardType?: string; rate?: string | number }>;
}

interface FluidLendingApiResponse {
  data?: FluidLendingApiToken[];
}

interface FluidApiRates {
  supplyRate: number;
  rewardsRate: number;
  totalApr: number;
  stakingApr?: number;
  merkleRewardsApr?: number;
}

const lendingResolverAbi = parseAbi([
  'function getAllFTokens() view returns (address[])'
]);

const fTokenReadAbi = parseAbi([
  'function symbol() view returns (string)',
  'function name() view returns (string)',
  'function decimals() view returns (uint8)',
  'function asset() view returns (address)',
  'function totalAssets() view returns (uint256)'
]);

const fluidFTokenAbi = parseAbi([
  'function deposit(uint256 assets, address receiver) returns (uint256 shares)',
  'function depositNative(address receiver) payable returns (uint256 shares)'
]);

interface FluidExecutionClientOptions {
  accountMode: 'eoa' | 'smart';
  rpcUrl: string;
  privateKey: string;
  walletAddress: string;
  bundlerUrl: string;
  usePaymaster: boolean;
  logger: Logger;
}

interface SupplyToFluidParams {
  fTokenAddress: string;
  rawAmount: string;
  underlyingTokenAddress?: string;
  isNativeUnderlying?: boolean;
}

export class FluidExecutionClient {
  private readonly accountMode: 'eoa' | 'smart';
  private readonly rpcUrl: string;
  private readonly privateKey: string;
  private readonly walletAddress: string;
  private readonly bundlerUrl: string;
  private readonly usePaymaster: boolean;
  private readonly logger: Logger;

  constructor({
    accountMode,
    rpcUrl,
    privateKey,
    walletAddress,
    bundlerUrl,
    usePaymaster,
    logger
  }: FluidExecutionClientOptions) {
    this.accountMode = accountMode;
    this.rpcUrl = rpcUrl;
    this.privateKey = privateKey;
    this.walletAddress = walletAddress;
    this.bundlerUrl = bundlerUrl;
    this.usePaymaster = usePaymaster;
    this.logger = logger;
  }

  isConfigured(): boolean {
    return Boolean(
      this.rpcUrl &&
        this.privateKey &&
        this.walletAddress &&
        (this.accountMode === 'eoa' || this.bundlerUrl)
    );
  }

  async assertWalletMatches(): Promise<{ address: Address }> {
    if (!this.privateKey) {
      throw new Error('AGENT_PRIVATE_KEY is not configured');
    }

    if (!this.rpcUrl) {
      throw new Error('BASE_RPC_URL is not configured');
    }

    const account = privateKeyToAccount(this.privateKey as Hex);
    const expected = getAddress(this.walletAddress);
    const executionAddress =
      this.accountMode === 'smart' ? await this.getCoinbaseSmartAccountAddress(account) : account.address;

    if (executionAddress !== expected) {
      throw new Error(
        `${this.accountMode === 'smart' ? 'Smart account' : 'AGENT_PRIVATE_KEY'} address does not match AGENT_WALLET_ADDRESS (${executionAddress} != ${expected})`
      );
    }

    return { address: executionAddress };
  }

  async getExecutionAddress(): Promise<{ accountMode: 'eoa' | 'smart'; address: Address; ownerAddress: Address }> {
    if (!this.privateKey) {
      throw new Error('AGENT_PRIVATE_KEY is not configured');
    }

    const owner = privateKeyToAccount(this.privateKey as Hex);
    if (this.accountMode === 'eoa') {
      return {
        accountMode: 'eoa',
        address: owner.address,
        ownerAddress: owner.address
      };
    }

    if (!this.rpcUrl) {
      throw new Error('BASE_RPC_URL is required to derive the smart account address');
    }

    return {
      accountMode: 'smart',
      address: await this.getCoinbaseSmartAccountAddress(owner),
      ownerAddress: owner.address
    };
  }

  async getMarkets(): Promise<FluidMarketsResponse> {
    if (!this.rpcUrl) {
      throw new Error('BASE_RPC_URL is required for on-chain market discovery');
    }

    const client = createPublicClient({ chain: base, transport: http(this.rpcUrl) });

    const addresses = await client.readContract({
      address: LENDING_RESOLVER_BASE,
      abi: lendingResolverAbi,
      functionName: 'getAllFTokens'
    });

    this.logger.info('Fluid resolver: discovered fTokens', { count: addresses.length });

    const apiRates = await this.fetchApiRates();

    const markets = await Promise.all(
      addresses.map(async (fToken): Promise<FluidMarket> => {
        const [symbol, name, decimals, underlying, totalAssets] = await Promise.all([
          client.readContract({ address: fToken, abi: fTokenReadAbi, functionName: 'symbol' }),
          client.readContract({ address: fToken, abi: fTokenReadAbi, functionName: 'name' }),
          client.readContract({ address: fToken, abi: fTokenReadAbi, functionName: 'decimals' }),
          client.readContract({ address: fToken, abi: fTokenReadAbi, functionName: 'asset' })
            .catch(() => '0x0000000000000000000000000000000000000000' as Address),
          client.readContract({ address: fToken, abi: fTokenReadAbi, functionName: 'totalAssets' })
            .catch(() => 0n)
        ]);

        const rates = apiRates.get(fToken.toLowerCase());

        return {
          fToken,
          underlying,
          symbol,
          name,
          decimals,
          isNativeUnderlying: underlying === '0x0000000000000000000000000000000000000000',
          totalAssets: totalAssets.toString(),
          supplyRate: rates?.supplyRate ?? 0,
          rewardsRate: rates?.rewardsRate ?? 0,
          totalApr: rates?.totalApr ?? 0,
          ...(rates?.stakingApr !== undefined ? { stakingApr: rates.stakingApr } : {}),
          ...(rates?.merkleRewardsApr !== undefined ? { merkleRewardsApr: rates.merkleRewardsApr } : {}),
          chain: 'base'
        };
      })
    );

    markets.sort((a, b) => b.totalApr - a.totalApr);

    return { markets };
  }

  async getWalletBalances(walletAddress: string): Promise<WalletBalancesResponse> {
    if (!this.rpcUrl) {
      throw new Error('BASE_RPC_URL is required to read wallet balances');
    }

    const wallet = getAddress(walletAddress);
    const client = createPublicClient({ chain: base, transport: http(this.rpcUrl) });
    const usdcAddress = getAddress(BASE_USDC_ADDRESS);

    const [ethBalance, usdcBalance] = await Promise.all([
      client.getBalance({ address: wallet }),
      client.readContract({
        address: usdcAddress,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [wallet]
      })
    ]);

    return {
      wallet,
      eth: {
        symbol: 'ETH',
        address: '0x0000000000000000000000000000000000000000',
        decimals: 18,
        raw: ethBalance.toString(),
        formatted: formatUnits(ethBalance, 18)
      },
      usdc: {
        symbol: 'USDC',
        address: usdcAddress,
        decimals: 6,
        raw: usdcBalance.toString(),
        formatted: formatUnits(usdcBalance, 6)
      }
    };
  }

  private async fetchApiRates(): Promise<Map<string, FluidApiRates>> {
    const url = `${FLUID_LENDING_RATES_API}/${BASE_CHAIN_ID}/tokens`;

    try {
      const response = await requestJson<FluidLendingApiResponse>(url);
      const rates = new Map<string, FluidApiRates>();

      for (const token of response.data ?? []) {
        const merkleBps = (token.rewards ?? [])
          .filter((reward) => reward.rewardType === 'merkle')
          .reduce((sum, reward) => sum + Number(reward.rate ?? 0), 0);

        const entry: FluidApiRates = {
          supplyRate: fluidRateBpsToPercent(token.supplyRate),
          rewardsRate: fluidRateBpsToPercent(token.rewardsRate),
          totalApr: fluidRateBpsToPercent(token.totalRate)
        };
        if (token.asset?.stakingApr !== undefined) {
          entry.stakingApr = fluidRateBpsToPercent(token.asset.stakingApr);
        }
        if (merkleBps > 0) {
          entry.merkleRewardsApr = fluidRateBpsToPercent(merkleBps);
        }

        rates.set(token.address.toLowerCase(), entry);
      }

      this.logger.info('Fluid lending rates API loaded', { tokens: rates.size, chainId: BASE_CHAIN_ID });
      return rates;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn('Fluid lending rates API unavailable; APRs will be zero', { error: message });
      return new Map();
    }
  }

  async supplyToFluid({
    fTokenAddress,
    rawAmount,
    underlyingTokenAddress,
    isNativeUnderlying = false
  }: SupplyToFluidParams): Promise<Record<string, unknown>> {
    const normalizedFToken = getAddress(fTokenAddress);
    const amount = BigInt(rawAmount);
    if (amount <= 0n) {
      throw new Error('rawAmount must be greater than zero');
    }

    if (this.accountMode === 'smart') {
      return this.supplyToFluidWithSmartAccount({
        fTokenAddress: normalizedFToken,
        rawAmount,
        underlyingTokenAddress,
        isNativeUnderlying
      });
    }

    return this.supplyToFluidWithEoa({
      fTokenAddress: normalizedFToken,
      rawAmount,
      underlyingTokenAddress,
      isNativeUnderlying
    });
  }

  private async supplyToFluidWithEoa({
    fTokenAddress,
    rawAmount,
    underlyingTokenAddress,
    isNativeUnderlying = false
  }: SupplyToFluidParams): Promise<Record<string, unknown>> {
    const normalizedFToken = getAddress(fTokenAddress);
    const amount = BigInt(rawAmount);
    const account = privateKeyToAccount(this.privateKey as Hex);
    const expected = getAddress(this.walletAddress);
    if (account.address !== expected) {
      throw new Error(`AGENT_PRIVATE_KEY does not match AGENT_WALLET_ADDRESS (${account.address} != ${expected})`);
    }

    const publicClient = createPublicClient({
      chain: base,
      transport: http(this.rpcUrl)
    });
    const walletClient = createWalletClient({
      account,
      chain: base,
      transport: http(this.rpcUrl)
    });

    let approvalHash: Hex | undefined;

    if (isNativeUnderlying) {
      const simulation = await publicClient.simulateContract({
        account,
        address: normalizedFToken,
        abi: fluidFTokenAbi,
        functionName: 'depositNative',
        args: [account.address],
        value: amount
      });
      const depositHash = await walletClient.writeContract(simulation.request);
      const receipt = await publicClient.waitForTransactionReceipt({ hash: depositHash });
      return {
        txHash: depositHash,
        receiptStatus: receipt.status,
        approvalTxHash: approvalHash
      };
    }

    if (!underlyingTokenAddress) {
      throw new Error('underlyingTokenAddress is required for ERC-20 Fluid deposits');
    }

    const normalizedUnderlying = getAddress(underlyingTokenAddress);
    const allowance = await publicClient.readContract({
      address: normalizedUnderlying,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [account.address, normalizedFToken]
    });

    let currentAllowance = allowance;
    if (currentAllowance < amount) {
      const approval = await publicClient.simulateContract({
        account,
        address: normalizedUnderlying,
        abi: erc20Abi,
        functionName: 'approve',
        args: [normalizedFToken, amount]
      });
      approvalHash = await walletClient.writeContract(approval.request);
      await publicClient.waitForTransactionReceipt({ hash: approvalHash });

      currentAllowance = await publicClient.readContract({
        address: normalizedUnderlying,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [account.address, normalizedFToken]
      });

      this.logger.info('Fluid approval confirmed', {
        wallet: account.address,
        tokenAddress: normalizedUnderlying,
        spender: normalizedFToken,
        rawAmount,
        approvalTxHash: approvalHash,
        allowance: currentAllowance.toString()
      });

      if (currentAllowance < amount) {
        throw new Error(
          `Fluid approval confirmed but allowance is still below deposit amount (${currentAllowance.toString()} < ${amount.toString()}); approvalTxHash=${approvalHash}`
        );
      }
    }

    const deposit = await this.simulateFluidDepositWithRetry({
      publicClient,
      account,
      fTokenAddress: normalizedFToken,
      amount,
      receiver: account.address,
      approvalHash
    });
    const depositHash = await walletClient.writeContract(deposit.request);
    const receipt = await publicClient.waitForTransactionReceipt({ hash: depositHash });

    this.logger.info('Fluid deposit executed', {
      wallet: account.address,
      fTokenAddress: normalizedFToken,
      rawAmount,
      approvalTxHash: approvalHash,
      depositTxHash: depositHash
    });

    return {
      accountMode: 'eoa',
      txHash: depositHash,
      receiptStatus: receipt.status,
      approvalTxHash: approvalHash
    };
  }

  private async supplyToFluidWithSmartAccount({
    fTokenAddress,
    rawAmount,
    underlyingTokenAddress,
    isNativeUnderlying = false
  }: SupplyToFluidParams): Promise<Record<string, unknown>> {
    if (!this.bundlerUrl) {
      throw new Error('SMART_ACCOUNT_BUNDLER_URL is not configured');
    }

    const normalizedFToken = getAddress(fTokenAddress);
    const amount = BigInt(rawAmount);
    const owner = privateKeyToAccount(this.privateKey as Hex);
    const publicClient = createPublicClient({
      chain: base,
      transport: http(this.rpcUrl)
    });
    const smartAccount = await toCoinbaseSmartAccount({
      client: publicClient,
      owners: [owner],
      version: '1.1'
    });
    const smartAccountAddress = await smartAccount.getAddress();
    const expected = getAddress(this.walletAddress);
    if (smartAccountAddress !== expected) {
      throw new Error(`Smart account address does not match AGENT_WALLET_ADDRESS (${smartAccountAddress} != ${expected})`);
    }

    const bundlerClient = createBundlerClient({
      account: smartAccount,
      chain: base,
      client: publicClient,
      transport: http(this.bundlerUrl),
      paymaster: this.usePaymaster ? true : undefined
    });

    const calls: Array<{ to: Address; data: Hex; value?: bigint }> = [];
    let approvalPlanned = false;

    if (isNativeUnderlying) {
      calls.push({
        to: normalizedFToken,
        data: encodeFunctionData({
          abi: fluidFTokenAbi,
          functionName: 'depositNative',
          args: [smartAccountAddress]
        }),
        value: amount
      });
    } else {
      if (!underlyingTokenAddress) {
        throw new Error('underlyingTokenAddress is required for ERC-20 Fluid deposits');
      }

      const normalizedUnderlying = getAddress(underlyingTokenAddress);
      const allowance = await publicClient.readContract({
        address: normalizedUnderlying,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [smartAccountAddress, normalizedFToken]
      });

      if (allowance < amount) {
        approvalPlanned = true;
        calls.push({
          to: normalizedUnderlying,
          data: encodeFunctionData({
            abi: erc20Abi,
            functionName: 'approve',
            args: [normalizedFToken, amount]
          })
        });
      }

      calls.push({
        to: normalizedFToken,
        data: encodeFunctionData({
          abi: fluidFTokenAbi,
          functionName: 'deposit',
          args: [amount, smartAccountAddress]
        })
      });
    }

    const userOperationHash = await bundlerClient.sendUserOperation({ calls });
    const receipt = await bundlerClient.waitForUserOperationReceipt({ hash: userOperationHash });

    this.logger.info('Fluid deposit user operation executed', {
      wallet: smartAccountAddress,
      owner: owner.address,
      fTokenAddress: normalizedFToken,
      rawAmount,
      userOperationHash,
      transactionHash: receipt.receipt.transactionHash,
      approvalPlanned
    });

    return {
      accountMode: 'smart',
      smartAccountAddress,
      ownerAddress: owner.address,
      userOperationHash,
      txHash: receipt.receipt.transactionHash,
      receiptStatus: receipt.receipt.status,
      approvalPlanned
    };
  }

  private async getCoinbaseSmartAccountAddress(owner: ReturnType<typeof privateKeyToAccount>): Promise<Address> {
    const publicClient = createPublicClient({
      chain: base,
      transport: http(this.rpcUrl)
    });
    const smartAccount = await toCoinbaseSmartAccount({
      client: publicClient,
      owners: [owner],
      version: '1.1'
    });

    return smartAccount.getAddress();
  }

  private async simulateFluidDepositWithRetry({
    publicClient,
    account,
    fTokenAddress,
    amount,
    receiver,
    approvalHash
  }: {
    publicClient: ReturnType<typeof createPublicClient>;
    account: ReturnType<typeof privateKeyToAccount>;
    fTokenAddress: Address;
    amount: bigint;
    receiver: Address;
    approvalHash: Hex | undefined;
  }) {
    try {
      return await publicClient.simulateContract({
        account,
        address: fTokenAddress,
        abi: fluidFTokenAbi,
        functionName: 'deposit',
        args: [amount, receiver]
      });
    } catch (error: unknown) {
      if (!approvalHash) {
        throw annotateFluidDepositError(error);
      }

      this.logger.warn('Fluid deposit simulation failed after approval; retrying once', {
        wallet: receiver,
        fTokenAddress,
        rawAmount: amount.toString(),
        approvalTxHash: approvalHash,
        error: describeFluidDepositError(error)
      });

      await sleep(POST_APPROVAL_DEPOSIT_RETRY_DELAY_MS);

      try {
        return await publicClient.simulateContract({
          account,
          address: fTokenAddress,
          abi: fluidFTokenAbi,
          functionName: 'deposit',
          args: [amount, receiver]
        });
      } catch (retryError: unknown) {
        throw annotateFluidDepositError(retryError, approvalHash);
      }
    }
  }
}

/** Fluid API rates use 1e2 precision (100 = 1%, 519 = 5.19%). */
function fluidRateBpsToPercent(value: string | number | undefined): number {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) {
    return 0;
  }

  return n / 100;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function annotateFluidDepositError(error: unknown, approvalHash?: Hex): Error {
  const details = describeFluidDepositError(error);
  const approvalContext = approvalHash ? `; approvalTxHash=${approvalHash}` : '';
  return new Error(`Fluid deposit simulation failed${approvalContext}: ${details}`);
}

function describeFluidDepositError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const selector = extractRevertSelector(error);
  if (!selector) {
    return message;
  }

  return `${message} (revertSelector=${selector})`;
}

function extractRevertSelector(error: unknown): Hex | undefined {
  const data = extractRevertData(error);
  if (data && data.length >= 10) {
    return data.slice(0, 10) as Hex;
  }

  const message = error instanceof Error ? error.message : String(error);
  const match = message.match(/0x[a-fA-F0-9]{8}/);
  return match?.[0] as Hex | undefined;
}

function extractRevertData(value: unknown, seen = new Set<unknown>()): Hex | undefined {
  if (!value || typeof value !== 'object' || seen.has(value)) {
    return undefined;
  }
  seen.add(value);

  const record = value as Record<string, unknown>;
  for (const key of ['data', 'error', 'cause']) {
    const candidate = record[key];
    if (typeof candidate === 'string' && /^0x[a-fA-F0-9]+$/.test(candidate)) {
      return candidate as Hex;
    }

    const nested = extractRevertData(candidate, seen);
    if (nested) {
      return nested;
    }
  }

  return undefined;
}
