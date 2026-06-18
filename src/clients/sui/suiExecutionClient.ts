import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Transaction } from '@mysten/sui/transactions';
import type { ExecuteTransactionResult, Logger, SuiBalancesResponse, SuiNetwork } from '../../types.js';
import { formatUnits } from '../../utils/amounts.js';
import { createSuiKeypair, deriveSuiAddress } from '../../utils/privateKey.js';
import { defaultRpcUrl } from '../../utils/suiNetwork.js';

interface SuiExecutionClientOptions {
  rpcUrl: string;
  network: SuiNetwork;
  privateKey: string;
  walletAddress: string;
  usdcCoinType: string;
  suiCoinType: string;
  logger: Logger;
}

export class SuiExecutionClient {
  readonly client: SuiGrpcClient;
  private readonly privateKey: string;
  private readonly walletAddress: string;
  private readonly usdcCoinType: string;
  private readonly suiCoinType: string;
  private readonly logger: Logger;

  constructor({ rpcUrl, network, privateKey, walletAddress, usdcCoinType, suiCoinType, logger }: SuiExecutionClientOptions) {
    this.client = new SuiGrpcClient({
      network,
      baseUrl: rpcUrl || defaultRpcUrl(network)
    });
    this.privateKey = privateKey;
    this.walletAddress = walletAddress;
    this.usdcCoinType = usdcCoinType;
    this.suiCoinType = suiCoinType;
    this.logger = logger;
  }

  isConfigured(): boolean {
    return Boolean(this.privateKey && this.walletAddress);
  }

  getAddress(): string {
    if (!this.privateKey) {
      throw new Error('AGENT_SUI_PRIVATE_KEY is not configured');
    }

    return deriveSuiAddress(this.privateKey);
  }

  async assertWalletMatches(): Promise<{ address: string }> {
    const derived = this.getAddress();
    if (this.walletAddress && this.walletAddress !== derived) {
      throw new Error(`AGENT_WALLET_ADDRESS (${this.walletAddress}) does not match derived Sui address (${derived})`);
    }

    return { address: derived };
  }

  async getCoinBalances(owner = this.walletAddress || this.getAddress()): Promise<SuiBalancesResponse> {
    const [suiBalance, usdcBalance] = await Promise.all([
      this.client.getBalance({ owner, coinType: this.suiCoinType }),
      this.client.getBalance({ owner, coinType: this.usdcCoinType })
    ]);

    return {
      wallet: owner,
      sui: {
        symbol: 'SUI',
        coinType: this.suiCoinType,
        decimals: 9,
        raw: suiBalance.balance.totalBalance,
        formatted: formatUnits(suiBalance.balance.totalBalance, 9)
      },
      usdc: {
        symbol: 'USDC',
        coinType: this.usdcCoinType,
        decimals: 6,
        raw: usdcBalance.balance.totalBalance,
        formatted: formatUnits(usdcBalance.balance.totalBalance, 6)
      }
    };
  }

  async signAndExecute(transaction: Transaction): Promise<ExecuteTransactionResult> {
    const signer = createSuiKeypair(this.privateKey);
    const address = this.getAddress();
    transaction.setSender(address);

    const result = await this.client.signAndExecuteTransaction({
      signer,
      transaction,
      include: { effects: true }
    });

    if (result.$kind === 'FailedTransaction') {
      const message = result.FailedTransaction.status.error?.message ?? 'Transaction failed';
      throw new Error(message);
    }

    const digest = result.Transaction?.digest ?? result.digest;
    if (!digest) {
      throw new Error('Transaction submitted without digest');
    }

    await this.client.waitForTransaction({ digest, include: { effects: true } });
    this.logger.info('Sui transaction confirmed', { digest });

    return { digest, success: true };
  }

  async pingRpc(): Promise<boolean> {
    try {
      await this.client.getReferenceGasPrice();
      return true;
    } catch {
      return false;
    }
  }
}
