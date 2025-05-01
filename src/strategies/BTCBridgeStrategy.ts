import { BaseStrategy, StrategyExecutor } from '../types/Strategy';
import { BaseStrategyExecutor, execPromise } from './BaseStrategyExecutor';
import { Web3Helper } from '../utils/web3';
import dotenv from 'dotenv';

import {
  Deposit,
  Hex,
  TBTC,
  DepositReceipt,
  ChainIdentifier,
} from '@keep-network/tbtc-v2.ts';
import ECPairFactory from 'ecpair';
import * as ecc from 'tiny-secp256k1';
import * as bitcoin from 'bitcoinjs-lib';
import { ethers } from 'ethers';
import fs from 'fs';
import path from 'path';
import { Keypair, PublicKey } from '@solana/web3.js';
import {
  getSolanaWallet,
  getSolBalance,
  getTokenBalance,
} from '../solana/utils';
import { swapOnJupiter } from '../utils/jupiter';
import {
  createMoneroWallet,
  estimateXmrFee,
  getXmrBalance,
  openWallet,
  transferXMR,
} from '../utils/monero';
import axios from 'axios';

dotenv.config();

const FEE_RATES = {
  testnet: {
    default: 950, // High rate for testnet to ensure confirmation
    urgent: 1500,
  },
  mainnet: {
    default: 5,
    urgent: 15,
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

type SwapTransaction = {
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
  failed?: boolean;
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
};

type Currency = 'btc' | 'xmr' | 'sol' | 'usdc' | 'tbtc';

export interface BTCBridgeStrategy extends BaseStrategy {
  type: 'btc_bridge';
  amount: string; // Amount of BTC to bridge
  interval: number; // Interval in seconds
  btcFeeRate: number; // BTC network fee rate in sats/vB
  privateKeyEnvKey: string;
  targetNetwork: 'ethereum' | 'solana';
  targetToken: 'tbtc' | 'usdc' | 'sol' | 'wbtc';
  generateNewSolanaWallet?: boolean; // Whether to generate new Solana wallet for each swap
}

export class BTCBridgeExecutor
  extends BaseStrategyExecutor
  implements StrategyExecutor
{
  private strategy: BTCBridgeStrategy;
  private _isRunning: boolean = false;
  private interval?: NodeJS.Timeout;
  private currentDeposit?: DepositState;
  private currentTransaction?: SwapTransaction;
  private totalMinted: number = 0;
  private storageDir = './.data/btc_bridge';
  private transactions: SwapTransaction[] = [];

  constructor(strategy: BTCBridgeStrategy) {
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

  private async backupDeposit() {
    if (!this.currentDeposit?.deposit) {
      return;
    }

    try {
      const receipt = this.currentDeposit.deposit.getReceipt();
      const backupData = {
        receipt,
        currentDeposit: this.currentDeposit,
      };

      const backupKey = `${
        this.storageDir
      }/${this.currentDeposit.bitcoinRecoveryAddress?.slice(0, 10)}.json`;
      fs.writeFileSync(backupKey, JSON.stringify(backupData, null, 2));
      this.log(`Backup saved to ${backupKey}`);
    } catch (error) {
      this.log(
        `Error creating backup: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
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
      this.backupDeposit();
    }
  }

  isRunning(): boolean {
    return this._isRunning;
  }

  private async execute(): Promise<void> {
    if (this.strategy.targetNetwork === 'ethereum') {
      await this.executeEthereumBridge();
    } else {
      await this.executeSolanaBridge();
    }
  }

  private async executeEthereumBridge(): Promise<void> {
    if (!this.currentDeposit) {
      await this.startNewDeposit(this.strategy.amount);
      return;
    }

    await this.triggerMint();
  }

  private async executeSolanaBridge(): Promise<void> {
    if (this.currentTransaction) {
      await this.processCurrentTransaction();
      return;
    }

    await this.startNewSwap(this.strategy.amount);
  }

  private async startNewSwap(amount: string): Promise<void> {
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
    this.currentTransaction = {
      id: `swap_${Date.now()}`,
      timestamp: Date.now(),
      status: 'pending',
      btcAmount: amount,
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

    await this.saveTransaction(this.currentTransaction);

    this.log(`New swap started. Solana wallet: ${solanaWallet.address}; XMR wallet: ${xmrWallet.address}`);

    await this.processCurrentTransaction();
  }

  private async processCurrentTransaction(): Promise<void> {
    if (!this.currentTransaction) return;

    try {
      switch (this.currentTransaction.status) {
        case 'pending':
          await this.processPendingTransaction();
          break;
        case 'btc_sent':
          await this.processBtcSentTransaction();
          break;
        case 'xmr_received':
          await this.processXmrReceivedTransaction();
          break;
        case 'xmr_sent':
          await this.processXmrSentTransaction();
          break;
        case 'finalizing':
          await this.processFinalizingTransaction();
          break;
        default:
          break;
      }
    } catch (error) {
      this.currentTransaction.failed = true;
      this.transactions.push(this.currentTransaction);
      await this.saveTransactions();
      throw error;
    }
  }

  private async processPendingTransaction(): Promise<void> {
    if (!this.currentTransaction) return;

    this.log('Initiate BTC -> XMR swap')
    // Initiate BTC -> XMR swap
    const btcToXmr = await this.initiateChangeNowSwap(
      'btc',
      'xmr',
      'btc',
      'xmr',
      this.currentTransaction.btcAmount,
      this.currentTransaction.intermediateWallet.xmrAddress
    );
    this.currentTransaction.xmrAmount = btcToXmr.expectedAmount;
    this.currentTransaction.status = 'btc_sent';
    await this.saveTransaction(this.currentTransaction);

    this.log(`Sending ${this.currentTransaction.btcAmount} BTC to ${btcToXmr.payinAddress}`);

    const btcTxHash = await this.sendBtc(
      btcToXmr.payinAddress,
      this.currentTransaction.btcAmount,
      this.strategy.btcFeeRate
    );
    this.currentTransaction.btcTxHash = btcTxHash;

    await this.processBtcSentTransaction();
  }

  private async processBtcSentTransaction(): Promise<void> {
    if (!this.currentTransaction?.btcTxHash) return;

    // Wait for BTC transaction to be confirmed
    if (
      !(await this.waitForBtcTransactionConfirmation(
        this.currentTransaction.btcTxHash,
        execPromise
      ))
    ) {
      return;
    }

    // Wait for XMR to arrive
    const maxWaitTime = 2 * 1000 * 60 * 60; // 2 hours
    const startTime = Date.now();
    this.log(`Waiting for XMR to arrive at ${this.currentTransaction.intermediateWallet.xmrAddress}`);
    while (true) {
      const xmrBalance = await getXmrBalance(
        this.currentTransaction.intermediateWallet.filename,
        this.currentTransaction.intermediateWallet.password
      );
      if (xmrBalance.balance > 0) {
        this.currentTransaction.status = 'xmr_received';
        await this.saveTransaction(this.currentTransaction);
        break;
      }
      if (Date.now() - startTime > maxWaitTime) {
        throw new Error('XMR not received within 2 hours');
      }
      await new Promise((resolve) => setTimeout(resolve, 10000));
    }

    await this.processXmrReceivedTransaction();
  }

  private async processXmrReceivedTransaction(): Promise<void> {
    if (!this.currentTransaction) return;

    // Convert XMR to target token on Solana
    this.log(`Converting XMR to ${this.strategy.targetToken} on Solana`);
    // let's get the actual balance of XMR to send, minus fees
    const xmrBalance = await getXmrBalance(
      this.currentTransaction.intermediateWallet.filename,
      this.currentTransaction.intermediateWallet.password
    );
    const dummyDest = '4AKvQTRf8w21HoPnAgFWc7U4v3tSL782ZXCj5YQ82w466VqwPsuJZfYWmjEqr56h42KMZS4jgXLEe9PKHBdLTA7x6yKvUg8';
    const xmrFee = await estimateXmrFee(
      this.currentTransaction.intermediateWallet.filename,
      this.currentTransaction.intermediateWallet.password,
      dummyDest,
      xmrBalance.balance/2n
    );
    const xmrToSend = xmrBalance.balance - xmrFee.estimatedFeeXMR;
    this.log(`Sending ${xmrToSend} XMR to ChangeNow`);
    const targetToken = this.strategy.targetToken;
    const xmrToSol = await this.initiateChangeNowSwap(
      'xmr',
      targetToken === 'wbtc' ? 'btc' : targetToken,
      'xmr',
      'solana',
      (Number(xmrToSend)/1e12).toString(),
      this.currentTransaction.destinationWallet.solanaAddress
    );

    this.currentTransaction.solUsdcAmount = xmrToSol.expectedAmount;

    this.log(`Sending ${xmrToSend} XMR to ChangeNow`);

    // Send XMR to ChangeNow
    await transferXMR(
      this.currentTransaction.intermediateWallet.filename,
      this.currentTransaction.intermediateWallet.password,
      xmrToSol.payinAddress,
      xmrToSend
    );

    this.currentTransaction.status = 'xmr_sent';
    await this.saveTransaction(this.currentTransaction);
  }

  private async processXmrSentTransaction(): Promise<void> {
    if (!this.currentTransaction) return;

    const targetToken = this.strategy.targetToken;
    const tokenAddress = process.env[`${targetToken.toUpperCase()}_ADDRESS`]!;

    // Wait for target token to arrive
    while (true) {
      let tokenBalance = 0;
      if (targetToken === 'sol') {
        tokenBalance = await getSolBalance(
          Web3Helper.getSolanaConnection(),
          new PublicKey(this.currentTransaction.destinationWallet.solanaAddress)
        );
      } else {
        await getTokenBalance(
          Web3Helper.getSolanaConnection(),
          new PublicKey(tokenAddress),
          new PublicKey(this.currentTransaction.destinationWallet.solanaAddress)
        );
      }

      if (tokenBalance > 0) {
        this.currentTransaction.status = 'completed';
        await this.saveTransaction(this.currentTransaction);
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 60000));
    }

  }

  private async processFinalizingTransaction(): Promise<void> {
    // No-op for now, can be used for additional cleanup if needed
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

    const walletInfo = await openWallet(filename, password);
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
    try {
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
            'x-changenow-api-key': process.env.CHANGENOW_API_KEY,
          },
        }
      );
  
      return {
        id: response.data.id,
        payinAddress: response.data.payinAddress,
        expectedAmount: response.data.expectedAmountTo,
      };
    } catch(err: any) {
      this.log(`Error initiating ChangeNow swap: ${err?.response?.data}`);
      throw err;
    }
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

  public async getStatus(): Promise<any> {
    return {
      name: this.strategy.name,
      status: this.isRunning() ? 'Running' : 'Stopped',
      currentDeposit: this.currentDeposit,
      currentTransaction: this.currentTransaction,
      transactions: this.transactions,
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
      case 'transactions':
        return JSON.stringify(this.transactions, null, 2);
      default:
        return `Unknown command: ${action}. Available commands: status, mint, resume, clearbackups, transactions`;
    }
  }

  public async resumeFromBackup(backupKey: string): Promise<string> {
    let fileName = `${this.storageDir}/${backupKey}.json`;
    if (!fs.existsSync(fileName)) {
      return 'Backup file does not exist';
    }

    try {
      const backup = JSON.parse(fs.readFileSync(fileName, 'utf8'));
      if (backupKey.startsWith('swap')) {
        this.currentTransaction = backup;
        await this.processCurrentTransaction();
        return 'Resume command executed';
      }

      if (!backup.receipt || !backup.currentDeposit?.bitcoinRecoveryAddress) {
        return 'Backup file does not contain a valid deposit receipt';
      }

      // Convert Buffer data arrays to Hex type using Hex.from()
      const reconstructedReceipt: DepositReceipt = {
        depositor: {
          identifierHex: backup.receipt.depositor.identifierHex,
          equals: function (other: ChainIdentifier): boolean {
            return this.identifierHex === other.identifierHex;
          },
        },
        blindingFactor: Hex.from(
          Buffer.from(backup.receipt.blindingFactor._hex.data)
        ),
        walletPublicKeyHash: Hex.from(
          Buffer.from(backup.receipt.walletPublicKeyHash._hex.data)
        ),
        refundPublicKeyHash: Hex.from(
          Buffer.from(backup.receipt.refundPublicKeyHash._hex.data)
        ),
        refundLocktime: Hex.from(
          Buffer.from(backup.receipt.refundLocktime._hex.data)
        ),
      };

      // Reconstruct the TBTC deposit object
      const provider = new ethers.providers.JsonRpcProvider(
        process.env.TBTC_ETH_RPC
      );
      const signer = new ethers.Wallet(this.getWalletPrivateKey(), provider);

      const sdk =
        process.env.NETWORK != 'testnet'
          ? await TBTC.initializeMainnet(signer)
          : await TBTC.initializeSepolia(signer);

      // Use the reconstructed receipt
      const deposit = await Deposit.fromReceipt(
        reconstructedReceipt,
        sdk.tbtcContracts,
        sdk.bitcoinClient
      );
      backup.currentDeposit.deposit = deposit;

      this.currentDeposit = backup.currentDeposit as DepositState;
      this.log('Successfully restored deposit from backup');
      await this.triggerMint();
      return 'Resume command executed';
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.log(`Error resuming from backup: ${errorMessage}`);
      return `Failed to resume from backup: ${errorMessage}`;
    }
  }

  public async clearBackups(): Promise<string> {
    const backups = fs.readdirSync(`${this.storageDir}`);
    backups.forEach((backup) => {
      fs.unlinkSync(`${this.storageDir}/${backup}`);
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
    const completedSwaps = this.transactions.filter(
      (t) => t.status === 'completed'
    ).length;

    return [
      `Type: BTC Bridge`,
      `Key: ${this.strategy.key}`,
      `Target Network: ${this.strategy.targetNetwork}`,
      `Target Token: ${this.strategy.targetToken}`,
      `Amount per bridge: ${this.strategy.amount} BTC`,
      `Total minted: ${this.totalMinted} BTC`,
      `Interval: ${this.strategy.interval}s`,
      `BTC Fee Rate: ${this.strategy.btcFeeRate} sats/vB`,
      `Completed swaps: ${completedSwaps}`,
      `Total transactions: ${this.transactions.length}`,
    ];
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
    if (
      !(await this.waitForBtcTransactionConfirmation(
        this.currentDeposit.bitcoinTxHash,
        execPromise
      ))
    ) {
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

        let backupKey = `${
          this.storageDir
        }/${this.currentDeposit?.bitcoinRecoveryAddress.slice(0, 10)}.json`;
        if (fs.existsSync(backupKey)) {
          // delete backup
          fs.unlinkSync(backupKey);
        }

        this.currentDeposit = undefined;
        retries = 0;
        return;
      } catch (error) {
        console.log(error);
        this.log(`Mint failed. Retrying... (${retries + 1}/10)`);
        await new Promise((resolve) => setTimeout(resolve, 60 * 1000));
        retries++;
        if (retries >= 10) {
          console.log(error);
          console.log('Unable to initiate mint. Make sure:');
          console.log('1. BTC has been sent to the deposit address');
          console.log('2. Transaction has at least 1 confirmation');
          console.log('3. You have enough ETH for gas fees');
          this.backupDeposit();
          return;
        }
      }
    }
  }

  private async handleMintCommand(args: string[]) {
    if (this.currentDeposit || this.currentTransaction) {
      console.log('Mint already in progress');
      return;
    }

    if (args.length === 0) {
      console.log('Usage: mint <amount>');
      return;
    }

    const amount = args[0];

    if (this.strategy.targetNetwork === 'ethereum') {
      await this.startNewDeposit(amount);
    } else {
      await this.startNewSwap(amount);
    }
  }
}
