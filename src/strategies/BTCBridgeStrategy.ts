import { BaseStrategy, StrategyExecutor } from '../types/Strategy';
import { BaseStrategyExecutor } from './BaseStrategyExecutor';
import { Web3Helper } from '../utils/web3';
import dotenv from 'dotenv';

import { Deposit, Hex, TBTC, DepositReceipt } from '@keep-network/tbtc-v2.ts';
import ECPairFactory from 'ecpair';
import * as ecc from 'tiny-secp256k1';
import * as bitcoin from 'bitcoinjs-lib';
import { exec } from 'child_process';
import { promisify } from 'util';
const execPromise = promisify(exec);

dotenv.config();

const FEE_RATES = {
  testnet: {
    default: 3500, // High rate for testnet to ensure confirmation
    urgent: 7500,
  },
  mainnet: {
    default: 15, // Normal priority
    urgent: 30, // High priority for stuck transactions
  },
};

type DepositState = {
  txId?: string;
  deposit?: Deposit;
  lastUpdate: number;
  bitcoinRecoveryAddress: string;
  bitcoinRecoveryAddressPrivKey: string;
  bitcoinDepositAddress: string;
  bitcoinSendMethod?: 'bitcoin-cli' | 'manual';
  bitcoinAmount?: string;
  bitcoinTxHash?: string;
  mintTxHash?: Hex | string;
  depositReceipt?: DepositReceipt;
  refundInitiated?: boolean;
  status:
    | 'new'
    | 'address created'
    | 'bitcoin sent'
    | 'minted'
    | 'refunded'
    | 'failed';
};

export interface BTCBridgeStrategy extends BaseStrategy {
  type: 'btc_bridge';
  amount: string; // Amount of BTC to bridge
  interval: number; // Interval in seconds
  btcFeeRate: number; // BTC network fee rate in sats/vB
  privateKeyEnvKey: string;
}

export class BTCBridgeExecutor
  extends BaseStrategyExecutor
  implements StrategyExecutor
{
  private strategy: BTCBridgeStrategy;
  private _isRunning: boolean = false;
  private interval?: NodeJS.Timeout;
  private currentDeposit?: DepositState;
  private totalMinted: number = 0;

  constructor(strategy: BTCBridgeStrategy) {
    super();
    this.strategy = strategy;
  }

  async start(): Promise<void> {
    if (this._isRunning) return;

    this._isRunning = true;
    this.interval = setInterval(async () => {
      try {
        await this.execute();
      } catch (error) {
        this.log(
          `Error in BTC Bridge strategy ${this.strategy.name}: ${error}`
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

  private async execute(): Promise<void> {
    if (!this.currentDeposit) {
      // Start new deposit process
      await this.startNewDeposit(this.strategy.amount);
      return;
    }

    await this.triggerMint();
  }

  private async startNewDeposit(amount: string): Promise<void> {
    console.log('Generating recovery address...');
    const ECPair = ECPairFactory(ecc);
    const keyPair = ECPair.makeRandom();
    const { address } = bitcoin.payments.p2wpkh({
      pubkey: keyPair.publicKey,
      network:
        process.env.NETWORK === 'testnet'
          ? bitcoin.networks.testnet
          : bitcoin.networks.bitcoin,
    });
    const bitcoinRecoveryAddress = address as string;
    const bitcoinRecoveryAddressPrivKey = keyPair.privateKey?.toString(
      'hex'
    ) as string;

    this.currentDeposit = {
      bitcoinAmount: amount,
      bitcoinRecoveryAddress,
      bitcoinRecoveryAddressPrivKey,
      status: 'new',
      lastUpdate: Date.now(),
      bitcoinDepositAddress: '',
    };

    console.log(`Bitcoin recovery address: ${bitcoinRecoveryAddress}`);

    console.log('Generating deposit address...');

    const signer = Web3Helper.getWallet(this.getWalletPrivateKey());

    const sdk =
      process.env.NETWORK != 'testnet'
        ? await TBTC.initializeMainnet(signer)
        : await TBTC.initializeSepolia(signer);

    const deposit = await sdk.deposits.initiateDeposit(
      this.currentDeposit.bitcoinRecoveryAddress
    );

    this.currentDeposit.deposit = deposit;

    // Store deposit receipt
    this.currentDeposit.depositReceipt = deposit.getReceipt();

    try {
      this.currentDeposit.bitcoinDepositAddress =
        await deposit.getBitcoinAddress();
    } catch (error) {
      console.log(error);
    }

    this.currentDeposit.status = 'address created';

    console.log('Catching mint info for future reference');

    console.log('\n');

    await this.triggerMint();
  }

  private async triggerMint() {
    if (!this.currentDeposit) {
      console.log('No deposit found');
      return;
    }

    if (this.currentDeposit?.status === 'minted') {
      console.log('This mint has already been completed!');
      return;
    }

    // Handle Bitcoin deposit if not done yet
    if (!this.currentDeposit?.bitcoinTxHash) {
      this.currentDeposit.bitcoinSendMethod = 'bitcoin-cli';

      if (!this.strategy.btcFeeRate) {
        console.log(
          `No BTC fee rate set. Using default value of ${FEE_RATES.mainnet.default} sats/vB`
        );
        this.strategy.btcFeeRate = FEE_RATES.mainnet.default;
      }

      const command = `bitcoin-cli -named sendtoaddress \
  address="${this.currentDeposit.bitcoinDepositAddress}" \
  amount=${this.currentDeposit.bitcoinAmount} \
  fee_rate=${this.strategy.btcFeeRate} \
  replaceable=true`;

      console.log(`\nExecuting command: ${command}\n`);

      try {
        const { stdout } = await execPromise(command);
        const txid = stdout.trim();
        console.log(`Transaction initiated! TXID: ${txid}`);
        this.currentDeposit.bitcoinTxHash = txid;
        this.currentDeposit.status = 'bitcoin sent';

        // Wait for confirmation
        if (!(await this.waitForTransactionConfirmation(txid, execPromise))) {
          return;
        }
      } catch (error) {
        console.log('Error executing bitcoin-cli command:', error);
        return;
      }
    }

    // Attempt minting
    try {
      const txHash = await this.currentDeposit.deposit?.initiateMinting();
      console.log(`Mint initiated. TxHash: \n${txHash}`);

      this.currentDeposit.mintTxHash = txHash;
      this.currentDeposit.status = 'minted';
      this.totalMinted += Number(this.strategy.amount);

    } catch (error) {
      console.log(error);
      console.log('Unable to initiate mint. Make sure:');
      console.log('1. BTC has been sent to the deposit address');
      console.log('2. Transaction has at least 1 confirmation');
      console.log('3. You have enough ETH for gas fees');
    }
  }

  private async handleMintCommand(args: string[]) {
    if(this.currentDeposit) {
      console.log('Mint already in progress');
      return;
    }

    if (args.length === 0) {
      console.log('Usage: mint <amount>');
      return;
    }

    const amount = args[0];

    await this.startNewDeposit(amount);
  }

  private async waitForTransactionConfirmation(
    txid: string,
    execPromise: any
  ): Promise<boolean> {
    console.log('\nWaiting for transaction confirmation...');
    let confirmations = 0;
    let attempts = 0;
    const maxAttempts = 60 * 60; // Will wait up to 1 hour
  
    while (confirmations < 1 && attempts < maxAttempts) {
      try {
        const { stdout } = await execPromise(
          `bitcoin-cli gettransaction ${txid}`
        );
        const txInfo = JSON.parse(stdout);
        confirmations = txInfo.confirmations || 0;
  
        if (confirmations >= 1) {
          console.log('Transaction confirmed!');
          return true;
        }
  
        attempts++;
        if (attempts % 6 === 0) {
          // Every minute
          console.log(
            `Still waiting... (${Math.round(attempts / 6)} minutes elapsed)`
          );
          // Check mempool status
          try {
            const { stdout: mempoolInfo } = await execPromise(
              `bitcoin-cli getmempoolentry ${txid}`
            );
            const mempoolData = JSON.parse(mempoolInfo);
            console.log(
              `Current fee rate: ${
                mempoolData.fees.base / mempoolData.vsize
              } sat/vB`
            );
          } catch (e) {
            // Transaction might not be in mempool
            console.log('Error checking mempool status:', e);
          }
        }
  
        await new Promise((resolve) => setTimeout(resolve, 10000)); // Wait 10 seconds between checks
      } catch (error) {
        console.log('Error checking transaction status:', error);
        return false;
      }
    }
  
    if (attempts >= maxAttempts) {
      console.log('\nTransaction still unconfirmed after 10 minutes.');
      console.log('You can:');
      console.log(
        '1. Continue waiting (the transaction will be processed automatically once confirmed)'
      );
      console.log('2. Try recovery options for faster confirmation');
      console.log(
        `3. Monitor the transaction: https://mempool.space/testnet/tx/${txid}`
      );
      return false;
    }
  
    return false;
  }

  public async getStatus(): Promise<any> {
    return {
      name: this.strategy.name,
      status: this.isRunning() ? 'Running' : 'Stopped',
      currentDeposit: this.currentDeposit,
      lastUpdate: new Date().toISOString(),
    };
  }

  public async handleCommand(action: string, args: string[]): Promise<string> {
    switch (action.toLowerCase()) {
      case 'status':
        return JSON.stringify(await this.getStatus(), null, 2);
      case 'mint':
        await this.handleMintCommand(args);
        return 'Mint command executed';
      default:
        return `Unknown command: ${action}. Available commands: status, mint`;
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
    return [
      `Type: BTC Bridge`,
      `Amount per mint: ${this.strategy.amount} BTC`,
      `Total minted: ${this.totalMinted} BTC`,
      `Interval: ${this.strategy.interval}s`,
      `BTC Fee Rate: ${this.strategy.btcFeeRate} sats/vB`,
    ];
  }
}
