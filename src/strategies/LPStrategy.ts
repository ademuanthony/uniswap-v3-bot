import { Contract, Wallet, BigNumber } from 'ethers';
import { BaseStrategyExecutor } from './BaseStrategyExecutor';
import {
  LPPosition,
  LPStrategy,
  StrategyExecutor,
  DEFAULT_SLIPPAGE,
} from '../types/Strategy';
import { Pool, nearestUsableTick, FeeAmount } from '@uniswap/v3-sdk';
import { Token } from '@uniswap/sdk-core';
import { getTokenDecimals } from '../utils/tokenUtils';
import * as fs from 'fs';
import * as path from 'path';
import { LPStrategyStorage } from '../types/Storage';
import { Web3Helper } from '../utils/web3';
import { formatUnits, parseUnits } from 'ethers/lib/utils';
import dotenv from 'dotenv';

dotenv.config();

const POSITION_MANAGER_ADDRESS = process.env.POSITION_MANAGER_ADDRESS as string;
const POSITION_MANAGER_ABI = [
  'function positions(uint256 tokenId) external view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
  'function mint(tuple(address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline)) external payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)',
  'function collect(tuple(uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max)) external payable returns (uint256 amount0, uint256 amount1)',
  'function increaseLiquidity(tuple(uint256 tokenId, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, uint256 deadline)) external payable returns (uint128 liquidity, uint256 amount0, uint256 amount1)',
  'function decreaseLiquidity(tuple(uint256 tokenId, uint128 liquidity, uint256 amount0Min, uint256 amount1Min, uint256 deadline)) external payable returns (uint256 amount0, uint256 amount1)',
];

const FACTORY_ADDRESS = process.env.FACTORY_ADDRESS as string;
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
  private storageDir = './.data/lp';
  private storageFile: string;

  constructor(strategy: LPStrategy) {
    super();
    this.strategy = strategy;
    this.storageFile = path.join(this.storageDir, `${strategy.key}.json`);
    this.initStorage();
    this.loadPositions();
  }

  private initStorage() {
    if (!fs.existsSync(this.storageDir)) {
      fs.mkdirSync(this.storageDir, { recursive: true });
    }
  }

  private async savePositions() {
    const storage: LPStrategyStorage = {
      positions: {},
      lastUpdate: Date.now(),
    };

    for (const [tokenId, position] of this.positions) {
      storage.positions[tokenId] = {
        tokenId,
        entryPrice: position.entryPrice.toString(),
        tickLower: position.tickLower,
        tickUpper: position.tickUpper,
        liquidity: position.liquidity.toString(),
        token0Balance: position.amount0.toString(),
        token1Balance: position.amount1.toString(),
        lastCompounded: position.lastCompounded,
        timestamp: position.timestamp,
      };
    }

    await fs.promises.writeFile(
      this.storageFile,
      JSON.stringify(storage, null, 2)
    );
  }

  private async loadPositions() {
    try {
      if (!fs.existsSync(this.storageFile)) {
        this.log('No existing positions found. Starting fresh.');
        return;
      }

      const data = await fs.promises.readFile(this.storageFile, 'utf8');
      if (!data || data.trim() === '') {
        this.log('Storage file is empty. Starting fresh.');
        return;
      }

      const storage: LPStrategyStorage = JSON.parse(data);
      if (!storage.positions) {
        this.log('No positions in storage. Starting fresh.');
        return;
      }

      for (const [tokenId, posData] of Object.entries(storage.positions)) {
        this.positions.set(Number(tokenId), {
          tokenId: Number(tokenId),
          entryPrice: BigInt(posData.entryPrice),
          liquidity: BigInt(posData.liquidity),
          amount0: BigInt(posData.token0Balance),
          amount1: BigInt(posData.token1Balance),
          token0: '',
          token1: '',
          fee: 0,
          feeGrowthInside0LastX128: BigInt(0),
          feeGrowthInside1LastX128: BigInt(0),
          tokensOwed0: BigInt(0),
          tokensOwed1: BigInt(0),
          inRange: false,
          tickLower: posData.tickLower,
          tickUpper: posData.tickUpper,
          lastCompounded: posData.lastCompounded,
          timestamp: posData.timestamp,
        });
      }
    } catch (error) {
      this.log(`Error loading LP positions: ${error}`);
      // Initialize with empty positions
      this.positions = new Map();
    }
  }

  async start(): Promise<void> {
    if (this._isRunning) return;

    const wallet = Web3Helper.getWallet(this.getWalletPrivateKey());
    const positionManager = new Contract(
      POSITION_MANAGER_ADDRESS,
      POSITION_MANAGER_ABI,
      wallet
    );

    this._isRunning = true;
    this.stopRequested = false;

    // Create initial position if none exist
    if (this.positions.size === 0) {
      this.log('No positions found. Creating initial position...');
      try {
        await this.createPosition(positionManager, wallet);
        this.log('Initial position created successfully');
      } catch (error) {
        this.log(`Error creating initial position: ${error}`);
        this.stop();
        return;
      }
    }

    while (this._isRunning && !this.stopRequested) {
      try {
        await this.monitor(positionManager, wallet);
        if (this.strategy.autoCompound.enabled) {
          await this.checkAndCompound(positionManager, wallet);
        }
        await new Promise((resolve) => setTimeout(resolve, 60 * 1000));
      } catch (error) {
        this.log(`Error in LP strategy ${this.strategy.name}: ${error}`);
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
      const currentPrice = await this.getCurrentPrice(wallet);

      // Calculate price deviation from entry price
      const priceDeviation = Math.abs(
        ((Number(currentPrice) - Number(position.entryPrice)) /
          Number(position.entryPrice)) *
          100
      );

      if (
        !currentPosition.inRange &&
        priceDeviation > this.strategy.rebalance.threshold
      ) {
        this.log(
          `Position ${tokenId} out of range. Price deviation: ${priceDeviation.toFixed(
            2
          )}%`
        );
        if (this.strategy.rebalance.enabled) {
          await this.rebalancePosition(tokenId, positionManager, wallet);
        }
      }

      // Update position data
      this.positions.set(tokenId, {
        ...currentPosition,
        entryPrice: position.entryPrice, // Preserve entry price
      });

      // Save updated positions to storage
      await this.savePositions();
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
    const token0Decimals = await getTokenDecimals(this.strategy.token0, wallet);
    const token1Decimals = await getTokenDecimals(this.strategy.token1, wallet);
    this.log(`Token0 decimals: ${token0Decimals}`);
    this.log(`Token1 decimals: ${token1Decimals}`);

    const pool = await this.getPool(
      this.strategy.token0,
      this.strategy.token1,
      this.strategy.fee,
      wallet
    );

    // Calculate tick range based on current price and configured bounds
    const { tickLower, tickUpper } = await this.calculateOptimalTickRange(
      pool,
      0,
      wallet
    );

    // Parse amounts with proper decimals
    const amount0Desired = parseUnits(
      this.strategy.amount0Desired,
      token0Decimals
    );
    const amount1Desired = parseUnits(
      this.strategy.amount1Desired,
      token1Decimals
    );

    this.log(`Amount0 desired: ${formatUnits(amount0Desired, token0Decimals)}`);
    this.log(`Amount1 desired: ${formatUnits(amount1Desired, token1Decimals)}`);

    // Get configured slippage or use defaults
    const slippage =
      this.strategy.slippage?.position || DEFAULT_SLIPPAGE.LP_POSITION;

    // Calculate minimum amounts based on slippage
    const amount0Min = amount0Desired
      .mul(1000 - Math.floor(slippage * 1000))
      .div(1000);
    const amount1Min = amount1Desired
      .mul(1000 - Math.floor(slippage * 1000))
      .div(1000);

    // Get configured swap slippage or use defaults
    const swapSlippage =
      this.strategy.slippage?.swap || DEFAULT_SLIPPAGE.LP_SWAP;

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
      token1Contract.balanceOf(wallet.address),
    ]);

    this.log(`Balance0: ${formatUnits(balance0, token0Decimals)}`);
    this.log(`Balance1: ${formatUnits(balance1, token1Decimals)}`);

    const currentSqrtPrice = Number(pool.sqrtRatioX96) / 2 ** 96;

    // Calculate required swaps
    if (balance0.lt(amount0Desired)) {
      const shortfall0 = amount0Desired.sub(balance0);
      this.log(`Shortfall0: ${formatUnits(shortfall0, token0Decimals)}`);

      // Get quote for 1 USDC -> WETH
      const { expectedAmountOut: quote } = await this.getQuote(
        this.strategy.token1,
        this.strategy.token0,
        parseUnits('1', token1Decimals),
        wallet
      );
      this.log(`Quote: ${formatUnits(quote, token0Decimals)}`);

      // Calculate token1 amount needed based on quote
      const token1ToSwap = shortfall0
        .mul(parseUnits('1', token1Decimals))
        .div(quote);
      this.log(`Token1 to swap: ${formatUnits(token1ToSwap, token1Decimals)}`);

      if (balance1.gte(token1ToSwap)) {
        let slippage = DEFAULT_SLIPPAGE.LP_SWAP;
        if (this.strategy.slippage) {
          slippage = (
            this.strategy.slippage as {
              swap: number;
              position: number;
            }
          ).swap;
        }

        await this.executeSwap({
          tokenIn: this.strategy.token1,
          tokenOut: this.strategy.token0,
          amountIn: token1ToSwap,
          slippage,
          wallet,
        });
      } else {
        throw new Error('Insufficient token1 balance for required token0 swap');
      }
    }

    if (balance1.lt(amount1Desired)) {
      const shortfall1 = amount1Desired.sub(balance1);
      this.log(`Shortfall1: ${formatUnits(shortfall1, token1Decimals)}`);

      // Get quote for 1 USDC -> WETH
      const { expectedAmountOut: quote } = await this.getQuote(
        this.strategy.token0,
        this.strategy.token1,
        parseUnits('1', token0Decimals),
        wallet
      );
      this.log(`Quote: ${formatUnits(quote, token1Decimals)}`);

      // Calculate token0 amount needed based on quote
      const token0ToSwap = shortfall1
        .mul(parseUnits('1', token0Decimals))
        .div(quote);
      this.log(`Token0 to swap: ${formatUnits(token0ToSwap, token0Decimals)}`);

      if (balance0.gte(token0ToSwap)) {
        let slippage = DEFAULT_SLIPPAGE.LP_SWAP;
        if (this.strategy.slippage) {
          slippage = (
            this.strategy.slippage as {
              swap: number;
              position: number;
            }
          ).swap;
        }

        await this.executeSwap({
          tokenIn: this.strategy.token0,
          tokenOut: this.strategy.token1,
          amountIn: token0ToSwap,
          slippage,
          wallet,
        });
      } else {
        throw new Error('Insufficient token0 balance for required token1 swap');
      }
    }

    // Verify final balances after swaps
    const [finalBalance0, finalBalance1] = await Promise.all([
      token0Contract.balanceOf(wallet.address),
      token1Contract.balanceOf(wallet.address),
    ]);

    this.log(`Final balance0: ${formatUnits(finalBalance0, token0Decimals)}`);
    this.log(`Final balance1: ${formatUnits(finalBalance1, token1Decimals)}`);

    if (finalBalance0.lt(amount0Desired) || finalBalance1.lt(amount1Desired)) {
      throw new Error('Insufficient balance after swaps');
    }

    // Approve with a buffer based on position slippage
    const approvalBuffer = BigNumber.from(Math.floor((1 + slippage) * 100)).div(
      BigNumber.from(100)
    );
    const amount0WithBuffer = amount0Desired.mul(approvalBuffer);
    const amount1WithBuffer = amount1Desired.mul(approvalBuffer);

    await Promise.all([
      token0Contract.approve(POSITION_MANAGER_ADDRESS, amount0WithBuffer),
      token1Contract.approve(POSITION_MANAGER_ADDRESS, amount1WithBuffer),
    ]);

    const params = {
      token0: this.strategy.token0,
      token1: this.strategy.token1,
      fee: this.strategy.fee,
      tickLower,
      tickUpper,
      amount0Desired,
      amount1Desired,
      amount0Min,
      amount1Min,
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

    // Store entry price with new position
    const currentPrice = await this.getCurrentPrice(wallet);
    position.entryPrice = currentPrice;
    this.positions.set(tokenId, position);
    await this.savePositions();
  }

  public async getStatus(): Promise<LPStrategyStatus> {
    const positions = Array.from(this.positions.values()).map((pos) => ({
      tokenId: pos.tokenId,
      inRange: pos.inRange,
      liquidity: pos.liquidity.toString(),
      token0Balance: pos.amount0.toString(),
      token1Balance: pos.amount1.toString(),
      unclaimedFees0: pos.tokensOwed0.toString(),
      unclaimedFees1: pos.tokensOwed1.toString(),
      lastCompounded: new Date(pos.lastCompounded).toISOString(),
    }));

    return {
      name: this.strategy.name,
      isRunning: this._isRunning,
      positions,
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
    const { tick, sqrtPriceX96 } = await poolContract.slot0();

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
      entryPrice: BigInt(sqrtPriceX96),
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
    // Convert bigint to BigNumber for comparison
    return BigNumber.from(fees.amount0).gte(minFees);
  }

  private async reinvestFees(
    tokenId: number,
    fees: CollectedFees,
    positionManager: Contract,
    wallet: Wallet
  ): Promise<void> {
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
    this.log(
      `Rebalancing position ${tokenId} with liquidity ${position.liquidity}`
    );

    // Remove liquidity from current position
    await this.removeLiquidity(tokenId, position.liquidity, positionManager);
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

  public async stop(): Promise<void> {
    this.stopRequested = true;
    this._isRunning = false;
    await this.savePositions();
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

    const poolAddress = await this.getPoolAddress(
      token0Address,
      token1Address,
      fee,
      wallet
    );

    const poolContract = new Contract(poolAddress, POOL_ABI, wallet);

    const [sqrtPriceX96, tick, liquidity] = await poolContract.slot0();

    const pool = new Pool(
      token0,
      token1,
      fee as FeeAmount,
      sqrtPriceX96,
      liquidity,
      tick
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

    // Calculate price range based on user-configured percentages
    const lowerBoundPercent = this.strategy.priceRange.lowerBoundPercent;
    const upperBoundPercent = this.strategy.priceRange.upperBoundPercent;

    // Convert percentage to tick range
    // For x% price change, we need to calculate log(1 + x/100) / log(1.0001)
    const lowerTickDelta = Math.floor(
      Math.log(1 + lowerBoundPercent / 100) / Math.log(1.0001)
    );
    const upperTickDelta = Math.floor(
      Math.log(1 + upperBoundPercent / 100) / Math.log(1.0001)
    );

    // Find nearest valid ticks
    const tickLower = nearestUsableTick(
      currentTick + lowerTickDelta,
      tickSpacing
    );
    const tickUpper = nearestUsableTick(
      currentTick + upperTickDelta,
      tickSpacing
    );

    this.log(
      `Setting position range: ${lowerBoundPercent}% to ${upperBoundPercent}% from current price`
    );
    this.log(`Current tick: ${currentTick}`);
    this.log(`Lower tick: ${tickLower} (${lowerTickDelta} ticks from current)`);
    this.log(`Upper tick: ${tickUpper} (${upperTickDelta} ticks from current)`);

    return { tickLower, tickUpper };
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

  public getName(): string {
    return this.strategy.name;
  }

  public getWalletPrivateKey(): string {
    return process.env[this.strategy.privateKeyEnvKey] as string;
  }

  public getKey(): string {
    return this.strategy.key;
  }

  public async getDisplayInfo(): Promise<string[]> {
    return [
      `Type: Liquidity Pool`,
      `Key: ${this.strategy.key}`,
      `Pool: ${this.strategy.token0Symbol}-${this.strategy.token1Symbol}`,
      `Range: ${this.strategy.priceRange.lowerBoundPercent}% to +${this.strategy.priceRange.upperBoundPercent}%`,
      `Active Positions: ${this.positions.size}`,
      `Auto-compound: ${this.strategy.autoCompound.enabled ? 'Yes' : 'No'}`,
    ];
  }

  public async handleCommand(action: string, args: string[]): Promise<string> {
    switch (action.toLowerCase()) {
      case 'rebalance':
        // Trigger manual rebalance
        return 'Rebalancing position...';

      case 'compound':
        // Trigger manual compound
        return 'Compounding fees...';

      default:
        return `Unknown command: ${action}. Available commands: rebalance, compound`;
    }
  }

  private async getCurrentPrice(wallet: Wallet): Promise<bigint> {
    const poolAddress = await this.getPoolAddress(
      this.strategy.token0,
      this.strategy.token1,
      this.strategy.fee,
      wallet
    );
    const poolContract = new Contract(poolAddress, POOL_ABI, wallet);
    const { sqrtPriceX96 } = await poolContract.slot0();
    return BigInt(sqrtPriceX96);
  }
}
