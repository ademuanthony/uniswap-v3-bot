import { Contract, Wallet, parseUnits } from 'ethers';
import { BaseStrategy, StrategyExecutor } from '../types/Strategy';
import { tokenAddresses } from '../tokens';
import { getTokenDecimals, approveToken } from '../utils/tokenUtils';
import { BaseStrategyExecutor } from './BaseStrategyExecutor';
import { DEFAULT_SLIPPAGE } from '../types/Strategy';

export interface GridStrategy extends BaseStrategy {
  type: 'grid';
  gridSize: string;
  profitTarget: number;
  stopLoss: number;
  maxGrids: number;
  retracementWait: number;
}

export interface GridPosition {
  entryPrice: bigint;
  amount: bigint;
  profitTarget: bigint;
  stopLoss: bigint;
  timestamp: number;
}

export class GridExecutor
  extends BaseStrategyExecutor
  implements StrategyExecutor
{
  private strategy: GridStrategy;
  private positions: GridPosition[] = [];
  private _isRunning: boolean = false;
  private stopRequested: boolean = false;

  constructor(strategy: GridStrategy) {
    super();
    this.strategy = strategy;
  }

  async start(router: Contract, wallet: Wallet): Promise<void> {
    if (this._isRunning) return;

    this._isRunning = true;
    this.stopRequested = false;

    // Continuous market watching loop
    while (this._isRunning && !this.stopRequested) {
      try {
        await this.execute(router, wallet);
        // Small delay to prevent too frequent checks
        await new Promise((resolve) => setTimeout(resolve, 1000));
      } catch (error) {
        console.error(`Error in Grid strategy ${this.strategy.name}:`, error);
        this.stop();
      }
    }
  }

  stop(): void {
    this.stopRequested = true;
    this._isRunning = false;
  }

  isRunning(): boolean {
    return this._isRunning;
  }

  async execute(router: Contract, wallet: Wallet): Promise<void> {
    console.log(
      `\n[${new Date().toISOString()}] Executing grid strategy: ${
        this.strategy.name
      }`
    );

    const currentPrice = await this.getCurrentPrice(wallet);
    await this.checkAndUpdatePositions(currentPrice, router, wallet);
    await this.openNewPositionIfNeeded(currentPrice, router, wallet);
  }

  private async getCurrentPrice(wallet: Wallet): Promise<bigint> {
    const quoteToken = tokenAddresses[this.strategy.quote_token.toUpperCase()];
    const baseToken = tokenAddresses[this.strategy.base_token.toUpperCase()];

    // Get quote for 1 unit of quote token
    const quoteDecimals = await getTokenDecimals(quoteToken, wallet);
    const oneUnit = parseUnits('1', quoteDecimals);

    const { expectedAmountOut } = await this.getQuote(
      quoteToken,
      baseToken,
      oneUnit,
      wallet
    );

    return expectedAmountOut;
  }

  private async checkAndUpdatePositions(
    currentPrice: bigint,
    router: Contract,
    wallet: Wallet
  ): Promise<void> {
    for (const position of [...this.positions]) {
      const priceChange =
        ((currentPrice - position.entryPrice) * BigInt(100)) /
        position.entryPrice;

      if (priceChange >= position.profitTarget) {
        await this.closePosition(position, router, wallet, 'profit');
        this.positions = this.positions.filter((p) => p !== position);
      } else if (priceChange <= -position.stopLoss) {
        await this.closePosition(position, router, wallet, 'loss');
        this.positions = this.positions.filter((p) => p !== position);
      }
    }
  }

  private async openNewPositionIfNeeded(
    currentPrice: bigint,
    router: Contract,
    wallet: Wallet
  ): Promise<void> {
    if (this.positions.length >= this.strategy.maxGrids) {
      return;
    }

    const lastPosition = this.positions[this.positions.length - 1];
    const timeSinceLastEntry = Date.now() - (lastPosition?.timestamp || 0);

    if (
      !lastPosition ||
      timeSinceLastEntry >= this.strategy.retracementWait * 1000
    ) {
      const quoteToken =
        tokenAddresses[this.strategy.quote_token.toUpperCase()];
      const baseToken = tokenAddresses[this.strategy.base_token.toUpperCase()];

      const quoteDecimals = await getTokenDecimals(quoteToken, wallet);
      const amountIn = parseUnits(this.strategy.gridSize, quoteDecimals);

      const { expectedAmountOut } = await this.getQuote(
        quoteToken,
        baseToken,
        amountIn,
        wallet
      );

      const entrySlippage =
        this.strategy.slippage ?? DEFAULT_SLIPPAGE.GRID_ENTRY;
      const amountOutMinimum = expectedAmountOut
        .mul(BigInt(Math.floor((100 - entrySlippage) * 100)))
        .div(10000);

      await approveToken(
        quoteToken,
        router.target.toString(),
        amountIn,
        wallet
      );

      await this.executeSwap(router, {
        tokenIn: quoteToken,
        tokenOut: baseToken,
        amountIn,
        amountOutMinimum,
        wallet,
      });

      this.positions.push({
        entryPrice: currentPrice,
        amount: expectedAmountOut,
        profitTarget: BigInt(this.strategy.profitTarget),
        stopLoss: BigInt(this.strategy.stopLoss),
        timestamp: Date.now(),
      });

      console.log(`New grid position opened at price ${currentPrice}`);
    }
  }

  private async closePosition(
    position: GridPosition,
    router: Contract,
    wallet: Wallet,
    type: 'profit' | 'loss'
  ): Promise<void> {
    const baseToken = tokenAddresses[this.strategy.base_token.toUpperCase()];
    const quoteToken = tokenAddresses[this.strategy.quote_token.toUpperCase()];

    const { expectedAmountOut } = await this.getQuote(
      baseToken,
      quoteToken,
      position.amount,
      wallet
    );

    const slippage =
      type === 'profit'
        ? this.strategy.slippage ?? DEFAULT_SLIPPAGE.GRID_PROFIT
        : this.strategy.slippage ?? DEFAULT_SLIPPAGE.GRID_LOSS;

    const amountOutMinimum = expectedAmountOut
      .mul(BigInt(Math.floor((100 - slippage) * 100)))
      .div(10000);

    await approveToken(
      baseToken,
      router.target.toString(),
      position.amount,
      wallet
    );

    await this.executeSwap(router, {
      tokenIn: baseToken,
      tokenOut: quoteToken,
      amountIn: position.amount,
      amountOutMinimum,
      wallet,
    });

    console.log(
      `Position closed with ${
        type === 'profit' ? 'profit' : 'loss'
      } at price ${expectedAmountOut.toString()}`
    );
  }
}
