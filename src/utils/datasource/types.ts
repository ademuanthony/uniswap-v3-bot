export interface PoolInfo {
  token0: { address: string; symbol: string };
  token1: { address: string; symbol: string };
  poolAddress: string;
  version: 'v2' | 'v3';
}

export interface PriceInfo {
  tokenAddress: string;
  price: number;
  timestamp: number;
}

export interface DataSourceListener {
  onNewPool: (pool: PoolInfo) => Promise<void>;
  onPriceUpdate: (priceInfo: PriceInfo) => Promise<void>;
}

export interface DataSource {
  setListener(listener: DataSourceListener): void;
  subscribeToNewPools(): void;
  subscribeToPriceUpdates(tokenAddress: string): void;
  unsubscribeFromPriceUpdates(tokenAddress: string): void;
  getNewPools(fromTimestamp: number): Promise<PoolInfo[]>;
  getTokenPrice(
    tokenAddress: string,
    baseToken: string
  ): Promise<number | null>;
  getTokenLiquidity(
    tokenAddress: string,
    baseToken: string
  ): Promise<number | null>;
}
