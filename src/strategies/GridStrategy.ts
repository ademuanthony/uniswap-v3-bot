import { Contract, Wallet, parseUnits } from 'ethers';
import { BaseStrategy, StrategyExecutor } from '../types/Strategy';
import { tokenAddresses } from '../tokens';
import { getTokenDecimals, approveToken } from '../utils/tokenUtils';
import { BaseStrategyExecutor } from './BaseStrategyExecutor';
import { DEFAULT_SLIPPAGE } from '../types/Strategy';

export interface GridStrategy extends BaseStrategy {
  type: 'grid';
  totalSize: string; // Total position size in quote token (e.g., "1000" USDC)
  entries: {
    percentage: number; // Percentage of total size to enter with
    priceChange: number; // Price change percentage to trigger entry
  }[];
  profitTaking: {
    targets: number[]; // Percentage profit targets from mean entry
    sizes: number[]; // Percentage of position to close at each target
  };
  stopLoss: {
    target: number; // Percentage from mean entry
    partial: boolean;
    initialSize: number; // Percentage of position
    scaleSize: number; // Percentage for each scale out
    scaleTarget: number; // Additional percentage drop for each scale
  };
  maxPositions: number; // Maximum number of positions
}

interface GridPosition {
  entries: {
    price: bigint;
    amount: bigint;
    timestamp: number;
  }[];
  remainingEntries: {
    percentage: number;
    priceChange: number;
    amount: bigint;
  }[];
  meanEntryPrice: bigint;
  totalAmount: bigint;
  remainingAmount: bigint;
  profitTargets: {
    target: bigint;
    size: bigint;
  }[];
  stopLoss: {
    target: bigint;
    size: bigint;
  }[];
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
      // Check profit targets
      for (const target of position.profitTargets) {
        const priceChange =
          ((currentPrice - position.meanEntryPrice) * BigInt(100)) /
          position.meanEntryPrice;

        if (priceChange >= target.target && target.size > BigInt(0)) {
          await this.executePartialClose(
            position,
            target.size,
            router,
            wallet,
            'profit'
          );
          target.size = BigInt(0); // Mark as taken
        }
      }

      // Check stop loss
      if (this.strategy.stopLoss.partial) {
        const priceChange =
          ((currentPrice - position.meanEntryPrice) * BigInt(100)) /
          position.meanEntryPrice;

        for (const stop of position.stopLoss) {
          if (priceChange <= -stop.target && stop.size > BigInt(0)) {
            await this.executePartialClose(
              position,
              stop.size,
              router,
              wallet,
              'loss'
            );
            stop.size = BigInt(0); // Mark as taken
          }
        }
      } else {
        // Regular stop loss
        const stopLossPrice =
          (position.meanEntryPrice *
            (BigInt(100) - BigInt(this.strategy.stopLoss.target))) /
          BigInt(100);
        if (currentPrice <= stopLossPrice) {
          await this.executePartialClose(
            position,
            position.remainingAmount,
            router,
            wallet,
            'loss'
          );
          this.positions = this.positions.filter((p) => p !== position);
        }
      }
    }
  }

  private async openNewPositionIfNeeded(
    currentPrice: bigint,
    router: Contract,
    wallet: Wallet
  ): Promise<void> {
    // Don't open new positions if we've reached the maximum
    if (this.positions.length >= this.strategy.maxPositions) {
      return;
    }

    // If no positions exist, open initial position
    if (this.positions.length === 0) {
      await this.openInitialPosition(currentPrice, router, wallet);
      return;
    }

    // Check for additional entries on existing positions
    await this.checkAndExecuteEntries(currentPrice, router, wallet);
  }

  private async openInitialPosition(
    currentPrice: bigint,
    router: Contract,
    wallet: Wallet
  ): Promise<void> {
    const quoteToken = tokenAddresses[this.strategy.quote_token.toUpperCase()];
    const quoteDecimals = await getTokenDecimals(quoteToken, wallet);
    const totalSize = parseUnits(this.strategy.totalSize, quoteDecimals);

    // Calculate initial entry amount
    const initialEntry = this.strategy.entries[0];
    const initialAmount =
      (totalSize * BigInt(initialEntry.percentage)) / BigInt(100);

    const { expectedAmountOut } = await this.getQuote(
      quoteToken,
      tokenAddresses[this.strategy.base_token.toUpperCase()],
      initialAmount,
      wallet
    );

    const slippage = this.strategy.slippage ?? DEFAULT_SLIPPAGE.GRID_ENTRY;
    const amountOutMinimum = expectedAmountOut
      .mul(BigInt(Math.floor((100 - slippage) * 100)))
      .div(10000);

    // Setup remaining entries
    const remainingEntries = this.strategy.entries.slice(1).map((entry) => ({
      percentage: entry.percentage,
      priceChange: entry.priceChange,
      amount: (totalSize * BigInt(entry.percentage)) / BigInt(100),
    }));

    // Create new position
    const position: GridPosition = {
      entries: [
        {
          price: currentPrice,
          amount: expectedAmountOut,
          timestamp: Date.now(),
        },
      ],
      remainingEntries,
      meanEntryPrice: currentPrice,
      totalAmount: expectedAmountOut,
      remainingAmount: expectedAmountOut,
      profitTargets: this.strategy.profitTaking.targets.map((target, i) => ({
        target: BigInt(target),
        size:
          (expectedAmountOut * BigInt(this.strategy.profitTaking.sizes[i])) /
          BigInt(100),
      })),
      stopLoss: this.strategy.stopLoss.partial
        ? [
            {
              target: BigInt(this.strategy.stopLoss.target),
              size:
                (expectedAmountOut *
                  BigInt(this.strategy.stopLoss.initialSize)) /
                BigInt(100),
            },
          ]
        : [],
      timestamp: Date.now(),
    };

    await this.executeSwap(router, {
      tokenIn: quoteToken,
      tokenOut: tokenAddresses[this.strategy.base_token.toUpperCase()],
      amountIn: initialAmount,
      amountOutMinimum,
      wallet,
    });

    this.positions.push(position);
    console.log(`Initial entry executed at price ${currentPrice}`);
  }

  private async executePartialClose(
    position: GridPosition,
    amount: bigint,
    router: Contract,
    wallet: Wallet,
    type: 'profit' | 'loss'
  ): Promise<void> {
    const slippage =
      type === 'profit'
        ? this.strategy.slippage ?? DEFAULT_SLIPPAGE.GRID_PROFIT
        : this.strategy.slippage ?? DEFAULT_SLIPPAGE.GRID_LOSS;

    await this.executeSell(amount, slippage, router, wallet);
    position.remainingAmount -= amount;

    // Remove position if fully closed
    if (position.remainingAmount <= BigInt(0)) {
      this.positions = this.positions.filter((p) => p !== position);
    }
  }

  private async executeSell(
    amount: bigint,
    slippage: number,
    router: Contract,
    wallet: Wallet
  ): Promise<void> {
    const baseToken = tokenAddresses[this.strategy.base_token.toUpperCase()];
    const quoteToken = tokenAddresses[this.strategy.quote_token.toUpperCase()];

    const { expectedAmountOut } = await this.getQuote(
      baseToken,
      quoteToken,
      amount,
      wallet
    );

    const amountOutMinimum = expectedAmountOut
      .mul(BigInt(Math.floor((100 - slippage) * 100)))
      .div(10000);

    await approveToken(baseToken, router.target.toString(), amount, wallet);

    await this.executeSwap(router, {
      tokenIn: baseToken,
      tokenOut: quoteToken,
      amountIn: amount,
      amountOutMinimum,
      wallet,
    });
  }

  private calculateMeanEntryPrice(
    entries: { price: bigint; amount: bigint }[]
  ): bigint {
    const totalValue = entries.reduce(
      (sum, entry) => sum + entry.price * entry.amount,
      BigInt(0)
    );
    const totalAmount = entries.reduce(
      (sum, entry) => sum + entry.amount,
      BigInt(0)
    );
    return totalValue / totalAmount;
  }

  private async checkAndExecuteEntries(
    currentPrice: bigint,
    router: Contract,
    wallet: Wallet
  ): Promise<void> {
    for (const position of this.positions) {
      for (const entry of [...position.remainingEntries]) {
        const priceChangeFromFirst =
          ((currentPrice - position.entries[0].price) * BigInt(100)) /
          position.entries[0].price;

        if (priceChangeFromFirst <= -BigInt(entry.priceChange)) {
          // Execute entry
          const { amountOut } = await this.executeBuy(
            entry.amount,
            DEFAULT_SLIPPAGE.GRID_ENTRY,
            router,
            wallet
          );

          // Update position
          position.entries.push({
            price: currentPrice,
            amount: amountOut,
            timestamp: Date.now(),
          });
          position.meanEntryPrice = this.calculateMeanEntryPrice(
            position.entries
          );
          position.totalAmount += amountOut;
          position.remainingAmount += amountOut;

          // Update profit targets and stop loss based on new mean entry
          this.updatePositionTargets(position);

          // Remove executed entry
          position.remainingEntries = position.remainingEntries.filter(
            (e) => e !== entry
          );

          console.log(
            `Additional entry executed at ${priceChangeFromFirst}% from initial entry`
          );
        }
      }
    }
  }

  private updatePositionTargets(position: GridPosition): void {
    // Update profit targets
    position.profitTargets = position.profitTargets.map((target, i) => ({
      target:
        (position.meanEntryPrice *
          BigInt(100 + this.strategy.profitTaking.targets[i])) /
        BigInt(100),
      size:
        (position.remainingAmount *
          BigInt(this.strategy.profitTaking.sizes[i])) /
        BigInt(100),
    }));

    // Update stop loss
    if (this.strategy.stopLoss.partial) {
      position.stopLoss = [
        {
          target:
            (position.meanEntryPrice *
              BigInt(100 - this.strategy.stopLoss.target)) /
            BigInt(100),
          size:
            (position.remainingAmount *
              BigInt(this.strategy.stopLoss.initialSize)) /
            BigInt(100),
        },
      ];
    }
  }

  private async executeBuy(
    amount: bigint,
    slippage: number,
    router: Contract,
    wallet: Wallet
  ): Promise<{ amountOut: bigint }> {
    const quoteToken = tokenAddresses[this.strategy.quote_token.toUpperCase()];
    const baseToken = tokenAddresses[this.strategy.base_token.toUpperCase()];

    const { expectedAmountOut } = await this.getQuote(
      quoteToken,
      baseToken,
      amount,
      wallet
    );

    const amountOutMinimum = expectedAmountOut
      .mul(BigInt(Math.floor((100 - slippage) * 100)))
      .div(10000);

    await approveToken(quoteToken, router.target.toString(), amount, wallet);

    await this.executeSwap(router, {
      tokenIn: quoteToken,
      tokenOut: baseToken,
      amountIn: amount,
      amountOutMinimum,
      wallet,
    });

    return { amountOut: expectedAmountOut };
  }
}
