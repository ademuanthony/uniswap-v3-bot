import { Wallet, parseUnits } from 'ethers';
import { BaseStrategy, StrategyExecutor } from '../types/Strategy';
import { tokenAddresses } from '../tokens';
import { getTokenDecimals } from '../utils/tokenUtils';
import { BaseStrategyExecutor } from './BaseStrategyExecutor';
import { DEFAULT_SLIPPAGE } from '../types/Strategy';
import { Web3Helper } from '../utils/web3';

export interface DCAStrategy extends BaseStrategy {
  type: 'dca';
  amount: string; // Amount of token_in to swap
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

  async start(): Promise<void> {
    if (this._isRunning) return;

    const wallet = Web3Helper.getWallet(this.getWalletPrivateKey());

    this._isRunning = true;
    this.interval = setInterval(async () => {
      try {
        await this.execute(wallet);
      } catch (error) {
        this.log(`Error in DCA strategy ${this.strategy.name}: ${error}`);
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

  async execute(wallet: Wallet): Promise<void> {
    const tokenIn = tokenAddresses[this.strategy.base_token.toUpperCase()];
    const tokenOut = tokenAddresses[this.strategy.quote_token.toUpperCase()];
    const tokenInDecimals = await getTokenDecimals(tokenIn, wallet);
    const amountIn = parseUnits(this.strategy.amount, tokenInDecimals);

    const slippage = this.strategy.slippage ?? DEFAULT_SLIPPAGE.DCA;
    await this.executeSwap({
      tokenIn,
      tokenOut,
      amountIn,
      slippage,
      wallet,
    });
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
      type: 'dca',
      amount: this.strategy.amount,
      lastUpdate: new Date().toISOString(),
    };
  }

  public getKey(): string {
    return this.strategy.key;
  }

  public getDisplayInfo(): string[] {
    return [
      `Type: DCA`,
      `Amount: ${this.strategy.amount} ${this.strategy.base_token}`,
      `Interval: ${this.strategy.interval}s`,
      `Last Run: ${new Date().toISOString()}`,
    ];
  }

  public async handleCommand(action: string, args: string[]): Promise<string> {
    return `Unknown command: ${action}. No custom commands available for DCA strategy`;
  }
}
