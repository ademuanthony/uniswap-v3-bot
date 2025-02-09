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

  protected async executeSwap(params: {
    tokenIn: string;
    tokenOut: string;
    amountIn: bigint;
    slippage: number;
    wallet: Wallet;
  }) {
    const ROUTER_ADDRESS = '0xE592427A0AEce92De3Edee1F18E0157C05861564';
    const ROUTER_ABI = [
      'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)',
    ];

    const router = new Contract(ROUTER_ADDRESS, ROUTER_ABI, params.wallet);

    // Check token balance and allowance
    const tokenContract = new Contract(
      params.tokenIn,
      [
        'function balanceOf(address) view returns (uint256)',
        'function allowance(address,address) view returns (uint256)',
      ],
      params.wallet
    );

    const [balance, allowance] = await Promise.all([
      tokenContract.balanceOf(params.wallet.address),
      tokenContract.allowance(params.wallet.address, router.target),
    ]);

    if (balance < params.amountIn) {
      throw new Error(
        `Insufficient balance for swap. Required: ${params.amountIn}, Available: ${balance}`
      );
    }

    // Approve only if needed
    if (allowance < params.amountIn) {
      const approvalTx = await tokenContract.approve(
        router.target,
        params.amountIn
      );
      await approvalTx.wait();
      this.log(`Token approval confirmed in block ${approvalTx.blockNumber}`);
    }

    // Get quote for amountOutMinimum calculation
    const { expectedAmountOut } = await this.getQuote(
      params.tokenIn,
      params.tokenOut,
      params.amountIn,
      params.wallet
    );

    const amountOutMinimum =
      (expectedAmountOut * BigInt(Math.floor((1 - params.slippage) * 10000))) /
      BigInt(10000);

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
      amountOutMinimum: amountOutMinimum,
      sqrtPriceLimitX96,
    };

    const tx = await router.exactInputSingle(swapParams, { gasLimit: 300000 });
    this.log(`Transaction submitted: ${tx.hash}`);
    const receipt = await tx.wait();
    this.log(`Transaction confirmed in block ${receipt.blockNumber}`);
    return receipt;
  }
}
