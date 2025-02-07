import { Contract, Wallet, parseUnits } from 'ethers';
import { BaseStrategy, StrategyExecutor } from '../types/Strategy';
import { tokenAddresses } from '../tokens';
import { getTokenDecimals, approveToken } from '../utils/tokenUtils';
import { BaseStrategyExecutor } from './BaseStrategyExecutor';
import { DEFAULT_SLIPPAGE } from '../types/Strategy';

export interface DCAStrategy extends BaseStrategy {
  type: 'dca';
  action: 'buy' | 'sell';
  amount: string;
  slippage: number;
}

export class DCAExecutor
  extends BaseStrategyExecutor
  implements StrategyExecutor
{
  private strategy: DCAStrategy;
  private _isRunning: boolean = false;
  private interval?: NodeJS.Timeout;

  constructor(strategy: DCAStrategy) {
    super();
    this.strategy = strategy;
  }

  async start(router: Contract, wallet: Wallet): Promise<void> {
    if (this._isRunning) return;

    this._isRunning = true;
    this.interval = setInterval(async () => {
      try {
        await this.execute(router, wallet);
      } catch (error) {
        console.error(`Error in DCA strategy ${this.strategy.name}:`, error);
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

  async execute(router: Contract, wallet: Wallet): Promise<void> {
    const { tokenIn, tokenOut } = this.getTokenPairs();
    const tokenInDecimals = await getTokenDecimals(tokenIn, wallet);
    const amountIn = parseUnits(this.strategy.amount, tokenInDecimals);

    const { expectedAmountOut } = await this.getQuote(
      tokenIn,
      tokenOut,
      amountIn,
      wallet
    );

    const slippage = this.strategy.slippage ?? DEFAULT_SLIPPAGE.DCA;
    const amountOutMinimum =
      (expectedAmountOut * BigInt(Math.floor((1 - slippage) * 10000))) /
      BigInt(10000);

    await approveToken(tokenIn, router.target.toString(), amountIn, wallet);

    await this.executeSwap(router, {
      tokenIn,
      tokenOut,
      amountIn,
      amountOutMinimum,
      wallet,
    });
  }

  private getTokenPairs() {
    const [tokenInSymbol, tokenOutSymbol] =
      this.strategy.action === 'buy'
        ? [
            this.strategy.quote_token.toUpperCase(),
            this.strategy.base_token.toUpperCase(),
          ]
        : [
            this.strategy.base_token.toUpperCase(),
            this.strategy.quote_token.toUpperCase(),
          ];

    const tokenIn = tokenAddresses[tokenInSymbol];
    const tokenOut = tokenAddresses[tokenOutSymbol];

    if (!tokenIn || !tokenOut) {
      throw new Error(
        `Token address not found for: ${tokenInSymbol} or ${tokenOutSymbol}`
      );
    }

    return { tokenIn, tokenOut, tokenInSymbol, tokenOutSymbol };
  }

  public getName(): string {
    return this.strategy.name;
  }

  public async getStatus(): Promise<any> {
    return {
      name: this.strategy.name,
      status: this.isRunning() ? 'Running' : 'Stopped',
      type: 'dca',
      action: this.strategy.action,
      amount: this.strategy.amount,
      lastUpdate: new Date().toISOString(),
    };
  }

  public getKey(): string {
    return this.strategy.key;
  }

  public getDisplayInfo(): string[] {
    return [
      `Type: DCA ${this.strategy.action.toUpperCase()}`,
      `Amount: ${this.strategy.amount} ${this.strategy.quote_token}`,
      `Interval: ${this.strategy.interval}s`,
      `Last Run: ${new Date().toISOString()}`,
    ];
  }
}
