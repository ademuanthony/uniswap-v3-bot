import { Contract, Wallet, BigNumber } from 'ethers';
import { parseUnits } from 'ethers/lib/utils';
import { BaseStrategy, StrategyExecutor } from '../types/Strategy';
import { tokenAddresses } from '../tokens';
import { getTokenDecimals } from '../utils/tokenUtils';
import { BaseStrategyExecutor } from './BaseStrategyExecutor';
import { DEFAULT_SLIPPAGE } from '../types/Strategy';
import { Web3Helper } from '../utils/web3';

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
  amount: BigNumber;
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

  async start(): Promise<void> {
    if (this._isRunning) return;

    const wallet = Web3Helper.getWallet(this.getWalletPrivateKey());

    this._isRunning = true;
    this.stopRequested = false;

    while (this._isRunning && !this.stopRequested) {
      try {
        await this.execute(wallet);
        await new Promise((resolve) =>
          setTimeout(resolve, this.strategy.interval * 1000)
        );
      } catch (error) {
        this.log(`Error in Grid strategy ${this.strategy.name}: ${error}`);
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

  async execute(wallet: Wallet): Promise<void> {
    await this.checkAndUpdatePositions(wallet);
    await this.openNewPositionsIfNeeded(wallet);
  }

  private async checkAndUpdatePositions(wallet: Wallet): Promise<void> {
    for (const position of [...this.positions]) {
      const currentPrice = await this.getCurrentPrice(wallet);

      // Check profit targets
      if (currentPrice >= position.profitTarget) {
        await this.closePosition(position, wallet);
        this.positions = this.positions.filter((p) => p !== position);
        continue;
      }

      // Check stop loss
      if (currentPrice <= position.stopLoss) {
        await this.closePosition(position, wallet);
        this.positions = this.positions.filter((p) => p !== position);
      }
    }
  }

  private async openNewPositionsIfNeeded(wallet: Wallet): Promise<void> {
    if (this.positions.length >= this.strategy.maxPositions) {
      return;
    }

    const currentPrice = await this.getCurrentPrice(wallet);
    const quoteToken = tokenAddresses[this.strategy.quote_token.toUpperCase()];

    // Check quote token balance first
    const tokenContract = new Contract(
      quoteToken,
      ['function balanceOf(address) view returns (uint256)'],
      wallet
    );

    const quoteDecimals = await getTokenDecimals(quoteToken, wallet);
    const requiredAmount = parseUnits(this.strategy.totalSize, quoteDecimals);
    const balance = await tokenContract.balanceOf(wallet.address);

    if (balance < requiredAmount) {
      this.log(
        `Insufficient ${this.strategy.quote_token} balance for grid entry. ` +
          `Required: ${this.strategy.totalSize}, Available: ${balance}`
      );
      return;
    }

    // Continue with entry logic if balance is sufficient
    for (const entry of this.strategy.entries) {
      const targetPrice =
        currentPrice -
        (currentPrice * BigInt(Math.floor(entry.priceChange * 100))) /
          BigInt(10000);

      if (this.positions.length < this.strategy.maxPositions) {
        await this.openPosition(targetPrice, wallet);
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
    wallet: Wallet
  ): Promise<void> {
    const quoteToken = tokenAddresses[this.strategy.quote_token.toUpperCase()];
    const baseToken = tokenAddresses[this.strategy.base_token.toUpperCase()];
    const amount = parseUnits(
      this.strategy.totalSize,
      await getTokenDecimals(quoteToken, wallet)
    );

    let slippage = DEFAULT_SLIPPAGE.GRID_ENTRY;
    if (!isNaN(this.strategy.slippage as number)) {
      slippage = this.strategy.slippage as number;
    }

    await this.executeSwap({
      tokenIn: quoteToken,
      tokenOut: baseToken,
      amountIn: amount,
      slippage,
      wallet,
    });

    this.positions.push({
      entryPrice: targetPrice,
      amount,
      timestamp: Date.now(),
      profitTarget: BigNumber.from(targetPrice)
        .mul(100 + Math.floor(this.strategy.profitTaking.targets[0] * 100))
        .div(100)
        .toBigInt(),
      stopLoss: BigNumber.from(targetPrice)
        .mul(100 - Math.floor(this.strategy.stopLoss.target * 100))
        .div(100)
        .toBigInt(),
    });

    this.log(`Opening position at price ${targetPrice}`);
  }

  private async closePosition(
    position: GridPosition,
    wallet: Wallet
  ): Promise<void> {
    const baseToken = tokenAddresses[this.strategy.base_token.toUpperCase()];
    const quoteToken = tokenAddresses[this.strategy.quote_token.toUpperCase()];

    let slippage = DEFAULT_SLIPPAGE.GRID_PROFIT;
    if (!isNaN(this.strategy.slippage as number)) {
      slippage = this.strategy.slippage as number;
    }

    await this.executeSwap({
      tokenIn: baseToken,
      tokenOut: quoteToken,
      amountIn: position.amount,
      slippage: DEFAULT_SLIPPAGE.GRID_PROFIT,
      wallet,
    });

    this.log(`Closing position at price ${position.entryPrice}`);
  }

  public getName(): string {
    return this.strategy.name;
  }

  public getWalletPrivateKey(): string {
    return process.env[this.strategy.privateKeyEnvKey] as string;
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
