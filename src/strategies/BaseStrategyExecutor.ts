import { Contract, Wallet } from 'ethers';
import { Logger } from '../utils/logger';

export abstract class BaseStrategyExecutor {
  setLogger(logger: { log: (message: string) => void }) {
    Logger.setLogger(logger);
  }

  protected log(message: string) {
    Logger.log(message);
  }

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
    // Check token balance first
    const tokenContract = new Contract(
      params.tokenIn,
      ['function balanceOf(address) view returns (uint256)'],
      params.wallet
    );

    const balance = await tokenContract.balanceOf(params.wallet.address);
    if (balance < params.amountIn) {
      throw new Error(
        `Insufficient balance for swap. Required: ${params.amountIn}, Available: ${balance}`
      );
    }

    // Approve token spending
    const approvalTx = await tokenContract.approve(
      router.target,
      params.amountIn
    );
    await approvalTx.wait();
    this.log(`Token approval confirmed in block ${approvalTx.blockNumber}`);

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
    this.log(`Transaction submitted: ${tx.hash}`);
    const receipt = await tx.wait();
    this.log(`Transaction confirmed in block ${receipt.blockNumber}`);
    return receipt;
  }
}
