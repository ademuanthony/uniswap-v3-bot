import { gql, GraphQLClient } from 'graphql-request';
import WebSocket from 'ws';

interface BitqueryResponse {
  ethereum: {
    dexTrades: {
      block: {
        timestamp: {
          time: string;
        };
        height: number;
      };
      exchange: {
        fullName: string;
      };
      token0: {
        symbol: string;
        address: string;
        name: string;
      };
      token1: {
        symbol: string;
        address: string;
        name: string;
      };
      pool: {
        address: string;
      };
      tradeAmount?: number;
      price?: number;
    }[];
  };
}

interface PriceSubscriptionCallback {
  (price: number, tokenAddress: string): void;
}

interface NewPoolCallback {
  (pool: {
    token0: { address: string; symbol: string };
    token1: { address: string; symbol: string };
    poolAddress: string;
    transactionHash: string;
    version: 'v2' | 'v3';
  }): void;
}

interface LiquidityResponse {
  EVM: {
    BalanceUpdates: {
      Currency: {
        Name: string;
        Symbol: string;
      };
      balance: string;
    }[];
  };
}

export class BitqueryClient {
  private client: GraphQLClient;
  private ws: WebSocket;
  private static instance: BitqueryClient;
  private priceCallbacks: Map<string, PriceSubscriptionCallback> = new Map();
  private newPoolCallback?: NewPoolCallback;

  private constructor() {
    this.client = new GraphQLClient('https://graphql.bitquery.io', {
      headers: {
        'Authorization': `Bearer ${process.env.BITQUERY_API_KEY}`,
      },
    });

    this.ws = new WebSocket('wss://streaming.bitquery.io/graphql', {
      headers: {
        'Authorization': `Bearer ${process.env.BITQUERY_API_KEY}`,
      },
    });
    this.ws.on('open', () => this.setupWebSocket());
    this.ws.on('error', (err) => {
      console.error('WebSocket error:', err);
      this.reconnect();
    });
    this.ws.on('close', () => this.reconnect());
  }

  private reconnect() {
    setTimeout(() => {
      this.ws = new WebSocket('wss://streaming.bitquery.io/graphql', {
        headers: {
          'Authorization': `Bearer ${process.env.BITQUERY_API_KEY}`,
        },
      });
      this.ws.on('open', () => this.setupWebSocket());
      this.ws.on('error', (err) => {
        console.error('WebSocket error:', err);
        this.reconnect();
      });
      this.ws.on('close', () => this.reconnect());
    }, 5000);
  }

  private setupWebSocket() {
    this.ws.send(
      JSON.stringify({
        type: 'connection_init',
        payload: {
          headers: {
            'Authorization': `Bearer ${process.env.BITQUERY_API_KEY}`,
          },
        },
      })
    );

    this.ws.on('message', (data: string) => {
      const response = JSON.parse(data);
      if (response.type === 'data') {
        this.handleWebSocketData(response.payload.data);
      }
    });
  }

  private handleWebSocketData(data: any) {
    if (data.ethereum?.dexTrades) {
      const trade = data.ethereum.dexTrades[0];
      if (trade.price && this.priceCallbacks.has(trade.baseCurrency.address)) {
        const callback = this.priceCallbacks.get(trade.baseCurrency.address);
        callback?.(trade.price, trade.baseCurrency.address);
      }
    }

    if (data.EVM?.Events) {
      const event = data.EVM.Events[0];
      const parsed = event.Log.Signature.Parsed;

      if (
        (event.Log.Signature.Name === 'PairCreated' ||
          event.Log.Signature.Name === 'PoolCreated') &&
        this.newPoolCallback
      ) {
        const isV2 = event.Log.SmartContract === process.env.PANCAKE_V2_FACTORY;

        this.newPoolCallback({
          token0: {
            address: parsed.token0 || parsed.tokenA,
            symbol: parsed.token0Symbol || '',
          },
          token1: {
            address: parsed.token1 || parsed.tokenB,
            symbol: parsed.token1Symbol || '',
          },
          poolAddress: parsed.pair || parsed.pool,
          transactionHash: event.Transaction.Hash,
          version: isV2 ? 'v2' : 'v3',
        });
      }
    }
  }

  public subscribeToNewPools(callback: NewPoolCallback) {
    const query = `
      subscription {
        EVM(network: bsc) {
          Events(
            where: {
              Log: {
                SmartContract: {
                  in: [
                    "${process.env.PANCAKE_V2_FACTORY}",
                    "${process.env.PANCAKE_V3_FACTORY}"
                  ]
                },
                Signature: {
                  Name: {
                    in: ["PairCreated", "PoolCreated"]
                  }
                }
              },
              TransactionStatus: {Success: true}
            }
          ) {
            Log {
              Signature {
                Name
                Parsed
              }
              SmartContract
            }
            Transaction {
              Hash
            }
          }
        }
      }
    `;

    this.ws.send(
      JSON.stringify({
        type: 'start',
        id: 'new_pools',
        payload: { query },
      })
    );

    this.newPoolCallback = callback;
  }

  public subscribeToPriceUpdates(
    tokenAddress: string,
    callback: PriceSubscriptionCallback
  ) {
    this.priceCallbacks.set(tokenAddress, callback);
    const query = `
      subscription {
        ethereum(network: bsc) {
          dexTrades(
            baseCurrency: {is: "${tokenAddress}"}
          ) {
            baseCurrency {
              address
            }
            price
          }
        }
      }
    `;

    this.ws.send(
      JSON.stringify({
        type: 'start',
        id: `price_${tokenAddress}`,
        payload: { query },
      })
    );
  }

  public unsubscribeFromPriceUpdates(tokenAddress: string) {
    this.priceCallbacks.delete(tokenAddress);
    this.ws.send(
      JSON.stringify({
        type: 'stop',
        id: `price_${tokenAddress}`,
      })
    );
  }

  async getNewPools(
    fromTimestamp: number,
    network: string = 'bsc'
  ): Promise<any[]> {
    const query = gql`
      query ($network: EthereumNetwork!, $from: ISO8601DateTime) {
        ethereum(network: $network) {
          dexTrades(
            options: { desc: "block.timestamp.time" }
            date: { since: $from }
            firstTrade: true
          ) {
            block {
              timestamp {
                time(format: "%Y-%m-%d %H:%M:%S")
              }
              height
            }
            exchange {
              fullName
            }
            token0: baseCurrency {
              symbol
              address
              name
            }
            token1: quoteCurrency {
              symbol
              address
              name
            }
            pool {
              address
            }
          }
        }
      }
    `;

    const variables = {
      network: network.toUpperCase(),
      from: new Date(fromTimestamp).toISOString(),
    };

    try {
      const data = await this.client.request<BitqueryResponse>(
        query,
        variables
      );
      return data.ethereum.dexTrades;
    } catch (error) {
      console.error('Error fetching new pools:', error);
      return [];
    }
  }

  async getTokenPrice(
    tokenAddress: string,
    baseTokenAddress: string,
    network: string = 'bsc'
  ): Promise<number | null> {
    const query = gql`
      query ($network: EthereumNetwork!, $token: String!, $baseToken: String!) {
        ethereum(network: $network) {
          dexTrades(
            options: { desc: "block.height", limit: 1 }
            baseCurrency: { is: $token }
            quoteCurrency: { is: $baseToken }
          ) {
            block {
              height
              timestamp {
                time(format: "%Y-%m-%d %H:%M:%S")
              }
            }
            tradeAmount(in: USD)
            price
          }
        }
      }
    `;

    const variables = {
      network: network.toUpperCase(),
      token: tokenAddress,
      baseToken: baseTokenAddress,
    };

    try {
      const data = await this.client.request<BitqueryResponse>(
        query,
        variables
      );
      if (data.ethereum.dexTrades.length > 0) {
        return data.ethereum.dexTrades[0].price as number;
      }
      return null;
    } catch (error) {
      console.error('Error fetching token price:', error);
      return null;
    }
  }

  async getTokenLiquidity(
    tokenAddress: string,
    baseTokenAddress: string,
    network: string = 'bsc'
  ): Promise<number | null> {
    const query = gql`
      query ($network: EthereumNetwork!, $token: String!, $baseToken: String!) {
        ethereum(network: $network) {
          dexTrades(
            options: { desc: "block.height", limit: 24 }
            baseCurrency: { is: $token }
            quoteCurrency: { is: $baseToken }
          ) {
            tradeAmount(in: USD)
          }
        }
      }
    `;

    const variables = {
      network: network.toUpperCase(),
      token: tokenAddress,
      baseToken: baseTokenAddress,
    };

    try {
      const data = await this.client.request<BitqueryResponse>(
        query,
        variables
      );
      if (data.ethereum.dexTrades.length > 0) {
        // Calculate average 24h liquidity
        const totalLiquidity = data.ethereum.dexTrades.reduce(
          (sum: number, trade: any) => sum + trade.tradeAmount,
          0
        );
        return totalLiquidity / data.ethereum.dexTrades.length;
      }
      return null;
    } catch (error) {
      console.error('Error fetching token liquidity:', error);
      return null;
    }
  }

  async getPoolLiquidity(
    poolAddress: string,
    token0Address: string,
    token1Address: string,
    network: string = 'bsc'
  ): Promise<{ [key: string]: string }> {
    const query = gql`
      query GetPoolLiquidity(
        $pool: String!
        $tokens: [String!]!
        $network: EVMNetwork!
      ) {
        EVM(dataset: combined, network: $network) {
          BalanceUpdates(
            where: {
              BalanceUpdate: { Address: { is: $pool } }
              Currency: { SmartContract: { in: $tokens } }
            }
            orderBy: { descendingByField: "balance" }
          ) {
            Currency {
              Name
              Symbol
            }
            balance: sum(of: BalanceUpdate_Amount, selectWhere: { gt: "0" })
          }
        }
      }
    `;

    const variables = {
      pool: poolAddress,
      tokens: [token0Address, token1Address],
      network: network.toUpperCase(),
    };

    try {
      const data = await this.client.request<LiquidityResponse>(
        query,
        variables
      );
      return data.EVM.BalanceUpdates.reduce((acc, item) => {
        acc[item.Currency.Symbol] = item.balance;
        return acc;
      }, {} as { [key: string]: string });
    } catch (error) {
      console.error('Error fetching pool liquidity:', error);
      return {};
    }
  }

  public static getInstance(): BitqueryClient {
    if (!BitqueryClient.instance) {
      BitqueryClient.instance = new BitqueryClient();
    }
    return BitqueryClient.instance;
  }
}
