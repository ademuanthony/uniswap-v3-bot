Here is how to get the bot running
1. Set up bitcoind so that bitcoin-cli becomes available in the CLI

2. Setup Monero Node + Wallet Setup 
2.1. Download the latest Monero binaries
```
cd ~
wget https://downloads.getmonero.org/cli/linux64 -O monero-linux.tar.bz2
tar -xvf monero-linux.tar.bz2
cd monero-linux-x64-*
```

2.2. Start Monero Node (monerod)
```
./monerod \
  --rpc-bind-ip 127.0.0.1 \
  --rpc-bind-port 18081 \
  --confirm-external-bind 0 \
  --prune-blockchain \
  --log-level 1
```

2.3 Create a directory for wallet storage
`mkdir -p /root/monero-wallets`

2.4 Start Wallet RPC Server
```
./monero-wallet-rpc \
  --rpc-bind-port 18083 \
  --rpc-login walletuser:walletpass \
  --wallet-dir /root/monero-wallets \
  --daemon-address http://127.0.0.1:18081 \
  --log-level 2
```

Replace walletuser:walletpass with strong credentials

3. Clone the source code
```
git clone https://github.com/ademuanthony/uniswap-v3-bot.git
cd uniswap-v3-bot
```

4. Create .env file
`nano .env`
populate the .env with settings
NETWORK=mainnet

```
PRIVATE_KEY=0x0000000000000000000000000000000000000000000000000000000000000000
SOLANA_RPC_ENDPOINT=https://necessary-compatible-cloud.solana-mainnet.quiknode.pro/c9e7e9fd66473ea740a0db5bc6ea1c03d837a9bc/

CHANGENOW_API_KEY=0d604bcf49828e6ad8be24204485a61607ad002dac03b33a7a8537de65c59b84

MONERO_RPC_URL=http://127.0.0.1:18083
MONERO_RPC_USERNAME=walletuser
MONERO_RPC_PASSWORD=walletpass
```

5. Create config file
`nano config.json`

Paste the following configuration that converts 0.5 BTC to USDC on the solana network every 5 days

```
{
  "strategies": [
    {
      "name": "BTC Bridge to Solana",
      "key": "btcb",
      "type": "btc-bridge",
      "privateKeyEnvKey": "PRIVATE_KEY",
      "amount": "0.5",
      "interval": 432000,
      "btcFeeRate": 15,
      "targetNetwork": "solana",
      "targetToken": "usdc",
      "generateNewSolanaWallet": true
    }
  ]
}
```