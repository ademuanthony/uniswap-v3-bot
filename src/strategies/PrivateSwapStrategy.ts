import { BaseStrategyExecutor, execPromise } from './BaseStrategyExecutor';
import { PrivateSwapStrategy, StrategyExecutor } from '../types/Strategy';
import { Web3Helper } from '../utils/web3';
import {
  createMoneroWallet,
  getXmrBalance,
  openWallet,
  transferXMR,
} from '../utils/monero';

import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import { Keypair, PublicKey } from '@solana/web3.js';
import dotenv from 'dotenv';
import { getSolanaWallet, getTokenBalance } from '../solana/utils';
import { swapOnJupiter } from '../utils/jupiter';

dotenv.config();

const FEE_RATES = {
  testnet: {
    default: 950, // High rate for testnet to ensure confirmation
    urgent: 1500,
  },
  mainnet: {
    default: 4, // Normal priority
    urgent: 6, // High priority for stuck transactions
  },
};

interface SwapTransaction {
  id: string;
  timestamp: number;
  status:
    | 'pending'
    | 'btc_sent'
    | 'xmr_received'
    | 'xmr_sent'
    | 'usdc_received'
    | 'finalizing'
    | 'completed'
    | 'failed';
  btcAmount: string;
  xmrAmount: string;
  solUsdcAmount: string;
  solBtcAmount: string;
  btcTxHash?: string;
  xmrTxHash?: string;
  solTxHash?: string;
  intermediateWallet: {
    xmrAddress: string;
    filename: string;
    password: string;
  };
  destinationWallet: {
    solanaAddress: string;
    privateKey?: string;
  };
}

type Currency = 'btc' | 'xmr' | 'sol' | 'usdc';

export class PrivateSwapExecutor
  extends BaseStrategyExecutor
  implements StrategyExecutor
{
  private strategy: PrivateSwapStrategy;
  private _isRunning: boolean = false;
  private interval?: NodeJS.Timeout;
  private storageDir = './.data/private_swap';
  private transactions: SwapTransaction[] = [];

  constructor(strategy: PrivateSwapStrategy) {
    super();
    this.strategy = strategy;
    this.initStorage();
    this.loadTransactions();
  }

  private initStorage() {
    if (!fs.existsSync(this.storageDir)) {
      fs.mkdirSync(this.storageDir, { recursive: true });
    }
  }

  private async saveTransaction(transaction: SwapTransaction) {
    const filePath = path.join(this.storageDir, `${transaction.id}.json`);
    await fs.promises.writeFile(filePath, JSON.stringify(transaction, null, 2));
  }

  private async loadTransaction(id: string) {
    const filePath = path.join(this.storageDir, `${id}.json`);
    const data = await fs.promises.readFile(filePath, 'utf8');
    return JSON.parse(data);
  }

  private async saveTransactions() {
    const filePath = path.join(this.storageDir, `${this.strategy.key}.json`);
    await fs.promises.writeFile(
      filePath,
      JSON.stringify({ transactions: this.transactions }, null, 2)
    );
  }

  private async loadTransactions() {
    const filePath = path.join(this.storageDir, `${this.strategy.key}.json`);
    try {
      if (fs.existsSync(filePath)) {
        const data = await fs.promises.readFile(filePath, 'utf8');
        const parsed = JSON.parse(data);
        this.transactions = parsed.transactions || [];
      }
    } catch (error) {
      this.log(`Error loading transactions: ${error}`);
      this.transactions = [];
    }
  }

  protected override log(message: string) {
    super.log(`[${this.strategy.key}] ${message}`);
  }

  async start(): Promise<void> {
    if (this._isRunning) return;

    this._isRunning = true;
    this.interval = setInterval(async () => {
      try {
        await this.execute();
      } catch (error) {
        this.log(
          `Error in Private Swap strategy ${this.strategy.name}: ${error}`
        );
      }
    }, this.strategy.interval * 1000);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
    this._isRunning = false;
  }

  isRunning(): boolean {
    return this._isRunning;
  }

  private async createIntermediateXMRWallet(): Promise<{
    address: string;
    filename: string;
    password: string;
  }> {
    const password = this.generateRandomPassword();
    const filename = `xmr_wallet_${Date.now()}`;
    await createMoneroWallet({
      filename,
      language: 'English',
      password,
    });

    const walletInfo = await openWallet(filename, '');
    return {
      address: walletInfo.address,
      filename,
      password,
    };
  }

  private async createSolanaWallet(): Promise<{
    address: string;
    privateKey: string;
  }> {
    const keypair = Keypair.generate();
    return {
      address: keypair.publicKey.toString(),
      privateKey: Buffer.from(keypair.secretKey).toString('hex'),
    };
  }

  private generateRandomPassword(): string {
    return Math.random().toString(36).slice(-8);
  }

  private async initiateChangeNowSwap(
    fromCurrency: Currency,
    toCurrency: Currency,
    fromNetwork: string,
    toNetwork: string,
    fromAmount: string,
    address: string
  ): Promise<{
    id: string;
    payinAddress: string;
    expectedAmount: string;
  }> {
    const response = await axios.post(
      'https://api.changenow.io/v2/exchange',
      {
        fromCurrency,
        toCurrency,
        fromNetwork,
        toNetwork,
        fromAmount,
        address,
        flow: 'standard',
      },
      {
        headers: {
          'x-api-key': process.env.CHANGENOW_API_KEY,
        },
      }
    );

    return {
      id: response.data.id,
      payinAddress: response.data.payinAddress,
      expectedAmount: response.data.expectedAmountTo,
    };
  }

  private async sendBtc(
    address: string,
    amount: string,
    feeRate: number
  ): Promise<string> {
    if (!this.strategy.btcFeeRate) {
      console.log(
        `No BTC fee rate set. Using default value of ${FEE_RATES.mainnet.default} sats/vB`
      );
      this.strategy.btcFeeRate = FEE_RATES.mainnet.default;
    }

    const command = `bitcoin-cli -named sendtoaddress \
address="${address}" \
amount=${amount} \
fee_rate=${feeRate} \
replaceable=true`;

    console.log(`\nExecuting command: ${command}\n`);

    try {
      const { stdout } = await execPromise(command);
      const txid = stdout.trim();
      console.log(`Transaction initiated! TXID: ${txid}`);
      return txid;
    } catch (error) {
      console.log('Error executing bitcoin-cli command:', error);
      throw error;
    }
  }

  async execute(): Promise<void> {
    // Create intermediate XMR wallet
    const xmrWallet = await this.createIntermediateXMRWallet();

    // Create Solana wallet if configured
    const solanaWallet = this.strategy.generateNewSolanaWallet
      ? await this.createSolanaWallet()
      : {
          address: process.env.SOLANA_DESTINATION_ADDRESS!,
          privateKey: process.env.SOLANA_DESTINATION_PRIVATE_KEY!,
        };

    // Create new transaction record
    const transaction: SwapTransaction = {
      id: `swap_${Date.now()}`,
      timestamp: Date.now(),
      status: 'pending',
      btcAmount: this.strategy.amount,
      xmrAmount: '0',
      solUsdcAmount: '0',
      solBtcAmount: '0',
      intermediateWallet: {
        xmrAddress: xmrWallet.address,
        filename: xmrWallet.filename,
        password: xmrWallet.password,
      },
      destinationWallet: {
        solanaAddress: solanaWallet.address,
        privateKey: solanaWallet.privateKey,
      },
    };

    try {
      // Initiate BTC -> XMR swap
      const btcToXmr = await this.initiateChangeNowSwap(
        'btc',
        'xmr',
        'btc',
        'xmr',
        this.strategy.amount,
        xmrWallet.address
      );
      transaction.xmrAmount = btcToXmr.expectedAmount;
      transaction.status = 'btc_sent';
      await this.saveTransaction(transaction);

      const btcTxHash = await this.sendBtc(
        btcToXmr.payinAddress,
        this.strategy.amount,
        this.strategy.btcFeeRate
      );
      transaction.btcTxHash = btcTxHash;

      // Wait for BTC transaction to be confirmed
      if (
        !(await this.waitForBtcTransactionConfirmation(btcTxHash, execPromise))
      ) {
        await this.saveTransaction(transaction);
        return;
      }

      // Wait for XMR to arrive (implement monitoring logic)
      const maxWaitTime = 2 * 1000 * 60 * 60; // 2 hours
      const startTime = Date.now();
      while (true) {
        const xmrBalance = await getXmrBalance(xmrWallet.address);
        if (xmrBalance.balance > 0) {
          transaction.status = 'xmr_received';
          await this.saveTransaction(transaction);
          break;
        }
        if (Date.now() - startTime > maxWaitTime) {
          throw new Error('XMR not received within 2 hours');
        }
        await new Promise((resolve) => setTimeout(resolve, 10000));
      }

      // TODO: Convert XMR to USDC on solana
      const xmrToSolBtc = await this.initiateChangeNowSwap(
        'xmr',
        'sol',
        'xmr',
        'solana',
        transaction.xmrAmount,
        solanaWallet.address
      );
      transaction.solUsdcAmount = xmrToSolBtc.expectedAmount;

      // TODO: Send xmr to change now
      await transferXMR(
        transaction.intermediateWallet.filename,
        transaction.intermediateWallet.password,
        xmrToSolBtc.payinAddress,
        Number(transaction.xmrAmount)
      );

      transaction.status = 'xmr_sent';
      await this.saveTransaction(transaction);
      const usdcAddress = process.env.USDC_ADDRESS!;
      // TODO: wait for change now to confirm and send funds to solana
      while (true) {
        const usdcBalance = await getTokenBalance(
          Web3Helper.getSolanaConnection(),
          new PublicKey(usdcAddress),
          new PublicKey(solanaWallet.address)
        );
        if (usdcBalance > 0) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 60000));
      }

      // Update transaction status
      transaction.status = 'finalizing';
      this.transactions.push(transaction);

      // TODO: Swap USDC to BTC
      const wbtcAddress = process.env.WBTC_ADDRESS!;
      const {amountOut, txid} = await swapOnJupiter(
        getSolanaWallet(solanaWallet.privateKey),
        usdcAddress,
        wbtcAddress,
        Number(transaction.solUsdcAmount)
      );
      transaction.solBtcAmount = amountOut.toString();
      transaction.status = 'completed';
      transaction.solTxHash = txid;
      await this.saveTransactions();
    } catch (error) {
      transaction.status = 'failed';
      this.transactions.push(transaction);
      await this.saveTransactions();
      throw error;
    }
  }

  public getName(): string {
    return this.strategy.name;
  }

  public getWalletPrivateKey(): string {
    return process.env[this.strategy.privateKeyEnvKey] as string;
  }

  public getKey(): string {
    return this.strategy.key;
  }

  public async getDisplayInfo(): Promise<string[]> {
    const completedSwaps = this.transactions.filter(
      (t) => t.status === 'completed'
    ).length;

    return [
      `Type: Private Swap`,
      `Amount per swap: ${this.strategy.amount} BTC`,
      `Interval: ${this.strategy.interval}s`,
      `Generate new Solana wallets: ${
        this.strategy.generateNewSolanaWallet ? 'Yes' : 'No'
      }`,
      `Completed swaps: ${completedSwaps}`,
      `Total transactions: ${this.transactions.length}`,
    ];
  }

  public async getStatus(): Promise<any> {
    return {
      name: this.strategy.name,
      status: this.isRunning() ? 'Running' : 'Stopped',
      transactions: this.transactions,
      lastUpdate: new Date().toISOString(),
    };
  }

  public async handleCommand(action: string, args: string[]): Promise<string> {
    switch (action.toLowerCase()) {
      case 'transactions':
        return JSON.stringify(this.transactions, null, 2);
      default:
        return `Unknown command: ${action}. Available commands: transactions`;
    }
  }
}
