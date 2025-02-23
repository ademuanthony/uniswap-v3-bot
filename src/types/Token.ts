export interface Token {
  id: string;
  address: string;
  chainId: number;
  name: string;
  symbol: string;
  decimals: number;
  mintingEnabled: boolean;
  hiddenMintFunctions: boolean;
  hasBuySellTax: boolean;
  canBlacklist: boolean;
  isSafe: boolean;
  hasHoneypotCode: boolean;
  hasBackdoors: boolean;
  buyTaxPercentage: number;
  sellTaxPercentage: number;
  comments: string;
}

export interface TokenTrade {
  id: string;
  tokenId: string;
  timestamp: number;
  fromAddress: string;
  orderType: string;
  price: number;
  amount: number;
  transactionHash: string;
}
