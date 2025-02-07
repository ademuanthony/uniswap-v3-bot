import { Contract, Wallet, parseUnits } from 'ethers';
import { BaseStrategy, StrategyExecutor } from '../types/Strategy';
import { tokenAddresses } from '../tokens';
import { getTokenDecimals, approveToken } from '../utils/tokenUtils';
import { BaseStrategyExecutor } from './BaseStrategyExecutor';

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

  constructor(strategy: DCAStrategy) {
    super();
    this.strategy = strategy;
  }

  async execute(router: Contract, wallet: Wallet): Promise<void> {
    console.log(
      `\n[${new Date().toISOString()}] Executing DCA strategy: ${
        this.strategy.name
      }! Swapping ${this.strategy.amount} ${this.strategy.quote_token} for ${
        this.strategy.base_token
      }`
    );

    const { tokenIn, tokenOut } = this.getTokenPairs();
    const tokenInDecimals = await getTokenDecimals(tokenIn, wallet);
    const amountIn = parseUnits(this.strategy.amount, tokenInDecimals);

    const { expectedAmountOut } = await this.getQuote(
      tokenIn,
      tokenOut,
      amountIn,
      wallet
    );

    // Calculate minimum output amount based on slippage
    const slippageFactor = 1 - this.strategy.slippage / 100;
    const amountOutMinimum = expectedAmountOut
      .mul(Math.floor(slippageFactor * 10000))
      .div(10000);

    console.log(
      `Expected output: ${expectedAmountOut.toString()}\n` +
        `Minimum output (${
          this.strategy.slippage
        }% slippage): ${amountOutMinimum.toString()}`
    );

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
    let tokenInSymbol: string;
    let tokenOutSymbol: string;

    if (this.strategy.action === 'buy') {
      tokenInSymbol = this.strategy.quote_token.toUpperCase();
      tokenOutSymbol = this.strategy.base_token.toUpperCase();
    } else {
      tokenInSymbol = this.strategy.base_token.toUpperCase();
      tokenOutSymbol = this.strategy.quote_token.toUpperCase();
    }

    const tokenIn = tokenAddresses[tokenInSymbol];
    const tokenOut = tokenAddresses[tokenOutSymbol];

    if (!tokenIn || !tokenOut) {
      throw new Error(
        `Token address not found for: ${tokenInSymbol} or ${tokenOutSymbol}`
      );
    }

    return { tokenIn, tokenOut, tokenInSymbol, tokenOutSymbol };
  }
}
