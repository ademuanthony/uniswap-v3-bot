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
import { ethers } from 'ethers';
import fs from 'fs';
const execPromise = promisify(exec);

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
  private storageDir = './.data/btc_bridge';

  constructor(strategy: BTCBridgeStrategy) {
    super();
    this.strategy = strategy;
    this.initStorage();
  }

  private initStorage() {
    if (!fs.existsSync(this.storageDir)) {
      fs.mkdirSync(this.storageDir, { recursive: true });
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
          `Error in BTC Bridge strategy ${this.strategy.name}: ${error}`
        );
      }
    }, this.strategy.interval * 1000);
  }

  stop(): void {
    this.log('Stopping BTC Bridge strategy...');
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
    this._isRunning = false;
    if (this.currentDeposit) {
      let backupKey = `${this.storageDir}/${this.currentDeposit?.bitcoinRecoveryAddress?.slice(0, 10)}.json`;
      fs.writeFileSync(backupKey, JSON.stringify(this.currentDeposit, null, 2));
      this.log(`Backup saved to ${backupKey}`);
    }
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
    if (this.currentDeposit) return;

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

    const provider = new ethers.providers.JsonRpcProvider(
      process.env.TBTC_ETH_RPC
    );
    const signer = new ethers.Wallet(this.getWalletPrivateKey(), provider);

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

      } catch (error) {
        console.log('Error executing bitcoin-cli command:', error);
        return;
      }
    }

    // Wait for confirmation
    if (!(await this.waitForTransactionConfirmation(this.currentDeposit.bitcoinTxHash, execPromise))) {
      return;
    }

    // wait for fee seconds before minting
    await new Promise((resolve) => setTimeout(resolve, 10 * 1000));

    let retries = 0;

    while (true) {
      // Attempt minting
      try {
        if (!this.currentDeposit?.deposit) {
          return;
        }
        const txHash = await this.currentDeposit.deposit?.initiateMinting();
        console.log(`Mint initiated. TxHash: \n${txHash}`);

        this.currentDeposit.mintTxHash = txHash;
        this.currentDeposit.status = 'minted';
        this.totalMinted += Number(this.strategy.amount);

        let backupKey = `${this.storageDir}/${this.currentDeposit?.bitcoinRecoveryAddress}.json`;
        if (fs.existsSync(backupKey)) {
          // delete backup
          fs.unlinkSync(backupKey);
        }

        this.currentDeposit = undefined;
        retries = 0;
        return;
      } catch (error) {
        this.log(`Mint failed. Retrying... (${retries + 1}/10)`);
        await new Promise((resolve) => setTimeout(resolve, 60 * 1000));
        retries++;
        if (retries >= 10) {
          console.log(error);
          console.log('Unable to initiate mint. Make sure:');
          console.log('1. BTC has been sent to the deposit address');
          console.log('2. Transaction has at least 1 confirmation');
          console.log('3. You have enough ETH for gas fees');
          let backupKey = `${this.storageDir}/${this.currentDeposit?.bitcoinRecoveryAddress}.json`;
          fs.writeFileSync(
            backupKey,
            JSON.stringify(this.currentDeposit, null, 2)
          );

          this.log(`Backup saved to ${backupKey}`);
          return;
        }
      }
    }
  }

  private async handleMintCommand(args: string[]) {
    if (this.currentDeposit) {
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

    while (confirmations < 2 && attempts < maxAttempts) {
      try {
        const { stdout } = await execPromise(
          `bitcoin-cli gettransaction ${txid}`
        );
        const txInfo = JSON.parse(stdout);
        confirmations = txInfo.confirmations || 0;

        if (confirmations >= 2) {
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
          //
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
      case 'resume':
        return await this.resumeFromBackup(args[0]);
      case 'clearbackups':
        return await this.clearBackups();
      default:
        return `Unknown command: ${action}. Available commands: status, mint, resume, clearbackups`;
    }
  }

  public async resumeFromBackup(backupKey: string): Promise<string> {
    let fileName = `./.data/backups/${backupKey}.json`;
    if (!fs.existsSync(fileName)) {
      return 'Backup file does not exist';
    }
    const backup = JSON.parse(fs.readFileSync(fileName, 'utf8')) as DepositState;
    this.currentDeposit = backup;
    await this.triggerMint();
    return 'Resume command executed';
  }

  public async clearBackups(): Promise<string> {
    const backups = fs.readdirSync('./.data/backups');
    backups.forEach((backup) => {
      fs.unlinkSync(`./.data/backups/${backup}`);
    });
    return 'Backups cleared';
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
    const wallet = Web3Helper.getWallet(this.getWalletPrivateKey());
    return [
      `Type: BTC Bridge`,
      `Key: ${this.strategy.key}`,
      `Wallet: ${wallet.address}`,
      `Amount per mint: ${this.strategy.amount} BTC`,
      `Total minted: ${this.totalMinted} BTC`,
      `Interval: ${this.strategy.interval}s`,
      `BTC Fee Rate: ${this.strategy.btcFeeRate} sats/vB`,
    ];
  }
}
