import dotenv from 'dotenv';
import { BaseStrategy, StrategyExecutor } from '../types/Strategy';
import { tokenAddresses } from '../tokens';
import { getTokenBalance, getTokenDecimals } from '../utils/tokenUtils';
import { BaseStrategyExecutor } from './BaseStrategyExecutor';
import { DEFAULT_SLIPPAGE } from '../types/Strategy';
import { Web3Helper } from '../utils/web3';
import { parseEther, parseUnits } from 'ethers/lib/utils';
import { Contract } from 'ethers';

dotenv.config();

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

    this._isRunning = true;
    this.interval = setInterval(async () => {
      try {
        await this.execute();
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

  async execute(): Promise<void> {
    this.log(`Executing DCA strategy ${this.strategy.name}`);
    const wallet = Web3Helper.getWallet(this.getWalletPrivateKey());
    const tokenIn = tokenAddresses[this.strategy.base_token.toUpperCase()];
    const tokenOut = tokenAddresses[this.strategy.quote_token.toUpperCase()];
    const tokenInDecimals = await getTokenDecimals(tokenIn, wallet);
    this.log(`Token in: ${tokenIn}`);
    this.log(`Token out: ${tokenOut}`);
    this.log(`Token in decimals: ${tokenInDecimals}`);
    const amountIn = parseUnits(this.strategy.amount, tokenInDecimals);
    this.log(`Amount in: ${amountIn}`);

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

  public async getDisplayInfo(): Promise<string[]> {
    const wallet = Web3Helper.getWallet(this.getWalletPrivateKey());
    const tokenIn = tokenAddresses[this.strategy.base_token.toUpperCase()];
    const tokenOut = tokenAddresses[this.strategy.quote_token.toUpperCase()];

    const [tokenInDecimals, tokenOutDecimals, tokenInBalance, tokenOutBalance] = await Promise.all([
      getTokenDecimals(tokenIn, wallet),
      getTokenDecimals(tokenOut, wallet),
      getTokenBalance(tokenIn, wallet),
      getTokenBalance(tokenOut, wallet),
    ]);

    return [
      `Type: DCA`,
      `Key: ${this.strategy.key}`,
      `Amount: ${this.strategy.amount} ${this.strategy.base_token}`,
      `${this.strategy.base_token} Balance: ${parseUnits(tokenInBalance.toString(), tokenInDecimals)}`,
      `${this.strategy.quote_token} Balance: ${parseUnits(tokenOutBalance.toString(), tokenOutDecimals)}`,
      `Wallet: ${wallet.address}`,
      `Interval: ${this.strategy.interval}s`,
      `Last Run: ${new Date().toISOString()}`,
    ];
  }

  public async handleCommand(action: string, args: string[]): Promise<string> {
    // Use type assertion to access methods dynamically
    const method = (this as any)[action];
    if (typeof method === 'function') {
      return await method.apply(this, args);
    }
    return `Unknown command: ${action}. No custom commands available for DCA strategy`;
  }

  public async wrapWETH(args: string[]): Promise<string> {
    this.log(`Wrapping WETH`);
    if (args.length !== 1) {
      throw new Error(
        'Invalid number of arguments. Usage: wrapWETH <amountIn> (amount in ether)'
      );
    }
    const wallet = Web3Helper.getWallet(this.getWalletPrivateKey());
    const weth = tokenAddresses['WETH'];
    const wethAbi = [
      'function deposit() external payable',
      'function withdraw(uint256 wad) external',
    ];
    const wethContract = new Contract(weth, wethAbi, wallet);

    const amountIn = parseEther(args[0]);
    this.log(`Depositing ${amountIn} WETH`);
    const tx = await wethContract.deposit({ value: amountIn });
    await tx.wait();
    return `Deposited ${amountIn} WETH`;
  }
}
