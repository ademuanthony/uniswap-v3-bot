import { Contract, Wallet, parseUnits } from 'ethers';
import { BaseStrategy, StrategyExecutor } from '../types/Strategy';
import { tokenAddresses } from '../tokens';
import { getTokenDecimals, approveToken } from '../utils/tokenUtils';
import { BaseStrategyExecutor } from './BaseStrategyExecutor';

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

  constructor(strategy: GridStrategy) {
    super();
    this.strategy = strategy;
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

      // Use 0.1% slippage for entry
      const amountOutMinimum = expectedAmountOut.mul(999).div(1000);

      await approveToken(quoteToken, router.target.toString(), amountIn, wallet);

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

    // Use different slippage for profit taking vs stop loss
    const slippage = type === 'profit' ? 0.1 : 0.5;
    const amountOutMinimum = expectedAmountOut
      .mul(BigInt(Math.floor((100 - slippage) * 100)))
      .div(10000);

    await approveToken(baseToken, router.target.toString(), position.amount, wallet);

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
