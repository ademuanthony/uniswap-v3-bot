import { Contract, Wallet } from 'ethers';

export abstract class BaseStrategyExecutor {
  protected async getQuote(
    tokenIn: string,
    tokenOut: string,
    amountIn: bigint,
    wallet: Wallet
  ) {
    const quoterAddress = '0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6';
    const quoterAbi = [
      'function quoteExactInputSingle(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint160 sqrtPriceLimitX96) external returns (uint256 amountOut)',
    ];

    const quoter = new Contract(quoterAddress, quoterAbi, wallet);
    const expectedAmountOut = await quoter.quoteExactInputSingle(
      tokenIn,
      tokenOut,
      3000, // fee tier
      amountIn,
      0 // no price limit
    );

    return { expectedAmountOut };
  }

  protected async executeSwap(
    router: Contract,
    params: {
      tokenIn: string;
      tokenOut: string;
      amountIn: bigint;
      amountOutMinimum: bigint;
      wallet: Wallet;
    }
  ) {
    const deadline = Math.floor(Date.now() / 1000) + 60 * 20; // 20 minutes
    const fee = 3000; // 0.3%
    const sqrtPriceLimitX96 = 0; // no price limit

    const swapParams = {
      tokenIn: params.tokenIn,
      tokenOut: params.tokenOut,
      fee,
      recipient: params.wallet.address,
      deadline,
      amountIn: params.amountIn,
      amountOutMinimum: params.amountOutMinimum,
      sqrtPriceLimitX96,
    };

    const tx = await router.exactInputSingle(swapParams, { gasLimit: 300000 });
    console.log(`Transaction submitted: ${tx.hash}`);
    const receipt = await tx.wait();
    console.log(`Transaction confirmed in block ${receipt.blockNumber}`);
    return receipt;
  }
} 