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
import type { Logger } from '../types.js';

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

    if (allowance < amount) {
      const approval = await publicClient.simulateContract({
        account,
        address: normalizedUnderlying,
        abi: erc20Abi,
        functionName: 'approve',
        args: [normalizedFToken, amount]
      });
      approvalHash = await walletClient.writeContract(approval.request);
      await publicClient.waitForTransactionReceipt({ hash: approvalHash });
    }

    const deposit = await publicClient.simulateContract({
      account,
      address: normalizedFToken,
      abi: fluidFTokenAbi,
      functionName: 'deposit',
      args: [amount, account.address]
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
}
