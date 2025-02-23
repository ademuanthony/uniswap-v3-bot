import { Contract, ethers } from 'ethers';
import { DataSource, DataSourceListener, PoolInfo } from './types';

const PANCAKE_V2_FACTORY = '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73';
const PANCAKE_V3_FACTORY = '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865';

const FACTORY_V2_ABI = [
  'event PairCreated(address indexed token0, address indexed token1, address pair, uint)',
  'function getPair(address tokenA, address tokenB) external view returns (address pair)',
];

const FACTORY_V3_ABI = [
  'event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, address pool)',
  'function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)',
];

const POOL_ABI = [
  'event Swap(address indexed sender, uint amount0In, uint amount1In, uint amount0Out, uint amount1Out, address indexed to)',
  'function token0() external view returns (address)',
  'function token1() external view returns (address)',
  'function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
  'function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
];

export class Web3DataSource implements DataSource {
  private provider: ethers.providers.Provider;
  private v2Factory: Contract;
  private v3Factory: Contract;
  private pools: Map<string, Contract> = new Map();
  private listener?: DataSourceListener;
  private baseToken: string;

  constructor(provider: ethers.providers.Provider, baseToken: string) {
    this.provider = provider;
    this.baseToken = baseToken;
    this.v2Factory = new Contract(PANCAKE_V2_FACTORY, FACTORY_V2_ABI, provider);
    this.v3Factory = new Contract(PANCAKE_V3_FACTORY, FACTORY_V3_ABI, provider);
  }

  setListener(listener: DataSourceListener): void {
    this.listener = listener;

    // this.subscribeToPriceUpdates('0x55d398326f99059fF775485246999027B3197955');
  }

  async subscribeToNewPools(): Promise<void> {
    this.v2Factory.on('PairCreated', async (token0, token1, pair) => {
      if (!this.listener) return;

      const pool: PoolInfo = {
        token0: { address: token0, symbol: await this.getSymbol(token0) },
        token1: { address: token1, symbol: await this.getSymbol(token1) },
        poolAddress: pair,
        version: 'v2',
      };

      await this.listener.onNewPool(pool);
    });

    this.v3Factory.on('PoolCreated', async (token0, token1, fee, pool) => {
      if (!this.listener) return;

      const poolInfo: PoolInfo = {
        token0: { address: token0, symbol: await this.getSymbol(token0) },
        token1: { address: token1, symbol: await this.getSymbol(token1) },
        poolAddress: pool,
        version: 'v3',
      };

      await this.listener.onNewPool(poolInfo);
    });
  }

  async subscribeToPriceUpdates(tokenAddress: string): Promise<void> {
    console.log('Subscribing to price updates for', tokenAddress);

    // Find pool and store it
    const v2Pool = await this.findV2Pool(tokenAddress, this.baseToken);
    if (v2Pool) {
      this.pools.set(tokenAddress, v2Pool);
    } else {
      const v3Pool = await this.findV3Pool(tokenAddress, this.baseToken);
      if (v3Pool) {
        this.pools.set(tokenAddress, v3Pool);
      } else {
        console.log('No pool found for token:', tokenAddress);
        return;
      }
    }

    const pool = this.pools.get(tokenAddress) as Contract;
    pool.on('Swap', async (...args) => {
      if (!this.listener) return;

      const price = await this.calculatePrice(pool, tokenAddress);
      await this.listener.onPriceUpdate({
        tokenAddress,
        price,
        timestamp: Date.now(),
      });
    });
  }

  async unsubscribeFromPriceUpdates(tokenAddress: string): Promise<void> {
    const pool = this.pools.get(tokenAddress);
    if (pool) {
      pool.removeAllListeners('Swap');
      this.pools.delete(tokenAddress);
    }
  }

  async stop(): Promise<void> {
    this.v2Factory.removeAllListeners();
    this.v3Factory.removeAllListeners();
    for (const pool of this.pools.values()) {
      pool.removeAllListeners();
    }
    this.pools.clear();
  }

  private async getSymbol(tokenAddress: string): Promise<string> {
    const tokenContract = new Contract(
      tokenAddress,
      ['function symbol() view returns (string)'],
      this.provider
    );
    return await tokenContract.symbol();
  }

  private async calculatePrice(
    pool: Contract,
    tokenAddress: string
  ): Promise<number> {
    const isV3 = await this.isV3Pool(pool);
    if (isV3) {
      const { sqrtPriceX96 } = await pool.slot0();
      return parseFloat(ethers.utils.formatUnits(sqrtPriceX96, 18));
    } else {
      const [reserve0, reserve1] = await pool.getReserves();
      const token0 = await pool.token0();
      return tokenAddress.toLowerCase() === token0.toLowerCase()
        ? reserve1 / reserve0
        : reserve0 / reserve1;
    }
  }

  private async isV3Pool(pool: Contract): Promise<boolean> {
    try {
      await pool.slot0();
      return true;
    } catch {
      return false;
    }
  }

  async getNewPools(fromTimestamp: number): Promise<PoolInfo[]> {
    const pools: PoolInfo[] = [];

    // Get V2 pool creation events
    const v2Filter = this.v2Factory.filters.PairCreated();
    const v2Events = await this.v2Factory.queryFilter(v2Filter, fromTimestamp);

    for (const event of v2Events) {
      const { token0, token1, pair } = event.args as any;
      pools.push({
        token0: {
          address: token0,
          symbol: await this.getSymbol(token0),
        },
        token1: {
          address: token1,
          symbol: await this.getSymbol(token1),
        },
        poolAddress: pair,
        version: 'v2',
      });
    }

    // Get V3 pool creation events
    const v3Filter = this.v3Factory.filters.PoolCreated();
    const v3Events = await this.v3Factory.queryFilter(v3Filter, fromTimestamp);

    for (const event of v3Events) {
      const { token0, token1, pool } = event.args as any;
      pools.push({
        token0: {
          address: token0,
          symbol: await this.getSymbol(token0),
        },
        token1: {
          address: token1,
          symbol: await this.getSymbol(token1),
        },
        poolAddress: pool,
        version: 'v3',
      });
    }

    return pools;
  }

  async getTokenPrice(
    tokenAddress: string,
    baseToken: string
  ): Promise<number | null> {
    // Try V2 first
    const v2Pool = await this.findV2Pool(tokenAddress, baseToken);
    if (v2Pool) {
      const [reserve0, reserve1] = await v2Pool.getReserves();
      const token0 = await v2Pool.token0();
      return tokenAddress.toLowerCase() === token0.toLowerCase()
        ? reserve1 / reserve0
        : reserve0 / reserve1;
    }

    // Try V3
    const v3Pool = await this.findV3Pool(tokenAddress, baseToken);
    if (v3Pool) {
      const { sqrtPriceX96 } = await v3Pool.slot0();
      return parseFloat(ethers.utils.formatUnits(sqrtPriceX96, 18));
    }

    return null;
  }

  async getTokenLiquidity(
    tokenAddress: string,
    baseToken: string
  ): Promise<number | null> {
    // Try V2 first
    const v2Pool = await this.findV2Pool(tokenAddress, baseToken);
    if (v2Pool) {
      const [reserve0, reserve1] = await v2Pool.getReserves();
      return Number(ethers.utils.formatEther(reserve0.add(reserve1)));
    }

    // Try V3
    const v3Pool = await this.findV3Pool(tokenAddress, baseToken);
    if (v3Pool) {
      const { liquidity } = await v3Pool.slot0();
      return Number(ethers.utils.formatEther(liquidity));
    }

    return null;
  }

  private async findV2Pool(
    token0: string,
    token1: string
  ): Promise<Contract | null> {
    try {
      if (token0.toLowerCase() > token1.toLowerCase()) {
        [token0, token1] = [token1, token0];
      }
      const pair = await this.v2Factory.getPair(token0, token1);
      if (pair === ethers.constants.AddressZero) return null;
      return new Contract(pair, POOL_ABI, this.provider);
    } catch {
      return null;
    }
  }

  private async findV3Pool(
    token0: string,
    token1: string
  ): Promise<Contract | null> {
    try {
      if (token0.toLowerCase() > token1.toLowerCase()) {
        [token0, token1] = [token1, token0];
      }

      // Try all fee tiers in order of likelihood
      const feeTiers = [2500, 500, 10000, 100];

      for (const fee of feeTiers) {
        const pool = await this.v3Factory.getPool(token0, token1, fee);
        console.log('Found pool', pool, token0, token1, fee);
        if (pool !== ethers.constants.AddressZero) {
          return new Contract(pool, POOL_ABI, this.provider);
        }
      }

      console.log('No pool found for', token0, token1);

      return null;
    } catch (error) {
      console.error('Error finding V3 pool', error);
      return null;
    }
  }
}
