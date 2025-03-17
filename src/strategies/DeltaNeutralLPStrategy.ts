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
import { AnchorProvider, Wallet } from '@project-serum/anchor';
import { DriftClient } from '@drift-labs/sdk';
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
  swapInstructions,
} from '@orca-so/whirlpools';
import { SOL } from '@raydium-io/raydium-sdk';

export interface DeltaNeutralLPConfig extends BaseStrategy {
  type: 'delta_neutral_lp';
  transactionExecutor: string;
  jitoFee: string;
  warpRpcUrl: string;
  // Connection details
  rpcUrl: string;
  privateKeyEnvKey: string;

  usdcMint: string;

  // Pool configuration
  portfolioPercentage: number; // Percentage of portfolio to use (0-100)
  lowerBoundPercent: number; // Lower price bound percentage from current price
  upperBoundPercent: number; // Upper price bound percentage from current price
  rebalanceDelta: number; // Price change percentage that triggers perp rebalance

  // Hedge configuration
  keepHedgeAboveEntry: boolean; // Whether to maintain hedge when price > entry

  // Rebalance configuration for out-of-range scenarios
  lowerMoveLowerBound: number; // New lower bound when price moves down
  lowerMoveUpperBound: number; // New upper bound when price moves down
  upperMoveLowerBound: number; // New lower bound when price moves up
  upperMoveUpperBound: number; // New upper bound when price moves up
}

interface PositionState {
  positionMint?: string;
  perpPositionId?: string;
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
    // console.log(err)
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

export class DeltaNeutralLPExecutor
  extends BaseStrategyExecutor
  implements StrategyExecutor
{
  private config: DeltaNeutralLPConfig;
  private _isRunning: boolean = false;
  private priceMonitor?: NodeJS.Timeout;
  private position?: PositionState;

  private connection: Connection;
  private transactionExecutor: TransactionExecutor;
  private wallet: Wallet;
  private driftClient?: DriftClient;
  private orcaPool?: PoolInfo;
  private readonly JUPITER_API_URL = 'https://quote-api.jup.ag/v6';

  constructor(config: DeltaNeutralLPConfig) {
    super();
    this.config = config;
    this.connection = new Connection(config.rpcUrl, 'confirmed');
    const privateKeyBuffer = Buffer.from(
      process.env[config.privateKeyEnvKey] || '',
      'base64'
    );
    const keypair = Keypair.fromSecretKey(privateKeyBuffer);
    this.wallet = new Wallet(keypair);

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

    this.initClients();
  }

  private async initClients() {
    // Initialize Orca, Drift, and Jupiter clients
    try {
      // Initialize clients here
      this.log('Initializing protocol clients...');
      this.orcaPool = await fetchConcentratedLiquidityPool(
        this.connection,
        SOL_MINT,
        USDC_MINT,
        64
      );
    } catch (error) {
      this.log(`Client initialization failed: ${error}`);
      throw error;
    }
  }

  private async runMonitor() {
    if (!this.position || !this.driftClient) return;

    const currentPrice = await this.getCurrentPrice();
    if (
      currentPrice < this.position.lowerPrice ||
      currentPrice > this.position.upperPrice
    ) {
      this.log(`Price out of range, rebalancing...`);
      await this.closePositions();
      await this.rebalancePosition(currentPrice > this.position.lowerPrice);
      return;
    }

    await this.updatePosition();

    const priceChange = Math.abs(
      (currentPrice - this.position.lastRebalancePrice) /
        this.position.lastRebalancePrice
    );

    if (priceChange >= this.config.rebalanceDelta / 100) {
      // Calculate new perp size based on SOL in pool
      const targetPerpSize = this.position.solInPool;
      const sizeDiff = targetPerpSize - this.position.perpSize;

      if (Math.abs(sizeDiff) > 0.01) {
        try {
          // TODO: Implement perp position adjustment
          this.position.perpSize = targetPerpSize;
          this.position.lastRebalancePrice = currentPrice;
          this.log(`Perp position rebalanced to ${targetPerpSize} SOL`);
        } catch (error) {
          this.log(`Perp rebalance failed: ${error}`);
        }
      }
    }
  }

  private async rebalancePosition(isUpwardMove: boolean) {
    // Implement full position rebalancing when out of range
    const currentPrice = await this.getCurrentPrice();

    // Calculate new bounds based on direction
    const newLowerBound = isUpwardMove
      ? currentPrice * (1 - this.config.upperMoveLowerBound / 100)
      : currentPrice * (1 - this.config.lowerMoveLowerBound / 100);

    const newUpperBound = isUpwardMove
      ? currentPrice * (1 + this.config.upperMoveUpperBound / 100)
      : currentPrice * (1 + this.config.lowerMoveUpperBound / 100);

    // Close existing positions
    await this.closePositions();

    // Calculate new position sizes
    const portfolioValue = await this.getPortfolioValue();
    const positionValue =
      (portfolioValue * this.config.portfolioPercentage) / 100;

    // Open new positions
    await this.openPositions(positionValue, newLowerBound, newUpperBound);
  }

  private async getCurrentPrice(): Promise<number> {
    const { quote } = await swapInstructions(
      this.connection,
      {
        inputAmount: 1000000000n,
        mint: 'So11111111111111111111111111111111111111112',
      },
      this.config.usdcMint,
      100,
      this.wallet
    );
    return Number(quote.tokenEstOut);
  }

  private async getPortfolioValue(): Promise<number> {
    const usdcBalance = await getTokenBalance(
      this.connection,
      USDC_MINT,
      this.wallet.publicKey
    );
    const solBalance = await getSolBalance(
      this.connection,
      this.wallet.publicKey
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
    const currentPrice = await this.getCurrentPrice();
    const price0 = currentPrice * (1 - lowerBound / 100);
    const price1 = currentPrice * (1 + upperBound / 100);

    const collateralAmount = sizeInUsdc * (price0 / currentPrice);

    const poolAmount = sizeInUsdc - collateralAmount;

    const solPortion = poolAmount * (price0 / currentPrice);
    const usdcPortion = poolAmount * (price1 / currentPrice);

    let param = { tokenA: 0n, tokenB: 0n };
    if (this.orcaPool?.tokenMintA.equals(USDC_MINT)) {
      param.tokenA = BigInt(usdcPortion);
    } else {
      param.tokenB = BigInt(usdcPortion);
    }

    const transaction = new Transaction();

    const { quote, instructions, positionMint } =
      await openPositionInstructions(
        this.connection,
        this.orcaPool?.address,
        param,
        price0,
        price1,
        0.2,
        this.wallet
      );

    const usdcNeeded = usdcPortion + collateralAmount;
    const usdcBalance = await getTokenBalance(
      this.connection,
      USDC_MINT,
      this.wallet.publicKey
    );
    if (usdcBalance < usdcNeeded) {
      const usdcShortage = (1.01 * (usdcNeeded - usdcBalance)) / 10 ** 6;
      const amountToSwap = (LAMPORTS_PER_SOL * usdcShortage) / currentPrice;
      const jupiterQuote = await this.getJupiterQuote(
        SOL_MINT.toString(),
        USDC_MINT.toString(),
        amountToSwap
      );
      const swapTx = await this.getJupiterSwap(jupiterQuote);
      transaction.add(swapTx);
    }

    const solNeeded = this.orcaPool?.tokenMintA.equals(USDC_MINT)
      ? quote.tokenEstB
      : quote.tokenEstA;

    const solBalance = await getSolBalance(
      this.connection,
      this.wallet.publicKey
    );
    if (solBalance < solNeeded) {
      const solShortage = 1.01 * (solPortion - solBalance);
      const amountToSwap = LAMPORTS_PER_SOL * solShortage;
      const jupiterQuote = await this.getJupiterQuote(
        USDC_MINT.toString(),
        SOL_MINT.toString(),
        amountToSwap
      );
      const swapTx = await this.getJupiterSwap(jupiterQuote);
      transaction.add(swapTx);
    }

    const tx = new Transaction().add(...instructions);

    const blockhash = await this.connection.getLatestBlockhash();

    const message = new TransactionMessage({
      payerKey: this.wallet.publicKey,
      recentBlockhash: blockhash.blockhash,
      instructions: tx.instructions,
    }).compileToV0Message();

    const versionedTx = new VersionedTransaction(message);
    const result = await this.transactionExecutor.executeAndConfirm(
      versionedTx,
      this.wallet.payer,
      blockhash
    );

    this.log(`Opened position ${positionMint}; tx: ${result.signature}`);

    this.position = {
      positionMint,
      perpPositionId: undefined,
      entryPrice: currentPrice,
      currentPrice,
      solInPool: solPortion,
      usdcInPool: usdcPortion,
      perpSize: solPortion,
      lastRebalancePrice: currentPrice,
      lowerPrice: price0,
      upperTick: price1,
      status: 'active',
    };

    return positionMint;
  }

  private async closePositions() {
    const { instructions } = await closePositionInstructions(
      this.connection,
      this.position?.positionMint,
      100,
      this.wallet
    );

    const tx = new Transaction().add(...instructions);

    const blockhash = await this.connection.getLatestBlockhash();

    const message = new TransactionMessage({
      payerKey: this.wallet.publicKey,
      recentBlockhash: blockhash.blockhash,
      instructions: tx.instructions,
    }).compileToV0Message();

    const versionedTx = new VersionedTransaction(message);
    const result = await this.transactionExecutor.executeAndConfirm(
      versionedTx,
      this.wallet.payer,
      blockhash
    );

    this.log(
      `Closed position ${this.position?.positionMint}; tx: ${result.signature}`
    );

    this.position = undefined;
  }

  private async updatePosition() {
    try {
      if (!this.position) return;

      const { quote, feesQuote } = await closePositionInstructions(
        this.connection,
        this.position?.positionMint,
        100,
        this.wallet
      );

      const solIsA = quote.tokenMinA.toString() === SOL_MINT.toString();

      this.position.solInPool = solIsA
        ? Number(quote.tokenEstA)
        : Number(quote.tokenEstB);
      this.position.usdcInPool = solIsA
        ? Number(quote.tokenEstB)
        : Number(quote.tokenEstA);

      this.position.solFee = solIsA
        ? Number(feesQuote.feeOwedA)
        : Number(feesQuote.feeOwedB);
      this.position.usdcFee = solIsA
        ? Number(feesQuote.feeOwedB)
        : Number(feesQuote.feeOwedA);
    } catch (error) {
      this.log(`Position update failed: ${error}`);
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
    switch (action.toLowerCase()) {
      case 'status':
        return JSON.stringify(await this.getStatus(), null, 2);
      case 'rebalance':
        await this.runMonitor();
        return 'Manual rebalance triggered';
      default:
        return `Unknown command: ${action}. Available commands: status, rebalance`;
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

    portfolioValue += this.position.usdcInPool;
    portfolioValue += this.position.usdcFee;

    portfolioValue +=
      ((this.position.solInPool + this.position.solFee) / LAMPORTS_PER_SOL) *
      (await this.getCurrentPrice());

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

  private async getJupiterQuote(
    inputMint: string,
    outputMint: string,
    amount: number,
    slippageBps: number = 50
  ): Promise<JupiterQuoteResponse> {
    const response = await fetch(
      `${this.JUPITER_API_URL}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippageBps}`
    );

    if (!response.ok) {
      throw new Error(`Jupiter quote failed: ${await response.text()}`);
    }

    return await response.json();
  }

  private async getJupiterSwap(
    quoteResponse: JupiterQuoteResponse
  ): Promise<Transaction> {
    const response = await fetch(`${this.JUPITER_API_URL}/swap`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        quoteResponse,
        userPublicKey: this.wallet.publicKey.toString(),
        wrapAndUnwrapSol: true,
      }),
    });

    if (!response.ok) {
      throw new Error(`Jupiter swap failed: ${await response.text()}`);
    }

    const { swapTransaction } = await response.json();
    const transaction = Transaction.from(
      Buffer.from(swapTransaction, 'base64')
    );

    return transaction;
  }

  public getWalletPrivateKey(): string {
    return process.env[this.config.privateKeyEnvKey] || '';
  }
}
