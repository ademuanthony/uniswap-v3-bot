export interface TradePosition {
  id: string;
  tokenId: string;
  tokenAddress: string;
  openDate: number;
  openPrice: number;
  closeDate: number | null;
  closePrice: number | null;
  profit: number | null;
}
