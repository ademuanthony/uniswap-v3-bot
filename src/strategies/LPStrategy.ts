import { Contract, Wallet, parseUnits } from 'ethers';
import { BaseStrategyExecutor } from './BaseStrategyExecutor';
import { LPPosition, LPStrategy, StrategyExecutor } from '../types/Strategy';
import { Pool, nearestUsableTick, FeeAmount } from '@uniswap/v3-sdk';
import { Token } from '@uniswap/sdk-core';
import { getTokenDecimals } from '../utils/tokenUtils';
import { DEFAULT_SLIPPAGE } from '../types/Strategy';
const POSITION_MANAGER_ADDRESS = '0xC36442b4a4522E871399CD717aBDD847Ab11FE88';
const POSITION_MANAGER_ABI = [
  'function positions(uint256 tokenId) external view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
  'function mint(tuple(address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline)) external payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)',
  'function collect(tuple(uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max)) external payable returns (uint256 amount0, uint256 amount1)',
  'function increaseLiquidity(tuple(uint256 tokenId, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, uint256 deadline)) external payable returns (uint128 liquidity, uint256 amount0, uint256 amount1)',
  'function decreaseLiquidity(tuple(uint256 tokenId, uint128 liquidity, uint256 amount0Min, uint256 amount1Min, uint256 deadline)) external payable returns (uint256 amount0, uint256 amount1)',
];

const FACTORY_ADDRESS = '0x1F98431c8aD98523631AE4a59f267346ea31F984';
const FACTORY_ABI = [
  'function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)',
];

const POOL_ABI = [
  'function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
];

interface CollectedFees {
  amount0: bigint;
  amount1: bigint;
}

interface LPStrategyStatus {
  name: string;
  isRunning: boolean;
  positions: {
    tokenId: number;
    inRange: boolean;
    liquidity: string;
    token0Balance: string;
    token1Balance: string;
    unclaimedFees0: string;
    unclaimedFees1: string;
    lastCompounded: string;
  }[];
  totalValueLocked: string;
  apr: number;
}

export class LPExecutor
  extends BaseStrategyExecutor
  implements StrategyExecutor
{
  private strategy: LPStrategy;
  private positions: Map<number, LPPosition> = new Map();
  private _isRunning: boolean = false;
  private stopRequested: boolean = false;
  private poolCache: Map<string, Pool> = new Map();

  constructor(strategy: LPStrategy) {
    super();
    this.strategy = strategy;
  }

  async start(router: Contract, wallet: Wallet): Promise<void> {
    if (this._isRunning) return;

    this._isRunning = true;
    this.stopRequested = false;

    // Initialize position manager
    const positionManager = new Contract(
      POSITION_MANAGER_ADDRESS,
      POSITION_MANAGER_ABI,
      wallet
    );

    while (this._isRunning && !this.stopRequested) {
      try {
        await this.monitor(positionManager, wallet);

        if (this.strategy.autoCompound.enabled) {
          await this.checkAndCompound(positionManager, wallet);
        }

        await new Promise((resolve) => setTimeout(resolve, 60 * 1000));
      } catch (error) {
        console.error(`Error in LP strategy ${this.strategy.name}:`, error);
      }
    }
  }

  private async monitor(
    positionManager: Contract,
    wallet: Wallet
  ): Promise<void> {
    for (const [tokenId, position] of this.positions) {
      const currentPosition = await this.getPosition(
        tokenId,
        positionManager,
        wallet
      );

      // Check if position is in range
      if (currentPosition.inRange !== position.inRange) {
        if (this.strategy.rebalance.enabled) {
          await this.rebalancePosition(tokenId, positionManager, wallet);
        }
      }

      // Update position data
      this.positions.set(tokenId, currentPosition);
    }
  }

  private async checkAndCompound(
    positionManager: Contract,
    wallet: Wallet
  ): Promise<void> {
    for (const [tokenId, position] of this.positions) {
      const timeSinceLastCompound = Date.now() - position.lastCompounded;

      if (timeSinceLastCompound >= this.strategy.autoCompound.interval * 1000) {
        const fees = await this.collectFees(tokenId, positionManager, wallet);

        if (this.shouldCompound(fees)) {
          await this.reinvestFees(tokenId, fees, positionManager, wallet);
        }
      }
    }
  }

  private async createPosition(
    positionManager: Contract,
    wallet: Wallet
  ): Promise<void> {
    const [token0Decimals, token1Decimals] = await Promise.all([
      getTokenDecimals(this.strategy.token0, wallet),
      getTokenDecimals(this.strategy.token1, wallet),
    ]);

    const pool = await this.getPool(
      this.strategy.token0,
      this.strategy.token1,
      this.strategy.fee,
      wallet
    );

    // Calculate tick range if not provided
    const { tickLower, tickUpper } = this.strategy.initialTickLower
      ? {
          tickLower: this.strategy.initialTickLower,
          tickUpper: this.strategy.initialTickUpper!,
        }
      : await this.calculateOptimalTickRange(pool, pool.tickCurrent, wallet);

    // Get current sqrt price
    const poolContract = new Contract(
      await this.getPoolAddress(
        this.strategy.token0,
        this.strategy.token1,
        this.strategy.fee,
        wallet
      ),
      POOL_ABI,
      wallet
    );
    const { sqrtPriceX96 } = await poolContract.slot0();

    // Calculate optimal amounts based on price range
    const sqrtRatioA = Math.sqrt(1.0001 ** tickLower);
    const sqrtRatioB = Math.sqrt(1.0001 ** tickUpper);
    const currentSqrtPrice = Number(sqrtPriceX96) / 2**96;

    // Total value to invest (in terms of token0)
    const totalValue = parseUnits(this.strategy.amount0Desired, token0Decimals);

    let amount0Desired: bigint;
    let amount1Desired: bigint;

    if (currentSqrtPrice <= sqrtRatioA) {
      // Price is below range - only token0 needed
      amount0Desired = totalValue;
      amount1Desired = BigInt(0);
    } else if (currentSqrtPrice >= sqrtRatioB) {
      // Price is above range - only token1 needed
      amount0Desired = BigInt(0);
      amount1Desired = totalValue * BigInt(Math.floor(currentSqrtPrice ** 2));
    } else {
      // Price is in range - need both tokens
      const token0Portion = (sqrtRatioB - currentSqrtPrice) / (sqrtRatioB - sqrtRatioA);
      const token1Portion = (currentSqrtPrice - sqrtRatioA) / (sqrtRatioB - sqrtRatioA);
      
      amount0Desired = totalValue * BigInt(Math.floor(token0Portion * 1e6)) / BigInt(1e6);
      amount1Desired = totalValue * BigInt(Math.floor(token1Portion * currentSqrtPrice ** 2 * 1e6)) / BigInt(1e6);
    }

    // Get configured slippage or use defaults
    const swapSlippage = this.strategy.slippage?.swap ?? DEFAULT_SLIPPAGE.LP_SWAP;
    const positionSlippage = this.strategy.slippage?.position ?? DEFAULT_SLIPPAGE.LP_POSITION;

    // Check token balances and swap if needed
    const token0Contract = new Contract(
      this.strategy.token0,
      [
        'function balanceOf(address) view returns (uint256)',
        'function approve(address spender, uint256 amount) external returns (bool)',
      ],
      wallet
    );
    const token1Contract = new Contract(
      this.strategy.token1,
      [
        'function balanceOf(address) view returns (uint256)',
        'function approve(address spender, uint256 amount) external returns (bool)',
      ],
      wallet
    );

    const [balance0, balance1] = await Promise.all([
      token0Contract.balanceOf(wallet.address),
      token1Contract.balanceOf(wallet.address)
    ]);

    // Calculate required swaps
    if (balance0 < amount0Desired) {
      const shortfall0 = amount0Desired - balance0;
      // Need to swap token1 for token0 (add configured slippage)
      const token1ToSwap = shortfall0 * BigInt(Math.floor(currentSqrtPrice * (1 + swapSlippage) * 1e6)) / BigInt(1e6);
      if (balance1 >= token1ToSwap) {
        await this.swapExactInputSingle(
          this.strategy.token1,
          this.strategy.token0,
          token1ToSwap,
          wallet,
          swapSlippage
        );
      } else {
        throw new Error('Insufficient token1 balance for required token0 swap');
      }
    }

    if (balance1 < amount1Desired) {
      const shortfall1 = amount1Desired - balance1;
      // Need to swap token0 for token1 (add configured slippage)
      const token0ToSwap = shortfall1 * BigInt(Math.floor(1 / (currentSqrtPrice * (1 + swapSlippage)) * 1e6)) / BigInt(1e6);
      if (balance0 >= token0ToSwap) {
        await this.swapExactInputSingle(
          this.strategy.token0,
          this.strategy.token1,
          token0ToSwap,
          wallet,
          swapSlippage
        );
      } else {
        throw new Error('Insufficient token0 balance for required token1 swap');
      }
    }

    // Verify final balances after swaps
    const [finalBalance0, finalBalance1] = await Promise.all([
      token0Contract.balanceOf(wallet.address),
      token1Contract.balanceOf(wallet.address)
    ]);

    if (finalBalance0 < amount0Desired || finalBalance1 < amount1Desired) {
      throw new Error('Insufficient balance after swaps');
    }

    // Approve with a buffer based on position slippage
    const approvalBuffer = BigInt(Math.floor((1 + positionSlippage) * 100)) / BigInt(100);
    const amount0WithBuffer = amount0Desired * approvalBuffer;
    const amount1WithBuffer = amount1Desired * approvalBuffer;

    await Promise.all([
      token0Contract.approve(POSITION_MANAGER_ADDRESS, amount0WithBuffer),
      token1Contract.approve(POSITION_MANAGER_ADDRESS, amount1WithBuffer)
    ]);

    const params = {
      token0: this.strategy.token0,
      token1: this.strategy.token1,
      fee: this.strategy.fee,
      tickLower,
      tickUpper,
      amount0Desired,
      amount1Desired,
      amount0Min: amount0Desired * BigInt(Math.floor((1 - positionSlippage) * 100)) / BigInt(100),
      amount1Min: amount1Desired * BigInt(Math.floor((1 - positionSlippage) * 100)) / BigInt(100),
      recipient: wallet.address,
      deadline: Math.floor(Date.now() / 1000) + 1800,
    };

    const tx = await positionManager.mint(params);
    const receipt = await tx.wait();

    // Get tokenId from event
    const event = receipt.logs.find(
      (log: { eventName: string }) => log.eventName === 'IncreaseLiquidity'
    );
    const tokenId = event.args.tokenId;

    // Initialize position tracking
    const position = await this.getPosition(tokenId, positionManager, wallet);
    this.positions.set(tokenId, position);
  }

  public async getStatus(): Promise<LPStrategyStatus> {
    const positions = Array.from(this.positions.values());
    const tvl = await this.calculateTotalValueLocked();
    const apr = await this.calculateAPR();

    return {
      name: this.strategy.name,
      isRunning: this._isRunning,
      positions: positions.map((pos) => ({
        tokenId: pos.tokenId,
        inRange: pos.inRange,
        liquidity: pos.liquidity.toString(),
        token0Balance: pos.amount0.toString(),
        token1Balance: pos.amount1.toString(),
        unclaimedFees0: pos.tokensOwed0.toString(),
        unclaimedFees1: pos.tokensOwed1.toString(),
        lastCompounded: new Date(pos.lastCompounded).toISOString(),
      })),
      totalValueLocked: tvl,
      apr,
    };
  }

  private async getPosition(
    tokenId: number,
    positionManager: Contract,
    wallet: Wallet
  ): Promise<LPPosition> {
    const position = await positionManager.positions(tokenId);
    const poolAddress = await this.getPoolAddress(
      position.token0,
      position.token1,
      position.fee,
      wallet
    );

    // Get pool state directly from contract
    const poolContract = new Contract(poolAddress, POOL_ABI, wallet);
    const { tick } = await poolContract.slot0();

    return {
      tokenId,
      liquidity: position.liquidity,
      token0: position.token0,
      token1: position.token1,
      fee: position.fee,
      tickLower: position.tickLower,
      tickUpper: position.tickUpper,
      amount0: position.amount0,
      amount1: position.amount1,
      feeGrowthInside0LastX128: position.feeGrowthInside0LastX128,
      feeGrowthInside1LastX128: position.feeGrowthInside1LastX128,
      tokensOwed0: position.tokensOwed0,
      tokensOwed1: position.tokensOwed1,
      inRange: position.tickLower <= tick && tick <= position.tickUpper,
      lastCompounded: Date.now(),
      timestamp: Date.now(),
    };
  }

  private async collectFees(
    tokenId: number,
    positionManager: Contract,
    wallet: Wallet
  ): Promise<CollectedFees> {
    const position = await this.getPosition(tokenId, positionManager, wallet);

    const params = {
      tokenId,
      recipient: wallet.address,
      amount0Max: position.tokensOwed0,
      amount1Max: position.tokensOwed1,
    };

    const tx = await positionManager.collect(params);
    const receipt = await tx.wait();

    const event = receipt.logs.find(
      (log: {
        eventName: string;
        args: { amount0: bigint; amount1: bigint };
      }) => log.eventName === 'Collect'
    );
    return {
      amount0: event.args.amount0,
      amount1: event.args.amount1,
    };
  }

  private shouldCompound(fees: CollectedFees): boolean {
    const minFees = parseUnits(
      this.strategy.autoCompound.minFeesForCompound,
      18
    );
    return fees.amount0 >= minFees || fees.amount1 >= minFees;
  }

  private async reinvestFees(
    tokenId: number,
    fees: CollectedFees,
    positionManager: Contract,
    wallet: Wallet
  ): Promise<void> {
    const position = await this.getPosition(tokenId, positionManager, wallet);

    const params = {
      tokenId,
      amount0Desired: fees.amount0,
      amount1Desired: fees.amount1,
      amount0Min: 0,
      amount1Min: 0,
      deadline: Math.floor(Date.now() / 1000) + 1800,
    };

    await positionManager.increaseLiquidity(params);

    // Update position data
    const updatedPosition = await this.getPosition(
      tokenId,
      positionManager,
      wallet
    );
    this.positions.set(tokenId, updatedPosition);
  }

  private async rebalancePosition(
    tokenId: number,
    positionManager: Contract,
    wallet: Wallet
  ): Promise<void> {
    const position = await this.getPosition(tokenId, positionManager, wallet);
    const poolAddress = await this.getPoolAddress(
      position.token0,
      position.token1,
      position.fee,
      wallet
    );

    // Get pool state directly from contract
    const poolContract = new Contract(poolAddress, POOL_ABI, wallet);
    const { tick: currentTick } = await poolContract.slot0();

    // Remove liquidity from current position
    await this.removeLiquidity(tokenId, position.liquidity, positionManager);

    // Calculate new tick range centered around current price
    const tickSpacing = this.getTickSpacing(position.fee);
    const newTickLower =
      Math.floor(currentTick / tickSpacing) * tickSpacing - tickSpacing * 10;
    const newTickUpper =
      Math.floor(currentTick / tickSpacing) * tickSpacing + tickSpacing * 10;

    await this.createPosition(positionManager, wallet);
  }

  private async removeLiquidity(
    tokenId: number,
    liquidity: bigint,
    positionManager: Contract
  ): Promise<void> {
    const params = {
      tokenId,
      liquidity,
      amount0Min: 0,
      amount1Min: 0,
      deadline: Math.floor(Date.now() / 1000) + 1800,
    };

    await positionManager.decreaseLiquidity(params);
  }

  private getTickSpacing(fee: number): number {
    switch (fee) {
      case 100:
        return 1;
      case 500:
        return 10;
      case 3000:
        return 60;
      case 10000:
        return 200;
      default:
        throw new Error(`Unsupported fee tier: ${fee}`);
    }
  }

  private async calculateTotalValueLocked(): Promise<string> {
    // Implementation depends on price oracle integration
    return '0'; // Placeholder
  }

  private async calculateAPR(): Promise<number> {
    // Implementation depends on historical fee data
    return 0; // Placeholder
  }

  private async safeExecute<T>(
    operation: () => Promise<T>,
    errorMessage: string
  ): Promise<T | null> {
    try {
      return await operation();
    } catch (error) {
      console.error(`${errorMessage}:`, error);
      return null;
    }
  }

  public async execute(router: Contract, wallet: Wallet): Promise<void> {
    const positionManager = new Contract(
      POSITION_MANAGER_ADDRESS,
      POSITION_MANAGER_ABI,
      wallet
    );

    await this.safeExecute(async () => {
      await this.monitor(positionManager, wallet);
      if (this.strategy.autoCompound.enabled) {
        await this.checkAndCompound(positionManager, wallet);
      }
    }, `Error executing LP strategy ${this.strategy.name}`);
  }

  public stop(): void {
    this.stopRequested = true;
    this._isRunning = false;
  }

  public isRunning(): boolean {
    return this._isRunning;
  }

  private async getPool(
    token0Address: string,
    token1Address: string,
    fee: number,
    wallet: Wallet
  ): Promise<Pool> {
    const cacheKey = `${token0Address}-${token1Address}-${fee}`;
    if (this.poolCache.has(cacheKey)) {
      return this.poolCache.get(cacheKey)!;
    }

    const factory = new Contract(FACTORY_ADDRESS, FACTORY_ABI, wallet);
    const poolAddress = await factory.getPool(
      token0Address,
      token1Address,
      fee
    );

    const [token0Decimals, token1Decimals] = await Promise.all([
      getTokenDecimals(token0Address, wallet),
      getTokenDecimals(token1Address, wallet),
    ]);

    const token0 = new Token(
      this.strategy.chainId,
      token0Address,
      token0Decimals,
      this.strategy.token0Symbol,
      this.strategy.token0Name
    );

    const token1 = new Token(
      this.strategy.chainId,
      token1Address,
      token1Decimals,
      this.strategy.token1Symbol,
      this.strategy.token1Name
    );

    const pool = new Pool(
      token0,
      token1,
      fee as FeeAmount,
      '0', // sqrtPriceX96
      '0', // liquidity
      0 // tick
    );

    this.poolCache.set(cacheKey, pool);
    return pool;
  }

  private async calculateOptimalTickRange(
    pool: Pool,
    _currentTick: number,
    wallet: Wallet
  ): Promise<{ tickLower: number; tickUpper: number }> {
    const tickSpacing = this.getTickSpacing(pool.fee);
    const poolAddress = await this.getPoolAddress(
      pool.token0.address,
      pool.token1.address,
      pool.fee,
      wallet
    );
    const poolContract = new Contract(poolAddress, POOL_ABI, wallet);
    const { tick: currentTick } = await poolContract.slot0();

    // Calculate price range based on strategy configuration
    const rangeFactor = this.strategy.priceRangeWidth || 0.1;
    const tickRange = Math.floor(Math.log(1 + rangeFactor) / Math.log(1.0001));

    const tickLower = nearestUsableTick(currentTick - tickRange, tickSpacing);
    const tickUpper = nearestUsableTick(currentTick + tickRange, tickSpacing);

    return { tickLower, tickUpper };
  }

  private async optimizePosition(
    position: LPPosition,
    pool: Pool,
    wallet: Wallet
  ): Promise<{
    shouldRebalance: boolean;
    newTicks?: { lower: number; upper: number };
  }> {
    const currentTick = pool.tickCurrent;
    const priceDeviation = Math.abs(
      (currentTick - position.tickLower) /
        (position.tickUpper - position.tickLower)
    );

    if (priceDeviation > this.strategy.rebalance.threshold) {
      const { tickLower, tickUpper } = await this.calculateOptimalTickRange(
        pool,
        currentTick,
        wallet
      );
      return {
        shouldRebalance: true,
        newTicks: { lower: tickLower, upper: tickUpper },
      };
    }

    return { shouldRebalance: false };
  }

  private async calculateFeeAPR(
    position: LPPosition,
    pool: Pool
  ): Promise<number> {
    const positionAgeInDays =
      Number(BigInt(Date.now() - position.timestamp)) / (24 * 60 * 60 * 1000);
    const positionAgeInYears = positionAgeInDays / 365;

    const feeValue0 = Number(
      position.tokensOwed0 * (await this.getTokenPrice(position.token0))
    );
    const feeValue1 = Number(
      position.tokensOwed1 * (await this.getTokenPrice(position.token1))
    );

    const totalFeeValue = feeValue0 + feeValue1;
    const positionValue = Number(
      position.amount0 * (await this.getTokenPrice(position.token0)) +
        position.amount1 * (await this.getTokenPrice(position.token1))
    );

    return (totalFeeValue / positionValue / positionAgeInYears) * 100;
  }

  private async shouldCompoundPosition(
    position: LPPosition,
    fees: CollectedFees
  ): Promise<boolean> {
    if (!this.strategy.autoCompound.enabled) return false;

    const timeSinceLastCompound = Date.now() - position.lastCompounded;
    if (timeSinceLastCompound < this.strategy.autoCompound.interval * 1000) {
      return false;
    }

    const minFeeValue = parseUnits(
      this.strategy.autoCompound.minFeesForCompound,
      18
    );

    const feeValue0 =
      fees.amount0 * (await this.getTokenPrice(position.token0));
    const feeValue1 =
      fees.amount1 * (await this.getTokenPrice(position.token1));

    return feeValue0 + feeValue1 >= minFeeValue;
  }

  private async getTokenPrice(tokenAddress: string): Promise<bigint> {
    // Implement price fetching logic here
    // You might want to use an oracle or DEX for this
    const PRICE_FEED_ABI = [
      'function latestAnswer() external view returns (int256)',
      'function decimals() external view returns (uint8)',
    ];

    try {
      // This is a placeholder - implement actual price fetching logic
      return BigInt(1e18); // Return price in wei
    } catch (error) {
      console.error(`Error fetching price for ${tokenAddress}:`, error);
      return BigInt(0);
    }
  }

  private async getPoolAddress(
    token0Address: string,
    token1Address: string,
    fee: number,
    wallet: Wallet
  ): Promise<string> {
    const factory = new Contract(FACTORY_ADDRESS, FACTORY_ABI, wallet);
    return await factory.getPool(token0Address, token1Address, fee);
  }

  // Add new helper function for swapping
  private async swapExactInputSingle(
    tokenIn: string,
    tokenOut: string,
    amountIn: bigint,
    wallet: Wallet,
    slippage: number
  ): Promise<void> {
    const SWAP_ROUTER_ADDRESS = '0xE592427A0AEce92De3Edee1F18E0157C05861564';
    const SWAP_ROUTER_ABI = [
      'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)'
    ];

    const swapRouter = new Contract(SWAP_ROUTER_ADDRESS, SWAP_ROUTER_ABI, wallet);

    // Approve token spending
    const tokenContract = new Contract(
      tokenIn,
      ['function approve(address spender, uint256 amount) external returns (bool)'],
      wallet
    );
    await tokenContract.approve(SWAP_ROUTER_ADDRESS, amountIn);

    const params = {
      tokenIn,
      tokenOut,
      fee: this.strategy.fee,
      recipient: wallet.address,
      deadline: Math.floor(Date.now() / 1000) + 1800,
      amountIn,
      amountOutMinimum: amountIn * BigInt(Math.floor((1 - slippage) * 100)) / BigInt(100), // Calculate minimum based on slippage
      sqrtPriceLimitX96: 0
    };

    const tx = await swapRouter.exactInputSingle(params);
    await tx.wait();
  }
}
