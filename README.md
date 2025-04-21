# Uniswap V3 Trading Bot

A flexible trading bot supporting multiple strategies for Uniswap V3, including DCA (Dollar Cost Averaging), Grid Trading, and Liquidity Provision.

## Features

- Multiple trading strategies:
  - DCA (Dollar Cost Averaging)
  - Grid Trading
  - Liquidity Provision (LP)
- Interactive CLI interface
- Real-time status monitoring
- Strategy-specific commands
- Configurable parameters
- Slippage protection

## Prerequisites

- Node.js (v16 or higher)
- Yarn or npm
- An Ethereum RPC provider (e.g., Infura, Alchemy)
- Some ETH for gas fees
- Trading tokens (USDC, WETH, etc.)

## Installation

1. Clone the repository:

```bash
git clone https://github.com/ademuanthony/uniswap-v3-bot.git
cd uniswap-v3-bot
```

2. Install dependencies:

```bash
yarn install
# or
npm install
```

3. Create a .env file or store the private keys in the environment variables:
```env
ETH_RPC="YOUR_ETHEREUM_RPC_URL"
ROUTER_ADDRESS="0xE592427A0AEce92De3Edee1F18E0157C05861564"
STRATEGY_1_KEY="YOUR_PRIVATE_KEY"
STRATEGY_2_KEY="ANOTHER_PRIVATE_KEY"
```

4. Create a config.json file (see Configuration section below)

5. Start the bot:
```bash
yarn start
# or
npm start
```

## Configuration Examples

### 1. DCA (Dollar Cost Averaging) Strategy
```json
{
  "strategies": [
    {
      "name": "USDC-ETH DCA",
      "key": "dca_usdc_eth",
      "type": "dca",
      "privateKeyEnvKey": "STRATEGY_1_KEY",
      "base_token": "USDC",
      "quote_token": "ETH",
      "network": "ethereum",
      "interval": 3600,
      "amount": "100",
      "tokenInDecimals": 6,
      "slippage": 0.5
    }
  ]
}
```
This strategy will:
- Buy ETH with USDC
- Spend 100 USDC per trade
- Execute every hour (3600 seconds)
- Allow 0.5% slippage

### 2. Grid Trading Strategy
```json
{
  "strategies": [
    {
      "name": "ETH-USDC Grid",
      "key": "grid_eth_usdc",
      "type": "grid",
      "privateKeyEnvKey": "STRATEGY_1_KEY",
      "base_token": "ETH",
      "quote_token": "USDC",
      "interval": 60,
      "totalSize": "1000",
      "entries": [
        { "percentage": 20, "priceChange": 2 },
        { "percentage": 30, "priceChange": 5 },
        { "percentage": 50, "priceChange": 10 }
      ],
      "profitTaking": {
        "targets": [3, 5, 10],
        "sizes": [30, 30, 40]
      },
      "stopLoss": {
        "target": 5,
        "partial": true,
        "initialSize": 50,
        "scaleSize": 25,
        "scaleTarget": 2
      },
      "maxPositions": 5
    }
  ]
}
```
This strategy will:
- Trade ETH/USDC pair
- Use $1000 total position size
- Create buy orders at 2%, 5%, and 10% below market price
- Take profit at 3%, 5%, and 10% gains
- Use scaled stop losses starting at 5%
- Allow maximum 5 concurrent positions

### 3. Liquidity Provision (LP) Strategy
```json
{
  "strategies": [
    {
      "name": "ETH-USDC LP",
      "key": "lp_eth_usdc",
      "type": "lp",
      "privateKeyEnvKey": "STRATEGY_1_KEY",
      "base_token": "ETH",
      "quote_token": "USDC",
      "interval": 60,
      "token0": "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
      "token1": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      "token0Symbol": "WETH",
      "token1Symbol": "USDC",
      "token0Name": "Wrapped Ether",
      "token1Name": "USD Coin",
      "chainId": 1,
      "fee": 500,
      "priceRange": {
        "lowerBoundPercent": -10,
        "upperBoundPercent": 10
      },
      "totalValueInToken0": "5",
      "autoCompound": {
        "enabled": true,
        "threshold": 0.01,
        "maxGasFee": "50",
        "interval": 3600,
        "minFeesForCompound": "10"
      },
      "rebalance": {
        "enabled": true,
        "threshold": 5
      }
    }
  ]
}
```
This strategy will:
- Provide liquidity for ETH/USDC pair
- Set price range ±10% around current price
- Initially deposit an x amount of ETH and y amount of USDC in the pool such that the liquidity is 5 ETH
- Auto-compound rewards hourly if above $10
- Rebalance position if price moves more than 5%

### 4. BTC Bridge Strategy
```json
{
  "strategies": [
    {
      "name": "BTC Bridge",
      "key": "btcb",
      "type": "btc-bridge",
      "privateKeyEnvKey": "TBTC_PRIVATE_KEY",
      "amount": "0.2",
      "interval": 86400,
      "btcFeeRate": 70
    }
  ]
}
```
This strategy will:
- Bridge 0.2 BTC every 24 hours
- Use a fee rate of 70 sats/vB


## CLI Commands

Once the bot is running, you can use these commands:
- `help` - Show available commands
- `start <strategy>` - Start a specific strategy
- `stop <strategy>` - Stop a specific strategy
- `status <strategy>` - Show strategy status
- `start` - Start all strategies
- `stop` - Stop all strategies
- `quit` - Shutdown bot

## Monitoring

The CLI interface shows:
- Left panel: Strategy states and statistics
- Right panel: Log messages and updates
- Bottom panel: Command input

## Safety Tips

1. Always test with small amounts first
2. Use separate wallets for different strategies
3. Set reasonable slippage values
4. Monitor gas prices
5. Keep your private keys secure
6. Regularly check strategy performance

## Support

For issues or questions, please open a GitHub issue or reach out to the community.

## License

MIT License - see LICENSE file for details
