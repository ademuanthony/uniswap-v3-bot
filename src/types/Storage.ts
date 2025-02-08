export interface LPPositionData {
  tokenId: number;
  entryPrice: string;
  tickLower: number;
  tickUpper: number;
  liquidity: string;
  token0Balance: string;
  token1Balance: string;
  lastCompounded: number;
  timestamp: number;
}

export interface LPStrategyStorage {
  positions: { [tokenId: number]: LPPositionData };
  lastUpdate: number;
} 