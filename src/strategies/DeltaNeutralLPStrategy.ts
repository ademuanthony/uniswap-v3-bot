import { BaseStrategy, StrategyExecutor } from '../types/Strategy';
import { BaseStrategyExecutor } from './BaseStrategyExecutor';
import {
  Connection,
  Transaction,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { getAccount, getAssociatedTokenAddress } from '@solana/spl-token';
import { Wallet } from '@project-serum/anchor';
import { fetch } from 'cross-fetch';
import Decimal from 'decimal.js';
import {
  DefaultTransactionExecutor,
  JitoTransactionExecutor,
  TransactionExecutor,
  WarpTransactionExecutor,
} from '../solana/transactions';
import {
  closePositionInstructions,
  fetchConcentratedLiquidityPool,
  openPositionInstructions,
  PoolInfo,
  setWhirlpoolsConfig,
  swapInstructions,
} from '@orca-so/whirlpools';
import Binance from 'binance-api-node';
import {
  address,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getComputeUnitEstimateForTransactionMessageFactory,
  KeyPairSigner,
  pipe,
  prependTransactionMessageInstructions,
  Rpc,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from '@solana/kit';
import { GetAccountInfoApi } from '@solana/kit';
import { GetMultipleAccountsApi } from '@solana/kit';
import { GetMinimumBalanceForRentExemptionApi } from '@solana/kit';
import { GetEpochInfoApi } from '@solana/kit';
import { getSetComputeUnitLimitInstruction } from '@solana-program/compute-budget';
import { getSetComputeUnitPriceInstruction } from '@solana-program/compute-budget';
import { base58 } from 'ethers/lib/utils';
import fs from 'fs';

export interface DeltaNeutralLPStrategy extends BaseStrategy {
  type: 'delta-neutral-lp';
  transactionExecutor: string;
  jitoFee: string;
  warpRpcUrl: string;
  // Connection details
  rpcUrlEnv: string;
  privateKeyEnvKey: string;

  // Binance API configuration
  binanceApiKeyEnv: string;
  binanceApiSecretEnv: string;
  binanceTestnet: boolean;

  // Telegram configuration
  telegramBotTokenEnv: string;
  telegramChatIds: string[]; // Array of authorized chat IDs
  telegramEnabled: boolean;

  usdcMint: string;

  // Pool configuration
  portfolioPercentage: number; // Percentage of portfolio to use (0-100)
  lowerBoundPercent: number; // Lower price bound percentage from current price
  upperBoundPercent: number; // Upper price bound percentage from current price
  rebalanceDelta: number; // Price change percentage that triggers perp rebalance

  // Hedge configuration
  keepHedgeAboveEntry: boolean; // Whether to maintain hedge when price > entry
  hedgeLeverage: number; // Leverage for Binance perp position

  // Rebalance configuration for out-of-range scenarios
  lowerMoveLowerBound: number; // New lower bound when price moves down
  lowerMoveUpperBound: number; // New upper bound when price moves down
  upperMoveLowerBound: number; // New lower bound when price moves up
  upperMoveUpperBound: number; // New upper bound when price moves up
}

interface PositionState {
  positionMint?: string;
  binancePerpPositionId?: string;
  entryPrice: number;
  currentPrice: number;
  solInPool: number;
  usdcInPool: number;
  solFee: number;
  usdcFee: number;
  perpSize: number;
  lastRebalancePrice: number;
  lowerPrice: number;
  upperPrice: number;
  status: 'initializing' | 'active' | 'rebalancing' | 'closed';
}

interface JupiterQuoteResponse {
  inputMint: string;
  outputMint: string;
  amount: string;
  swapMode: string;
  otherAmountThreshold: string;
  routes: any[];
  contextSlot: number;
}

const SOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');
const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

export const wSOLToken = { mint: SOL_MINT, decimals: 9 };
export const USDCToken = { mint: USDC_MINT, decimals: 6 };

export const sleep = (milliseconds: number) => {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
};

export const getTokenBalance = async (
  connection: Connection,
  tokenMint: PublicKey,
  walletAddress: PublicKey
): Promise<number> => {
  try {
    const ata = await getAssociatedTokenAddress(tokenMint, walletAddress);
    const info = await getAccount(connection, ata);
    return Number(info.amount);
  } catch (err) {
    console.log(`Error getting token balance: ${err}`);
  }

  return 0;
};

export const getSolBalance = async (
  connection: Connection,
  walletAddress: PublicKey
): Promise<number> => {
  const balance = await connection.getBalance(walletAddress);
  return balance;
};

interface Lock {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
}

class LockManager {
  private locks: Map<string, Lock | null> = new Map();

  async acquire(lockName: string): Promise<void> {
    const existingLock = this.locks.get(lockName);
    if (existingLock) {
      // Wait for the existing lock to be released
      await existingLock.promise;
    }

    // Create a new lock
    let resolve: () => void;
    let reject: (error: Error) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });

    this.locks.set(lockName, { promise, resolve: resolve!, reject: reject! });
  }

  release(lockName: string, error?: Error): void {
    const lock = this.locks.get(lockName);
    if (lock) {
      if (error) {
        lock.reject(error);
      } else {
        lock.resolve();
      }
      this.locks.set(lockName, null);
    }
  }

  isLocked(lockName: string): boolean {
    return this.locks.get(lockName) !== null;
  }
}

export class DeltaNeutralLPExecutor
  extends BaseStrategyExecutor
  implements StrategyExecutor
{
  private config: DeltaNeutralLPStrategy;
  private _isRunning: boolean = false;
  private priceMonitor?: NodeJS.Timeout;
  private position?: PositionState;
  private binanceClient: ReturnType<typeof Binance>;
  private lockManager: LockManager;
  private readonly TELEGRAM_API_URL = 'https://api.telegram.org/bot';

  private connection: Connection;
  private solanaRpc: Rpc<
    GetAccountInfoApi &
      GetMultipleAccountsApi &
      GetMinimumBalanceForRentExemptionApi &
      GetEpochInfoApi
  >;
  private transactionExecutor: TransactionExecutor;
  private orcaCompartibleWallet?: KeyPairSigner;
  private orcaPool?: PoolInfo;

  private rpcUrl(): string {
    return process.env[this.config.rpcUrlEnv] || '';
  }

  constructor(config: DeltaNeutralLPStrategy) {
    super();
    this.config = config;
    this.validateConfig();
    this.connection = new Connection(this.rpcUrl(), 'confirmed');
    this.solanaRpc = createSolanaRpc(this.rpcUrl());

    const binanceApiKey = process.env[config.binanceApiKeyEnv] || '';
    const binanceApiSecret = process.env[config.binanceApiSecretEnv] || '';

    // Initialize Binance client
    this.binanceClient = Binance({
      apiKey: binanceApiKey,
      apiSecret: binanceApiSecret,
      httpBase: this.config.binanceTestnet
        ? 'https://testnet.binance.vision'
        : 'https://api.binance.com',
      httpFutures: this.config.binanceTestnet
        ? 'https://testnet.binancefuture.com'
        : 'https://fapi.binance.com',
      wsBase: this.config.binanceTestnet
        ? 'wss://testnet.binance.vision'
        : 'wss://stream.binance.com',
      wsFutures: this.config.binanceTestnet
        ? 'wss://stream.binancefuture.com'
        : 'wss://fstream.binance.com',
    });

    // Initialize transaction executor
    switch (config.transactionExecutor) {
      case 'jito':
        this.transactionExecutor = new JitoTransactionExecutor(
          config.jitoFee,
          this.connection
        );
        break;
      case 'warp':
        this.transactionExecutor = new WarpTransactionExecutor(
          config.warpRpcUrl
        );
        break;
      default:
        this.transactionExecutor = new DefaultTransactionExecutor(
          this.connection
        );
    }

    this.lockManager = new LockManager();
    this.initClients();
  }

  private validateConfig(): void {
    const errors: string[] = [];

    // Validate required fields
    if (!this.rpcUrl()) {
      errors.push('RPC URL is required');
    }

    if (!this.config.privateKeyEnvKey) {
      errors.push('Private key environment variable key is required');
    }

    if (!process.env[this.config.privateKeyEnvKey]) {
      errors.push(
        `Private key not found in environment variable: ${this.config.privateKeyEnvKey}`
      );
    }

    if (!this.config.binanceApiKeyEnv) {
      errors.push('Binance API key environment variable key is required');
    }

    if (!process.env[this.config.binanceApiKeyEnv]) {
      errors.push(
        `Binance API key not found in environment variable: ${this.config.binanceApiKeyEnv}`
      );
    }

    if (!this.config.binanceApiSecretEnv) {
      errors.push('Binance API secret environment variable key is required');
    }

    if (!process.env[this.config.binanceApiSecretEnv]) {
      errors.push(
        `Binance API secret not found in environment variable: ${this.config.binanceApiSecretEnv}`
      );
    }

    if (!this.config.usdcMint) {
      errors.push('USDC mint address is required');
    }

    // Validate numeric ranges
    if (
      this.config.portfolioPercentage <= 0 ||
      this.config.portfolioPercentage > 100
    ) {
      errors.push('Portfolio percentage must be between 0 and 100');
    }

    if (this.config.lowerBoundPercent <= 0) {
      errors.push('Lower bound percentage must be greater than 0');
    }

    if (this.config.upperBoundPercent <= 0) {
      errors.push('Upper bound percentage must be greater than 0');
    }

    if (this.config.rebalanceDelta <= 0) {
      errors.push('Rebalance delta must be greater than 0');
    }

    if (this.config.hedgeLeverage <= 0) {
      errors.push('Hedge leverage must be greater than 0');
    }

    // Validate transaction executor specific fields
    if (this.config.transactionExecutor === 'jito' && !this.config.jitoFee) {
      errors.push('Jito fee is required when using Jito transaction executor');
    }

    if (this.config.transactionExecutor === 'warp' && !this.config.warpRpcUrl) {
      errors.push(
        'Warp RPC URL is required when using Warp transaction executor'
      );
    }

    // Validate Telegram configuration if enabled
    if (this.config.telegramEnabled) {
      if (!this.config.telegramBotTokenEnv) {
        errors.push(
          'Telegram bot token environment variable key is required when Telegram is enabled'
        );
      }

      if (!process.env[this.config.telegramBotTokenEnv]) {
        errors.push(
          `Telegram bot token not found in environment variable: ${this.config.telegramBotTokenEnv}`
        );
      }

      if (
        !this.config.telegramChatIds ||
        this.config.telegramChatIds.length === 0
      ) {
        errors.push(
          'At least one Telegram chat ID is required when Telegram is enabled'
        );
      }
    }

    // Validate price bound movement percentages
    if (this.config.lowerMoveLowerBound <= 0) {
      errors.push('Lower move lower bound must be greater than 0');
    }

    if (this.config.lowerMoveUpperBound <= 0) {
      errors.push('Lower move upper bound must be greater than 0');
    }

    if (this.config.upperMoveLowerBound <= 0) {
      errors.push('Upper move lower bound must be greater than 0');
    }

    if (this.config.upperMoveUpperBound <= 0) {
      errors.push('Upper move upper bound must be greater than 0');
    }

    // If there are any validation errors, throw them all at once
    if (errors.length > 0) {
      throw new Error(`Configuration validation failed:\n${errors.join('\n')}`);
    }
  }

  private async initClients() {
    try {
      this.log('Initializing protocol clients...');
      await setWhirlpoolsConfig('solanaMainnet');
      const keyPairBytes = new Uint8Array(
        JSON.parse(fs.readFileSync(this.getWalletPrivateKey(), 'utf8'))
      );
      this.orcaCompartibleWallet = await createKeyPairSignerFromBytes(keyPairBytes);
      this.log(`Orca compatible wallet: ${this.orcaCompartibleWallet!.address}`);

      this.orcaPool = await fetchConcentratedLiquidityPool(
        this.solanaRpc,
        address(SOL_MINT.toBase58()),
        address(USDC_MINT.toBase58()),
        64
      );

      // // Set leverage for SOLUSDT futures
      // await this.binanceClient.futuresLeverage({
      //   symbol: 'SOLUSDT',
      //   leverage: this.config.hedgeLeverage,
      // });

      // // Set margin type to isolated
      // await this.binanceClient.futuresMarginType({
      //   symbol: 'SOLUSDT',
      //   marginType: 'ISOLATED',
      // });
    } catch (error) {
      this.log(`Client initialization failed: ${error}`);
      throw error;
    }
  }

  private async sendTelegramMessage(
    message: string,
    isCritical: boolean = false
  ) {
    if (
      !this.config.telegramEnabled ||
      !process.env[this.config.telegramBotTokenEnv]
    )
      return;

    const prefix = isCritical ? '🚨 CRITICAL ALERT 🚨\n' : '📊 Update:\n';
    const fullMessage = `${prefix}${message}`;

    for (const chatId of this.config.telegramChatIds) {
      try {
        await fetch(
          `${this.TELEGRAM_API_URL}${
            process.env[this.config.telegramBotTokenEnv]
          }/sendMessage`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              chat_id: chatId,
              text: fullMessage,
              parse_mode: 'HTML',
            }),
          }
        );
      } catch (error) {
        this.log(`Failed to send Telegram message: ${error}`);
      }
    }
  }

  private async handleCriticalError(
    operation: string,
    error: unknown,
    shouldExit: boolean = false
  ) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const criticalMessage = `Critical error in ${operation}: ${errorMessage}`;

    this.log(criticalMessage);
    await this.sendTelegramMessage(criticalMessage, true);

    if (shouldExit) {
      this.log('Initiating emergency position closure...');
      await this.sendTelegramMessage(
        'Initiating emergency position closure...',
        true
      );

      try {
        await this.closePositions();
        await this.sendTelegramMessage(
          'Emergency position closure completed successfully.',
          true
        );
      } catch (closeError) {
        const closeErrorMessage =
          closeError instanceof Error ? closeError.message : String(closeError);
        await this.sendTelegramMessage(
          `Failed to close positions during emergency: ${closeErrorMessage}`,
          true
        );
      }

      this.stop();
    }
  }

  private async retryBinanceOperation<T>(
    operation: () => Promise<T>,
    maxRetries: number = 3,
    delayMs: number = 1000,
    isCritical: boolean = false
  ): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error: unknown) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        lastError = error instanceof Error ? error : new Error(errorMessage);

        // Check if error is retryable
        const isRetryable =
          errorMessage.includes('timeout') ||
          errorMessage.includes('network') ||
          errorMessage.includes('rate limit') ||
          errorMessage.includes('Too many requests') ||
          errorMessage.includes('Internal server error');

        if (!isRetryable || attempt === maxRetries) {
          if (isCritical) {
            await this.handleCriticalError('Binance operation', error, true);
          }
          throw lastError;
        }

        this.log(
          `Binance API attempt ${attempt} failed: ${errorMessage}. Retrying in ${delayMs}ms...`
        );
        await sleep(delayMs * attempt); // Exponential backoff
      }
    }

    throw lastError;
  }

  private async withLock<T>(
    lockName: string,
    operation: () => Promise<T>
  ): Promise<T> {
    try {
      await this.lockManager.acquire(lockName);
      return await operation();
    } finally {
      this.lockManager.release(lockName);
    }
  }

  private async openBinancePerpPosition(size: number) {
    try {
      // Open short position on Binance with retries
      const order = await this.retryBinanceOperation(
        () =>
          this.binanceClient.futuresOrder({
            symbol: 'SOLUSDT',
            side: 'SELL',
            type: 'MARKET',
            quantity: size.toFixed(3),
            reduceOnly: 'false',
          }),
        3,
        1000,
        true // Mark as critical operation
      );

      this.log(`Opened Binance perp position: ${order.orderId}`);
      await this.sendTelegramMessage(
        `Opened Binance perp position: ${order.orderId}`
      );

      // Get the current position's price bounds
      if (!this.position) {
        throw new Error('Position state not available for TP/SL orders');
      }

      const { lowerPrice, upperPrice } = this.position;

      // Place take-profit order (buy to close at lower price)
      await this.retryBinanceOperation(
        () =>
          this.binanceClient.futuresOrder({
            symbol: 'SOLUSDT',
            side: 'BUY',
            type: 'TAKE_PROFIT_MARKET',
            stopPrice: lowerPrice.toFixed(2),
            quantity: size.toFixed(3),
            reduceOnly: 'true',
          }),
        3,
        1000,
        true
      );

      // Place stop-loss order (buy to close at upper price)
      await this.retryBinanceOperation(
        () =>
          this.binanceClient.futuresOrder({
            symbol: 'SOLUSDT',
            side: 'BUY',
            type: 'STOP_MARKET',
            stopPrice: upperPrice.toFixed(2),
            quantity: size.toFixed(3),
            reduceOnly: 'true',
          }),
        3,
        1000,
        true
      );

      this.log(`Added TP at ${lowerPrice} and SL at ${upperPrice}`);
      await this.sendTelegramMessage(
        `Added TP at ${lowerPrice} and SL at ${upperPrice}`
      );
      return order.orderId.toString();
    } catch (error: unknown) {
      await this.handleCriticalError('Opening Binance position', error, true);
      throw error;
    }
  }

  private async adjustBinancePerpPosition(targetSize: number) {
    try {
      if (!this.position?.binancePerpPositionId) return;

      const currentSize = this.position.perpSize;
      const sizeDiff = targetSize - currentSize;

      if (Math.abs(sizeDiff) > 0.01) {
        const currentPrice = await this.getCurrentPrice();
        const quantity = Math.abs(sizeDiff) / currentPrice;

        // Cancel existing TP/SL orders before adjusting position
        await this.retryBinanceOperation(
          () =>
            this.binanceClient.futuresCancelAllOpenOrders({
              symbol: 'SOLUSDT',
            }),
          3,
          1000,
          true
        );

        // Adjust position with retries
        await this.retryBinanceOperation(
          () =>
            this.binanceClient.futuresOrder({
              symbol: 'SOLUSDT',
              side: sizeDiff > 0 ? 'SELL' : 'BUY',
              type: 'MARKET',
              quantity: quantity.toFixed(3),
              reduceOnly: 'false',
            }),
          3,
          1000,
          true
        );

        // Place new TP/SL orders with updated size
        const { lowerPrice, upperPrice } = this.position;
        await this.retryBinanceOperation(
          () =>
            this.binanceClient.futuresOrder({
              symbol: 'SOLUSDT',
              side: 'BUY',
              type: 'TAKE_PROFIT_MARKET',
              stopPrice: lowerPrice.toFixed(2),
              quantity: targetSize.toFixed(3),
              reduceOnly: 'true',
            }),
          3,
          1000,
          true
        );

        await this.retryBinanceOperation(
          () =>
            this.binanceClient.futuresOrder({
              symbol: 'SOLUSDT',
              side: 'BUY',
              type: 'STOP_MARKET',
              stopPrice: upperPrice.toFixed(2),
              quantity: targetSize.toFixed(3),
              reduceOnly: 'true',
            }),
          3,
          1000,
          true
        );

        this.position.perpSize = targetSize;
        const message = `Adjusted Binance perp position to ${targetSize} SOL with updated TP/SL`;
        this.log(message);
        await this.sendTelegramMessage(message);
      }
    } catch (error: unknown) {
      await this.handleCriticalError('Adjusting Binance position', error, true);
      throw error;
    }
  }

  private async closeBinancePerpPosition() {
    try {
      if (!this.position?.binancePerpPositionId) return;

      // Get current position size with retries
      const positions = await this.retryBinanceOperation(() =>
        this.binanceClient.futuresPositionRisk()
      );

      const solPosition = positions.find((p) => p.symbol === 'SOLUSDT');

      if (solPosition && parseFloat(solPosition.positionAmt) !== 0) {
        // Close position with retries
        await this.retryBinanceOperation(() =>
          this.binanceClient.futuresOrder({
            symbol: 'SOLUSDT',
            side: parseFloat(solPosition.positionAmt) > 0 ? 'SELL' : 'BUY',
            type: 'MARKET',
            quantity: Math.abs(parseFloat(solPosition.positionAmt)).toFixed(3),
            reduceOnly: 'true',
          })
        );
      }

      this.position.binancePerpPositionId = undefined;
      this.position.perpSize = 0;
      this.log('Closed Binance perp position');
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.log(
        `Failed to close Binance perp position after retries: ${errorMessage}`
      );
      throw new Error(`Failed to close Binance perp position: ${errorMessage}`);
    }
  }

  private async runMonitor() {
    if (!this.position) return;

    try {
      await this.withLock('monitor', async () => {
        const currentPrice = await this.getCurrentPrice();

        if (
          currentPrice < this.position!.lowerPrice ||
          currentPrice > this.position!.upperPrice
        ) {
          this.log(`Price out of range, rebalancing...`);
          await this.rebalancePosition(
            currentPrice > this.position!.lowerPrice
          );
          return;
        }

        await this.updatePosition();

        const priceChange = Math.abs(
          (currentPrice - this.position!.lastRebalancePrice) /
            this.position!.lastRebalancePrice
        );

        if (priceChange >= this.config.rebalanceDelta / 100) {
          const targetPerpSize = this.position!.solInPool;
          await this.adjustBinancePerpPosition(targetPerpSize);
          this.position!.lastRebalancePrice = currentPrice;
        }
      });
    } catch (error) {
      this.log(`Monitor operation failed: ${error}`);
      await this.handleCriticalError('Monitor operation', error, false);
    }
  }

  private async rebalancePosition(isUpwardMove: boolean) {
    if (this.lockManager.isLocked('rebalance')) {
      this.log('Rebalancing already in progress, skipping...');
      return;
    }

    try {
      await this.withLock('rebalance', async () => {
        const currentPrice = await this.getCurrentPrice();
        const currentPriceDecimal = new Decimal(currentPrice);

        // Calculate new bounds using Decimal
        const newLowerBound = isUpwardMove
          ? currentPriceDecimal
              .mul(
                new Decimal(1).minus(
                  new Decimal(this.config.upperMoveLowerBound).div(100)
                )
              )
              .toNumber()
          : currentPriceDecimal
              .mul(
                new Decimal(1).minus(
                  new Decimal(this.config.lowerMoveLowerBound).div(100)
                )
              )
              .toNumber();

        const newUpperBound = isUpwardMove
          ? currentPriceDecimal
              .mul(
                new Decimal(1).plus(
                  new Decimal(this.config.upperMoveUpperBound).div(100)
                )
              )
              .toNumber()
          : currentPriceDecimal
              .mul(
                new Decimal(1).plus(
                  new Decimal(this.config.lowerMoveUpperBound).div(100)
                )
              )
              .toNumber();

        if (this.position) {
          await this.closePositions();
        }

        const portfolioValue = await this.getPortfolioValue();
        const positionValue = new Decimal(portfolioValue)
          .mul(this.config.portfolioPercentage)
          .div(100)
          .toNumber();

        await this.openPositions(positionValue, newLowerBound, newUpperBound);
      });
    } catch (error) {
      await this.handleCriticalError('Rebalancing position', error, true);
      throw error;
    }
  }

  private async getCurrentPrice(): Promise<number> {
    const { quote } = await swapInstructions(
      this.solanaRpc,
      {
        inputAmount: 1000000000n,
        mint: address(SOL_MINT.toBase58()),
      },
      address(USDC_MINT.toBase58()),
      100,
      this.orcaCompartibleWallet
    );
    return Number(quote.tokenEstOut);
  }

  private async getPortfolioValue(): Promise<number> {
    const usdcBalance = await getTokenBalance(
      this.connection,
      USDC_MINT,
      new PublicKey(this.orcaCompartibleWallet!.address)
    );
    const solBalance = await getSolBalance(
      this.connection,
      new PublicKey(this.orcaCompartibleWallet!.address)
    );
    return (
      (usdcBalance +
        (solBalance / LAMPORTS_PER_SOL) * (await this.getCurrentPrice())) /
      10 ** 6
    );
  }

  private async openPositions(
    sizeInUsdc: number,
    lowerBound: number,
    upperBound: number
  ) {
    try {
      await this.withLock('position', async () => {
        const currentPrice = await this.getCurrentPrice();
        const currentPriceDecimal = new Decimal(currentPrice);
        const lowerBoundDecimal = new Decimal(lowerBound);
        const upperBoundDecimal = new Decimal(upperBound);
        const sizeInUsdcDecimal = new Decimal(sizeInUsdc);

        // Calculate price adjustments using Decimal for precision
        const lowerPriceAdjustment = currentPriceDecimal.mul(
          new Decimal(1).minus(lowerBoundDecimal.div(100))
        );
        const upperPriceAdjustment = currentPriceDecimal.mul(
          new Decimal(1).plus(upperBoundDecimal.div(100))
        );

        const poolAmount = sizeInUsdcDecimal;
        const solPortion = poolAmount.mul(
          lowerPriceAdjustment.div(currentPriceDecimal)
        );
        const usdcPortion = poolAmount.mul(
          upperPriceAdjustment.div(currentPriceDecimal)
        );

        let param = { tokenA: 0n, tokenB: 0n };
        if (this.orcaPool?.tokenMintA === address(USDC_MINT.toBase58())) {
          param.tokenA = BigInt(usdcPortion.toFixed(0));
        } else {
          param.tokenB = BigInt(usdcPortion.toFixed(0));
        }

        const { quote, instructions, positionMint } =
          await openPositionInstructions(
            this.solanaRpc,
            this.orcaPool!.address,
            param,
            lowerPriceAdjustment.toNumber(),
            upperPriceAdjustment.toNumber(),
            0.2,
            this.orcaCompartibleWallet
          );

        const rpc = createSolanaRpc(this.rpcUrl());

        const latestBlockHash = await rpc.getLatestBlockhash().send();

        let transactionMessage = pipe(
          createTransactionMessage({ version: 0 }),
          (tx) =>
            setTransactionMessageFeePayer(
              this.orcaCompartibleWallet!.address,
              tx
            ),
          (tx) =>
            setTransactionMessageLifetimeUsingBlockhash(
              latestBlockHash.value,
              tx
            ),
          (tx) =>
            setTransactionMessageLifetimeUsingBlockhash(
              latestBlockHash.value,
              tx
            ),
          (tx) => appendTransactionMessageInstructions(instructions, tx)
        );

        const usdcNeeded = usdcPortion;
        const usdcBalance = await getTokenBalance(
          this.connection,
          USDC_MINT,
          new PublicKey(this.orcaCompartibleWallet!.address)
        );
        if (usdcBalance < usdcNeeded.toNumber()) {
          const usdcShortage = new Decimal(1.01)
            .mul(usdcNeeded.minus(usdcBalance))
            .div(10 ** 6);
          const amountToSwap =
            LAMPORTS_PER_SOL * usdcShortage.div(currentPriceDecimal).toNumber();

          const { instructions } = await swapInstructions(
            rpc,
            {
              inputAmount: BigInt(amountToSwap),
              mint: address(USDC_MINT.toBase58()),
            },
            this.orcaPool!.address,
            100,
            this.orcaCompartibleWallet
          );

          transactionMessage = pipe(transactionMessage, (tx) =>
            prependTransactionMessageInstructions(instructions, tx)
          );
        }

        const solNeeded =
          this.orcaPool?.tokenMintA === address(USDC_MINT.toBase58())
            ? quote.tokenEstB
            : quote.tokenEstA;

        const solBalance = await getSolBalance(
          this.connection,
          new PublicKey(this.orcaCompartibleWallet!.address)
        );
        if (solBalance < solNeeded) {
          const solShortage = new Decimal(1.01).mul(
            new Decimal(solPortion).minus(solBalance)
          );
          const amountToSwap = LAMPORTS_PER_SOL * solShortage.toNumber();

          const { instructions } = await swapInstructions(
            rpc,
            {
              inputAmount: BigInt(amountToSwap),
              mint: address(SOL_MINT.toBase58()),
            },
            this.orcaPool!.address,
            100,
            this.orcaCompartibleWallet
          );

          transactionMessage = pipe(transactionMessage, (tx) =>
            prependTransactionMessageInstructions(instructions, tx)
          );
        }

        const getComputeUnitEstimateForTransactionMessage =
          getComputeUnitEstimateForTransactionMessageFactory({
            rpc,
          });
        const computeUnitEstimate =
          (await getComputeUnitEstimateForTransactionMessage(
            transactionMessage
          )) + 100_000;
        const medianPrioritizationFee = await rpc
          .getRecentPrioritizationFees()
          .send()
          .then(
            (fees) =>
              fees
                .map((fee) => Number(fee.prioritizationFee))
                .sort((a, b) => a - b)[Math.floor(fees.length / 2)]
          );
        const transactionMessageWithComputeUnitInstructions =
          await prependTransactionMessageInstructions(
            [
              getSetComputeUnitLimitInstruction({ units: computeUnitEstimate }),
              getSetComputeUnitPriceInstruction({
                microLamports: medianPrioritizationFee,
              }),
            ],
            transactionMessage
          );

        const signedTransaction = await signTransactionMessageWithSigners(
          transactionMessageWithComputeUnitInstructions
        );
        const base64EncodedWireTransaction =
          getBase64EncodedWireTransaction(signedTransaction);

        const timeoutMs = 90000;
        const startTime = Date.now();

        while (Date.now() - startTime < timeoutMs) {
          const transactionStartTime = Date.now();

          const signature = await rpc
            .sendTransaction(base64EncodedWireTransaction, {
              maxRetries: 0n,
              skipPreflight: true,
              encoding: 'base64',
            })
            .send();

          const statuses = await rpc.getSignatureStatuses([signature]).send();
          if (statuses.value[0]) {
            if (!statuses.value[0].err) {
              console.log(`Transaction confirmed: ${signature}`);
              break;
            } else {
              console.error(
                `Transaction failed: ${statuses.value[0].err.toString()}`
              );
              break;
            }
          }

          const elapsedTime = Date.now() - transactionStartTime;
          const remainingTime = Math.max(0, 1000 - elapsedTime);
          if (remainingTime > 0) {
            await new Promise((resolve) => setTimeout(resolve, remainingTime));
          }
        }

        // Open Binance perp position
        const binancePositionId = await this.openBinancePerpPosition(
          solPortion.toNumber()
        );

        // Create new position state atomically
        this.position = {
          positionMint,
          binancePerpPositionId: binancePositionId,
          entryPrice: currentPrice,
          currentPrice,
          solInPool: solPortion.toNumber(),
          usdcInPool: usdcPortion.toNumber(),
          solFee: 0,
          usdcFee: 0,
          perpSize: solPortion.toNumber(),
          lastRebalancePrice: currentPrice,
          lowerPrice: lowerPriceAdjustment.toNumber(),
          upperPrice: upperPriceAdjustment.toNumber(),
          status: 'active',
        };

        return positionMint;
      });
    } catch (error) {
      await this.handleCriticalError('Opening positions', error, true);
      throw error;
    }
  }

  private async closePositions() {
    try {
      await this.withLock('position', async () => {
        // Close Orca LP position
        await this.closeOrcaPosition();

        // Close Binance perp position
        await this.closeBinancePerpPosition();

        // Clear position state atomically
        this.position = undefined;
      });
    } catch (error) {
      await this.handleCriticalError('Closing positions', error, true);
      throw error;
    }
  }

  private async closeOrcaPosition() {
    if (!this.position) return;
    const rpc = createSolanaRpc(this.rpcUrl());
    const { instructions } = await closePositionInstructions(
      rpc,
      address(this.position.positionMint!),
      100,
      this.orcaCompartibleWallet
    );

    const latestBlockHash = await rpc.getLatestBlockhash().send();

    let transactionMessage = pipe(
      createTransactionMessage({ version: 0 }),
      (tx) =>
        setTransactionMessageFeePayer(this.orcaCompartibleWallet!.address, tx),
      (tx) =>
        setTransactionMessageLifetimeUsingBlockhash(latestBlockHash.value, tx),
      (tx) =>
        setTransactionMessageLifetimeUsingBlockhash(latestBlockHash.value, tx),
      (tx) => appendTransactionMessageInstructions(instructions, tx)
    );

    const getComputeUnitEstimateForTransactionMessage =
      getComputeUnitEstimateForTransactionMessageFactory({
        rpc,
      });
    const computeUnitEstimate =
      (await getComputeUnitEstimateForTransactionMessage(transactionMessage)) +
      100_000;
    const medianPrioritizationFee = await rpc
      .getRecentPrioritizationFees()
      .send()
      .then(
        (fees) =>
          fees
            .map((fee) => Number(fee.prioritizationFee))
            .sort((a, b) => a - b)[Math.floor(fees.length / 2)]
      );
    const transactionMessageWithComputeUnitInstructions =
      await prependTransactionMessageInstructions(
        [
          getSetComputeUnitLimitInstruction({ units: computeUnitEstimate }),
          getSetComputeUnitPriceInstruction({
            microLamports: medianPrioritizationFee,
          }),
        ],
        transactionMessage
      );

    const signedTransaction = await signTransactionMessageWithSigners(
      transactionMessageWithComputeUnitInstructions
    );
    const base64EncodedWireTransaction =
      getBase64EncodedWireTransaction(signedTransaction);

    const timeoutMs = 90000;
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      const transactionStartTime = Date.now();

      const signature = await rpc
        .sendTransaction(base64EncodedWireTransaction, {
          maxRetries: 0n,
          skipPreflight: true,
          encoding: 'base64',
        })
        .send();

      const statuses = await rpc.getSignatureStatuses([signature]).send();
      if (statuses.value[0]) {
        if (!statuses.value[0].err) {
          this.log(
            `Closed Orca position ${this.position?.positionMint}; tx: ${signature}`
          );
          break;
        } else {
          console.error(
            `Transaction failed: ${statuses.value[0].err.toString()}`
          );
          break;
        }
      }

      const elapsedTime = Date.now() - transactionStartTime;
      const remainingTime = Math.max(0, 1000 - elapsedTime);
      if (remainingTime > 0) {
        await new Promise((resolve) => setTimeout(resolve, remainingTime));
      }
    }
  }

  private async updatePosition() {
    if (!this.position) return;

    try {
      await this.withLock('position', async () => {
        const rpc = createSolanaRpc(this.rpcUrl());
        const { quote, feesQuote } = await closePositionInstructions(
          rpc,
          address(this.position!.positionMint!),
          100,
          this.orcaCompartibleWallet
        );

        const solIsA = quote.tokenMinA.toString() === SOL_MINT.toString();

        // Create a new position state to ensure atomic update
        const updatedPosition: PositionState = {
          ...this.position!,
          solInPool: solIsA ? Number(quote.tokenEstA) : Number(quote.tokenEstB),
          usdcInPool: solIsA
            ? Number(quote.tokenEstB)
            : Number(quote.tokenEstA),
          solFee: solIsA
            ? Number(feesQuote.feeOwedA)
            : Number(feesQuote.feeOwedB),
          usdcFee: solIsA
            ? Number(feesQuote.feeOwedB)
            : Number(feesQuote.feeOwedA),
        };

        // Atomic update of position state
        this.position = updatedPosition;
      });
    } catch (error) {
      this.log(`Position update failed: ${error}`);
      await this.handleCriticalError('Updating position', error, false);
    }
  }

  protected override log(message: string) {
    super.log(`[${this.config.key}] ${message}`);
  }

  async start(): Promise<void> {
    if (this._isRunning) return;

    try {
      await this.initClients();
      const portfolioValue = await this.getPortfolioValue();
      const positionValue =
        (portfolioValue * this.config.portfolioPercentage) / 100;
      await this.openPositions(
        positionValue,
        this.config.lowerBoundPercent,
        this.config.upperBoundPercent
      );

      this._isRunning = true;
      this.priceMonitor = setInterval(() => this.runMonitor(), 1000); // Check every minute
    } catch (error) {
      this.log(`Strategy start failed: ${error}`);
      throw error;
    }
  }

  stop(): void {
    if (this.priceMonitor) {
      clearInterval(this.priceMonitor);
    }
    this._isRunning = false;
  }

  isRunning(): boolean {
    return this._isRunning;
  }

  public async getStatus(): Promise<any> {
    return {
      name: this.config.name,
      status: this.isRunning() ? 'Running' : 'Stopped',
      position: this.position,
      lastUpdate: new Date().toISOString(),
    };
  }

  public async handleCommand(action: string, args: string[]): Promise<string> {
    // Check if the command is from an authorized Telegram chat
    // const telegramChatId = args[args.length - 1]; // Last argument should be the chat ID
    // if (!this.config.telegramChatIds.includes(telegramChatId)) {
    //   return 'Unauthorized access. Please contact the administrator.';
    // }

    switch (action.toLowerCase()) {
      case 'status':
        return JSON.stringify(await this.getStatus(), null, 2);
      case 'rebalance':
        await this.rebalance(args[0] as 'up' | 'down');
        return 'Manual rebalance triggered';
      case 'stop':
        this.stop();
        return 'Strategy stopped';
      case 'start':
        await this.start();
        return 'Strategy started';
      default:
        return `Unknown command: ${action}. Available commands: status, rebalance, stop, start`;
    }
  }

  public getName(): string {
    return this.config.name;
  }

  public getKey(): string {
    return this.config.key;
  }

  private async getPositionValue(): Promise<number> {
    let portfolioValue = await this.getPortfolioValue();
    if (!this.position) return portfolioValue;

    const currentPrice = await this.getCurrentPrice();
    const currentPriceDecimal = new Decimal(currentPrice);

    // Add Orca LP position value using Decimal
    portfolioValue += this.position.usdcInPool;
    portfolioValue += this.position.usdcFee;
    portfolioValue += new Decimal(this.position.solInPool)
      .plus(this.position.solFee)
      .div(LAMPORTS_PER_SOL)
      .mul(currentPriceDecimal)
      .toNumber();

    // Add Binance perp position value and PnL with retries
    try {
      const positions = await this.retryBinanceOperation(() =>
        this.binanceClient.futuresPositionRisk()
      );

      const solPosition = positions.find((p) => p.symbol === 'SOLUSDT');

      if (solPosition) {
        const unrealizedPnL = new Decimal(solPosition.unRealizedProfit);
        portfolioValue += unrealizedPnL.toNumber();
      }
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.log(
        `Failed to get Binance position value after retries: ${errorMessage}`
      );
      // Don't throw here as this is not critical for position value calculation
    }

    return portfolioValue;
  }

  public async getDisplayInfo(): Promise<string[]> {
    const positionValue = await this.getPositionValue();
    return [
      `Type: Delta Neutral LP`,
      `Key: ${this.config.key}`,
      `Position Value: ${positionValue.toFixed(2)}`,
      `Portfolio %: ${this.config.portfolioPercentage}%`,
      `Price Range: ${this.config.lowerBoundPercent}% to +${this.config.upperBoundPercent}%`,
      `Rebalance Delta: ${this.config.rebalanceDelta}%`,
      `Keep Hedge Above Entry: ${this.config.keepHedgeAboveEntry}`,
      `Status: ${this.isRunning() ? 'Running' : 'Stopped'}`,
      `Current Position: ${
        this.position ? JSON.stringify(this.position) : 'None'
      }`,
    ];
  }

  public getWalletPrivateKey(): string {
    return process.env[this.config.privateKeyEnvKey] || '';
  }

  public async rebalance(direction: 'up' | 'down'): Promise<void> {
    if (this.lockManager.isLocked('rebalance')) {
      this.log('Rebalancing already in progress, skipping...');
      return;
    }

    this.log(`Rebalancing ${direction}...`);
    await this.rebalancePosition(direction === 'up');
  }
}
