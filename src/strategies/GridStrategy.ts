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
  entryPrice: bigint;
  amount: bigint;
  timestamp: number;
  profitTarget: bigint;
  stopLoss: bigint;
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

    while (this._isRunning && !this.stopRequested) {
      try {
        await this.execute(router, wallet);
        await new Promise((resolve) =>
          setTimeout(resolve, this.strategy.interval * 1000)
        );
      } catch (error) {
        console.error(`Error in Grid strategy ${this.strategy.name}:`, error);
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
    await this.checkAndUpdatePositions(router, wallet);
    await this.openNewPositionsIfNeeded(router, wallet);
  }

  private async checkAndUpdatePositions(
    router: Contract,
    wallet: Wallet
  ): Promise<void> {
    for (const position of [...this.positions]) {
      const currentPrice = await this.getCurrentPrice(wallet);

      // Check profit targets
      if (currentPrice >= position.profitTarget) {
        await this.closePosition(position, router, wallet);
        this.positions = this.positions.filter((p) => p !== position);
        continue;
      }

      // Check stop loss
      if (currentPrice <= position.stopLoss) {
        await this.closePosition(position, router, wallet);
        this.positions = this.positions.filter((p) => p !== position);
      }
    }
  }

  private async openNewPositionsIfNeeded(
    router: Contract,
    wallet: Wallet
  ): Promise<void> {
    if (this.positions.length >= this.strategy.maxPositions) {
      return;
    }

    const currentPrice = await this.getCurrentPrice(wallet);

    for (const entry of this.strategy.entries) {
      const targetPrice =
        (currentPrice * BigInt(Math.floor((1 - entry.priceChange) * 100))) /
        BigInt(100);

      if (currentPrice <= targetPrice) {
        await this.openPosition(targetPrice, router, wallet);
      }
    }
  }

  private async getCurrentPrice(wallet: Wallet): Promise<bigint> {
    const quoteToken = tokenAddresses[this.strategy.quote_token.toUpperCase()];
    const baseToken = tokenAddresses[this.strategy.base_token.toUpperCase()];
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

  private async openPosition(
    targetPrice: bigint,
    router: Contract,
    wallet: Wallet
  ): Promise<void> {
    const quoteToken = tokenAddresses[this.strategy.quote_token.toUpperCase()];
    const baseToken = tokenAddresses[this.strategy.base_token.toUpperCase()];
    const amount = parseUnits(
      this.strategy.totalSize,
      await getTokenDecimals(quoteToken, wallet)
    );

    await this.executeSwap(router, {
      tokenIn: quoteToken,
      tokenOut: baseToken,
      amountIn: amount,
      amountOutMinimum:
        (amount *
          BigInt(Math.floor((1 - DEFAULT_SLIPPAGE.GRID_ENTRY) * 10000))) /
        BigInt(10000),
      wallet,
    });

    this.positions.push({
      entryPrice: targetPrice,
      amount,
      timestamp: Date.now(),
      profitTarget:
        (targetPrice *
          BigInt(
            Math.floor((1 + this.strategy.profitTaking.targets[0]) * 100)
          )) /
        BigInt(100),
      stopLoss:
        (targetPrice *
          BigInt(Math.floor((1 - this.strategy.stopLoss.target) * 100))) /
        BigInt(100),
    });
  }

  private async closePosition(
    position: GridPosition,
    router: Contract,
    wallet: Wallet
  ): Promise<void> {
    const baseToken = tokenAddresses[this.strategy.base_token.toUpperCase()];
    const quoteToken = tokenAddresses[this.strategy.quote_token.toUpperCase()];

    await this.executeSwap(router, {
      tokenIn: baseToken,
      tokenOut: quoteToken,
      amountIn: position.amount,
      amountOutMinimum:
        (position.amount *
          BigInt(Math.floor((1 - DEFAULT_SLIPPAGE.GRID_PROFIT) * 10000))) /
        BigInt(10000),
      wallet,
    });
  }

  public getName(): string {
    return this.strategy.name;
  }

  public async getStatus(): Promise<any> {
    return {
      name: this.strategy.name,
      status: this.isRunning() ? 'Running' : 'Stopped',
      type: 'grid',
      positions: this.positions.map((pos) => ({
        entryPrice: pos.entryPrice.toString(),
        amount: pos.amount.toString(),
        profitTarget: pos.profitTarget.toString(),
        stopLoss: pos.stopLoss.toString(),
        timestamp: new Date(pos.timestamp).toISOString(),
      })),
      lastUpdate: new Date().toISOString(),
    };
  }

  public getKey(): string {
    return this.strategy.key;
  }

  public getDisplayInfo(): string[] {
    return [
      `Type: Grid Trading`,
      `Size: ${this.strategy.totalSize} ${this.strategy.quote_token}`,
      `Active Positions: ${this.positions.length}/${this.strategy.maxPositions}`,
      `Profit Targets: ${this.strategy.profitTaking.targets.join(', ')}%`,
    ];
  }

  public async handleCommand(action: string, args: string[]): Promise<string> {
    return `Unknown command: ${action}. No custom commands available for Grid strategy`;
  }
}
