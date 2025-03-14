export interface TokenConfig {
  address: string;
  pools: {
    [amount: string]: string;
  };
}

export interface Config {
  TORNADO_PROXY: string;
  TOKEN_ADDRESSES: {
    [currency: string]: TokenConfig;
  };
}

export const config: Config = {
  TORNADO_PROXY: '0x722122dF12D4e14e13Ac3b6895a86e84145b6967',
  TOKEN_ADDRESSES: {
    eth: {
      address: '', // Native ETH doesn't need address
      pools: {
        '0.1': '0x12D66f87A04A9E220743712cE6d9bB1B5616B8Fc',
        '1': '0x47CE0C6eD5B0Ce3d3A51fdb1C52DC66a7c3c2936',
        '10': '0x910Cbd523D972eb0a6f4cAe4618aD62622b39DbF',
        '100': '0xA160cdAB225685dA1d56aa342Ad8841c3b53f291',
      },
    },
    // Add other tokens as needed
  },
};
