import express from 'express';
import axios from 'axios';
import OpenAI from 'openai';
import dotenv from 'dotenv';
import NodeCache from 'node-cache';
import { ethers } from 'ethers';
import db from '../config/db_config';
import { Server } from 'socket.io';
import http from 'http';
let tradingIntervalId: NodeJS.Timeout | null = null;

const app = express();
const server = http.createServer(app);

const cors = require('cors');


app.use(cors()); // ✅ Enables CORS for all origins

// OR, to allow only Angular dev server:
app.use(cors());


const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});

declare global {
  var io: Server;
}
globalThis.io = io;

dotenv.config();

const port = 3000;
const cache = new NodeCache({ stdTTL: 300 });

const tradingState: any = {
  positions: {},
  capital: 1000,
};

if (!process.env.OPENAI_API_KEY || !process.env.PRIVATE_KEY) {
  throw new Error('Missing environment variables');
}

function initializeDatabase() {
  return new Promise((resolve, reject) => {
    db.query(`
      CREATE TABLE IF NOT EXISTS trades (
        id INT AUTO_INCREMENT PRIMARY KEY,
        token_name VARCHAR(255) NOT NULL,
        token_address VARCHAR(255),
        amount DOUBLE NOT NULL,
        buy_price DOUBLE NOT NULL,
        buy_time BIGINT NOT NULL,
        order_id VARCHAR(255) NOT NULL,
        status VARCHAR(50) NOT NULL,
        sell_price DOUBLE,
        sell_time BIGINT,
        profit_loss DOUBLE
      )
    `, (err: any, results: unknown) => {
      if (err) reject(err);
      else {
        console.log('Database initialized');
        resolve(results);
      }
    });
  });
}

initializeDatabase().catch((error) => {
  console.error('Error initializing database:', error);
  process.exit(1);
});

// Connect wallet
// let wallet: any;
// try {
//   console.log('Connecting wallet...');
//   wallet = new ethers.Wallet(process.env.PRIVATE_KEY);
//   console.log("wallet",wallet);
//   console.log(`Wallet connected: ${wallet.address}`);
// } catch (error) {
//   console.error('Wallet connection error:', error);
//   throw error;
// }

// import { ethers } from 'ethers';

// Create a provider first
const provider = new ethers.JsonRpcProvider('https://rpc.ankr.com/eth'); // You can use any Ethereum RPC

let wallet: any;
try {
  console.log('Connecting wallet...');
  wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider); // Attach provider here
  console.log('Wallet:', wallet);
  console.log(`Wallet connected: ${wallet.address}`);
  
} catch (error) {
  console.error('Wallet connection error:', error);
  throw error;
}


const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: 'https://api.x.ai/v1',
});

const hyperliquidBaseUrl = 'https://api.hyperliquid.xyz';

app.use(express.json());

async function getSpotMeta() {
  const cachedData = cache.get('spotMeta');
  if (cachedData) {
    console.log('Using cached spot metadata');
    return cachedData;
  }
  try {
    console.log('Fetching spot metadata from Hyperliquid...');
    const response = await axios.post(
      `${hyperliquidBaseUrl}/info`,
      { type: 'spotMeta' },
      { headers: { 'Content-Type': 'application/json' } }
    );
    // console.log('Hyperliquid spotMeta response:', JSON.stringify(response.data, null, 2));
    if (!response.data?.tokens) {
      throw new Error('No tokens found in spotMeta response');
    }
    // cache.set('spotMeta', response.data);
    return response.data;
  } catch (error) {
    console.error('Error fetching spot meta:', error);
    if (error) {
      console.error('Response data:', JSON.stringify(error, null, 2));
    }
    throw error;
  }
}

async function getPriceHistory(tokenName: string, days = 1) {
  // Updated tokenIdMap with major cryptocurrencies
  const tokenIdMap: { [key: string]: string } = {
    SOL: 'solana',
    UBTC: "Unit Bitcoin",
    ETH: 'ethereum',
    XRP: 'ripple',
    ADA: 'cardano',
    // Add more tokens as needed
  };

  const tokenId = '0x8f254b963e8468305d409b33aa137c67'
if (tokenId) {
    try {
      console.log(`Fetching CoinGecko price history for ${tokenName} (mapped to ${tokenId})`);
      const response = await axios.get(
        `https://api.coingecko.com/api/v3/coins/${tokenId}/market_chart`,
        { params: { vs_currency: 'usd', days } }
      );

      console.log("response",response);
      return response.data.prices.map(([timestamp, price]: [number, number]) => ({
        date: new Date(timestamp).toLocaleString(),
        price,
      }));
    } catch (error: any) {
      console.error(`Error fetching CoinGecko price history for ${tokenName}:`, error.message);
      // logger.error(`Error fetching CoinGecko price history for ${tokenName}`, { message: error.message });
      throw error;
    }
  }


  console.warn(`Token ${tokenName} not found in tokenIdMap. Returning mock data.`);
  return Array.from({ length: days * 24 }, (_, i) => ({
    date: new Date(Date.now() - (days * 24 - i - 1) * 60 * 60 * 1000).toLocaleString(),
    price: 1 + (Math.random() - 0.5) * 0.1,
  }));

}

async function analyzeWithGrok(data: any, mode: 'buy' | 'sell', token?: any) {
  try {
    let prompt = '';
    if (mode === 'buy') {
      prompt = `
    You are a crypto trading expert specializing in spot trading. Analyze the token's spot market data and price history to determine if it's a good time to BUY. Consider the following:
    - **Price Trend**: Is the price showing an upward trend or breaking above key resistance levels?
    - **Momentum**: Is there increasing buying pressure (e.g., higher highs, higher lows)?
    - **Support/Resistance**: Is the price near a strong support level or breaking a resistance?
    - **Volatility**: Is the price stable or showing signs of a breakout?
    - **Recent Price Action**: Evaluate the last 5-10 price points for short-term patterns.
    
    **Token: ${token?.name || 'Unknown'}**
    **Current Price: ${data.priceHistory[data.priceHistory.length - 1]?.price || 'N/A'}**
    
    Data:\n\n${JSON.stringify(data, null, 2)}
    
    Format your response as:
    **Buy Signal: [Yes/No]**
    - **Reason**: [Provide a concise explanation based on technical analysis, e.g., trend, momentum, or key levels.]
    - **Confidence**: [Low/Medium/High, based on the strength of the signal.]
    `;
    } else if (mode === 'sell') {
      prompt = `
        You are a crypto trading expert. Should we SELL or HOLD this token?

        Profit/Loss: ${token.profit_loss.toFixed(2)} USD

        Data:\n\n${JSON.stringify(data, null, 2)}

        Format:
        **Recommendation: [SELL/HOLD]**
        - Reason:
        `;
    }

    const completion = await openai.chat.completions.create({
      model: 'grok-3',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 1500,
    });

    return completion.choices[0].message.content;
  } catch (error) {
    console.error('Grok analysis error:', error);
    throw error;
  }
}


async function placeBuyOrder(tokenName: string, amount: number, price: number, tokenAddress = 'N/A') {
  try {
    const formattedAmount = parseFloat(amount.toFixed(6));
    const formattedPrice = parseFloat(price.toFixed(6));
    const timestamp = Math.floor(Date.now() / 1000);
    const nonce = Date.now();

    // Prepare the order payload
    const orderPayload = {
      action: {
        type: 'order',
        order: {
          coin: tokenName,
          side: 'B', // Buying action
          limitPx: formattedPrice.toString(),
          sz: formattedAmount.toString(),
          orderType: { limit: {} },
          reduceOnly: false,
          cloid: `cloid-${nonce}` // Unique Client Order ID
        }
      },
      timestamp,
      vaultAddress: wallet.address,
      nonce
    };

    // Convert the payload to a JSON string and hash it
    const message = JSON.stringify(orderPayload);
    const messageHash = ethers.keccak256(ethers.toUtf8Bytes(message));

    // Sign the hashed message
    const signature = await wallet.signMessage(ethers.getBytes(messageHash));

    console.log('Order Payload:', JSON.stringify(orderPayload, null, 2));
    console.log('Signature:', signature);

    // Correct API Request Structure
    // const response = await axios.post(
    //   `${hyperliquidBaseUrl}/exchange`,
    //   {
    //     method: 'exchange', // The action method
    //     params: {
    //       action: orderPayload.action, // action (order details)
    //       signature, // signature for security
    //       timestamp, // timestamp of the order
    //       vaultAddress: orderPayload.vaultAddress, // wallet address
    //       nonce, // nonce to ensure request uniqueness
    //     }
    //   },
    //   {
    //     headers: { 'Content-Type': 'application/json' }
    //   }
    // ).catch((error) => {
    //   console.error('API Error Response:', JSON.stringify(error.response?.data, null, 2));
    //   throw error;
    // });




    // Handle response and logging
    const buyTime = Date.now();
    const orderId = Date.now();

    // const orderId = response.data.response?.data?.oid || response.data.orderId || 'unknown';

    await new Promise((resolve, reject) => {
      db.query(
        `INSERT INTO trades (token_name, token_address, amount, buy_price, buy_time, order_id, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [tokenName, tokenAddress, formattedAmount, formattedPrice, buyTime, orderId, 'open'],
        (err,result) => {
          if (err) reject(err);
          else{
            const newTrade = {
              id: result.insertId,
              tokenName, tokenAddress, amount: formattedAmount,
              token_name:tokenName,
              buy_price: formattedPrice, buyTime, orderId, status: 'open'
            };
            globalThis.io.emit('new_trade', newTrade);
            resolve(result.insertId);
          } 
        }
      );
    });

    // Emit trade data to clients via socket
    globalThis.io.emit('new_trade', {
      tokenName,
      tokenAddress,
      amount: formattedAmount,
      buyPrice: formattedPrice,
      buyTime,
      orderId,
      status: 'open',
    });

    console.log(`✅ Buy order placed for ${tokenName}: ${formattedAmount} at $${formattedPrice}`);
    return orderId;
  } catch (error) {
    console.error('Buy order error:', error);
    throw error;
  }
}


async function checkAndSellPositions() {
  try {
    db.query(`SELECT * FROM trades WHERE status = 'open'`, async (err: any, results: any[]) => {
      if (err) {
        console.error('Error fetching open trades:', err);
        return;
      }

      for (const trade of results) {
        const priceHistory = await getPriceHistory('ETH');
        // console.log("priceHistory",priceHistory)
    
        const latestPrice = 123;

        const profitLoss = (latestPrice - trade.buy_price) * trade.amount;
        const analysis:any = await analyzeWithGrok({ priceHistory }, 'sell', {
          ...trade,
          profit_loss: profitLoss,
        });

        if (analysis.includes('SELL')) {
          console.log(`Selling ${trade.token_name}...`);

          db.query(
            `UPDATE trades SET sell_price = ?, sell_time = ?, profit_loss = ?, status = 'closed' WHERE id = ?`,
            [latestPrice, Date.now(), profitLoss, trade.id],
            (updateErr: any) => {
              if (updateErr) {
                console.error('Sell update error:', updateErr);
              } else {
                console.log(`Sold ${trade.token_name} for ${profitLoss.toFixed(2)} USD`);
          
                // ✅ Emit trade_updated to all connected clients
                globalThis.io.emit('trade_updated', {
                  id: trade.id,
                  sell_price: latestPrice,
                  sellTime: Date.now(),
                  profit_loss:profitLoss,
                  token_name:trade.token_name,
                  status: 'closed',
                });
              }
            }
          );
          
        } else {
          console.log(`Hold ${trade.token_name}`);
        }
      }
    });
  } catch (error) {
    console.error('Error in checkAndSellPositions:', error);
  }
}

// async function startTradingLoop() {
//   setInterval(async () => {
//     console.log('Checking buy signals...');
//     // await startTrade();
//     console.log('Checking sell signals...');
//     await checkAndSellPositions();
//   }, 1000 * 60 * 1); // every 5 minutes
// }

async function startTradingLoop() {
  if (tradingIntervalId) {
    console.log('Trading loop is already running.');
    return;
  }

  tradingIntervalId = setInterval(async () => {
    console.log('Checking buy signals...');
    await startTrade();
    console.log('Checking sell signals...');
    // await checkAndSellPositions();
  }, 1000 * 60 * 1); // every 1 minute
}



const mainCoins = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'ADA', 'DOGE', 'AVAX', 'DOT', 'TRX', 'SHIB', 'MATIC', 'LTC', 'LINK', 'TON'];

async function startTrade() {
  try {
    const spotData = await getSpotMeta();
    const tokens = spotData || [];
    const tradingStarted = tokens.universe;
    // console.log("token",tokens.uni);
    //  return
    for (const token of tradingStarted) {
      console.log("token name ",token.name)
      if (!token.name) {
        console.warn('Skipping invalid token:', token);
        continue;
      }

        // ✅ Filter only main coins
  // if (!mainCoins.includes(token.name.toUpperCase())) {
  //   console.log(`Skipping meme or unknown coin: ${token.name}`);
  //   continue;
  // }

      // const priceHistory:any = await getPriceHistory(token.name);
      const priceHistory:any  = await getCandleData('BTC', '5m', startTime, endTime);

      console.log("priceHistory",priceHistory)

      const analysis:any = await analyzeWithGrok({ token, priceHistory }, 'buy', token);
      console.log(`Analysis for ${token.name}:`, analysis);
      if (analysis.includes('Buy Signal: Yes')) {
        const currentPrice = priceHistory[priceHistory.length - 1];
        console.log("currentPrice",currentPrice)
        if (!currentPrice) {
          console.warn(`No valid price for ${token.name}, skipping.`);
          continue;
        }
        console.log(`Current Price for ${token.name}: ${currentPrice}`); // Log price
        const tradeSize = tradingState.capital * 0.01;
        const amount = tradeSize / currentPrice;
        await placeBuyOrder('BTC', amount, currentPrice);
        console.log(`Bought ${token.name} at $${currentPrice}`);
      } else {
        console.log(`No buy signal for ${token.name}`);
      }
    }
  } catch (error) {
    console.error('startTrade error:', error);
  }
}

app.get('/start', async (req, res) => {
//  const data = await getSpotMeta() 
  console.log('Starting trading loop...');

  startTradingLoop();
  res.json({'Trading Started':"data"});
});


// Real-time connection
io.on('connection', (socket) => {
  console.log('Client connected');

  // Send all existing trades on connection
  db.query('SELECT * FROM trades', (err, results) => {
    // console.log("results",results);
    if (!err) {
      socket.emit('all_trades', results);
    }
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected');
  });
});

app.get('/stop', (req, res) => {
  if (tradingIntervalId) {
    clearInterval(tradingIntervalId);
    tradingIntervalId = null;
    console.log('Trading loop stopped.');
    res.json({ message: 'Trading stopped' });
  } else {
    console.log('No trading loop is running.');
    res.status(400).json({ message: 'Trading is not running' });
  }
});


// const axios = require('axios');

async function getCandleData(coin:any, interval:any, startTime:any, endTime:any) {
  // try {
  //   const response = await axios.post('https://api.hyperliquid.xyz/info', {
  //     type: 'candleSnapshot',
  //     req: {
  //       coin: coin, // e.g., 'BTC' for BTC-PERP
  //       interval: interval, // e.g., '1m' for 1-minute candles
  //       startTime: startTime, // e.g., 1696118400000 (Oct 1, 2023, 00:00 UTC)
  //       endTime: endTime // e.g., 1696204800000 (Oct 2, 2023, 00:00 UTC)
  //     }
  //   }, {
  //     headers: { 'Content-Type': 'application/json' }
  //   });

  //   // console.log('Candlestick Data:', JSON.stringify(response.data, null, 2));
  //   return response.data;
  // } catch (error) {
  //   console.error('Error fetching candlestick data:', error || error);
  //   throw error;
  // }
  return
}

// Example usage
const coin = 'BTC'; // BTC-PERP
const endTime = new Date().getTime();
const startTime = endTime - 24 * 60 * 60 * 1000; // 24 hours ago
// const candles = await getCandleData(tokenName, '5m', startTime, endTime);


// const axios = require('axios');
async function getCurrentPrice(coin: string): Promise<any> {
  try {
    // Method 1: Using allMids endpoint (most efficient for just getting price)
    const response = await axios.post('https://api.hyperliquid.xyz/info', {
      type: 'allMids'
    }, {
      headers: { 'Content-Type': 'application/json' }
    });
    console.log(response)
const coinArray = Object.entries(response.data)
  .filter(([key, value]) => !key.startsWith('@')) // Only keep actual coin names
  .map(([key, value]):any => ({
    symbol: key,
    price: (value)
  }));

console.log(coinArray);
    
    // Find the specific coin in the response
    const btc = coinArray.find(c => c.symbol === 'BTC');
console.log(btc);
  return btc;
   } catch (error) {
    console.error(`Error fetching current price for ${coin}:`, error);
    throw error;
  }
}

// Example usage
// getCurrentPrice('BTC')
//   .then(price => {
//     console.log(`Current ${coin} Price: $${price}`);
//   })
//   .catch(error => {
//     console.error('Failed to fetch current price:', error);
//   });



// import { ethers } from 'ethers';

// import { ethers } from 'ethers';

async function placeBuyOrders(coin: string, dollarAmount: number, useMarketPrice: boolean = false): Promise<string> {
  try {
    // First, get the current price of the coin
    const currentPrice = await getCurrentPrice(coin);
    
    if (!currentPrice || !currentPrice.price) {
      throw new Error(`Could not get valid price for ${coin}`);
    }
    
    const price = parseFloat(currentPrice.price);
    console.log(`Current price of ${coin}: $${price}`);
    
    // Calculate the size based on the dollar amount
    // Size = Dollar Amount / Current Price
    const size = dollarAmount / price;
    
    // Format size to appropriate precision (usually 4-6 decimal places for crypto)
    const formattedSize = size.toFixed(6);
    
    console.log(`Attempting to place buy order for ${coin}, amount: $${dollarAmount}, size: ${formattedSize}`);
    
    // Get private key from environment variables
    const privateKey = process.env.PRIVATE_KEY;
    
    if (!privateKey) {
      throw new Error('PRIVATE_KEY environment variable is not set');
    }
    
    // Create wallet from private key
    const wallet = new ethers.Wallet(privateKey);
    const address = wallet.address;
    
    console.log(`Using wallet address: ${address}`);
    
    // Create the order payload according to Hyperliquid docs
    const orderPayload: any = {
      coin,
      side: 'B', // B for Buy, A for Ask/Sell
      sz: formattedSize, // Size must be a string
      oid: Date.now().toString(), // Order ID, using timestamp for simplicity
    };
    
    // For limit orders vs market orders
    if (!useMarketPrice) {
      // Limit order at current price - make sure to use the actual price value as a string
      orderPayload.limit = price.toString();
      orderPayload.tif = 'Gtc'; // Good till cancelled
    } else {
      // Market order
      orderPayload.tif = 'Ioc'; // Immediate or cancel
    }
    
    // Create the action object - try with req field as per some API docs
    const action = {
      type: 'order',
      order: orderPayload // Try changing this to 'req' if it doesn't work
    };
    
    // Log the action to verify it's correct
    console.log('Action payload:', JSON.stringify(action, null, 2));
    
    // Create the message to sign (according to Hyperliquid docs)
    const message = JSON.stringify(action);
    
    // Sign the message - ethers v6 version
    // First hash the message with keccak256
    const messageHash = ethers.keccak256(ethers.toUtf8Bytes(message));
    // Then sign the hash
    const messageHashBytes = ethers.getBytes(messageHash);
    const signature = await wallet.signMessage(messageHashBytes);
    
    console.log('Message signed successfully');
    
    // Create the request payload
    const requestPayload = {
      action,
      signature,
      address
    };
    
    // Log the full request payload
    console.log('Request payload:', JSON.stringify(requestPayload, null, 2));
    // return signature;
    // Send the request
    const response = await axios.post('https://api.hyperliquid.xyz/exchange', requestPayload, {
      headers: { 'Content-Type': 'application/json' }
    });
    
    console.log('Buy order response:', JSON.stringify(response.data, null, 2));
    
    // Extract order ID from response
    const orderId = response.data.response?.data?.oid || 'unknown';
    
    return orderId;
  } catch (error) {
    console.error('Buy order error:', error);
    if (error) {
      console.error('Response status:', error);
      console.error('Response data:', error);
    }
    throw error;
  }
}



// Market buy order
placeBuyOrders('BTC', 15)
  .then((orderId:any) => console.log(`Market buy order placed with ID: ${orderId}`))
  .catch((error:any) => console.error('Failed to place market buy order:', error));





  

server.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
