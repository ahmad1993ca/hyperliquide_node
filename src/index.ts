import express from 'express';
import axios from 'axios';
import OpenAI from 'openai';
import dotenv from 'dotenv';
import NodeCache from 'node-cache';
import { ethers } from 'ethers';
// const db = require('./config/db_config')
// import db from '../config/db_config';
import db from '../config/db_config';



import { Server } from 'socket.io';
import http from 'http';

const app = express();
const server = http.createServer(app);

// 1. Create io instance
const io = new Server(server, {
  cors: {
    origin: '*', // Or your frontend URL
    methods: ['GET', 'POST'],
  },
});

// 2. Assign it to globalThis
declare global {
  var io: Server;
}
globalThis.io = io;


dotenv.config();

// const app = express();
const port = 3000;
const cache = new NodeCache({ stdTTL: 300 });

// Trading state to track open positions (in-memory, supplemented by DB)
const tradingState: any = {
  positions: {}, // { token: { amount, buyPrice, buyTime, orderId } }
  capital: 1000, // Example: $1000 total capital
};

// Validate environment variables
if (!process.env.OPENAI_API_KEY) {
  throw new Error('OPENAI_API_KEY environment variable is not set.');
}
if (!process.env.PRIVATE_KEY) {
  throw new Error('PRIVATE_KEY environment variable is not set.');
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
let wallet: any;
try {
  console.log('Connecting wallet...');
  wallet = new ethers.Wallet(process.env.PRIVATE_KEY);
  console.log(`Wallet connected: ${wallet.address}`);
} catch (error) {
  console.error('Error connecting wallet:', error);
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
    cache.set('spotMeta', response.data);
    console.log('Spot metadata fetched successfully');
    return response.data;
  } catch (error) {
    console.error('Error fetching spot meta:', error);
    throw error;
  }
}

async function getPriceHistory(tokenName: any, days = 1) {
  const tokenIdMap: any = {
    USDC: 'usd-coin',
    HYPE: 'hyperliquid',
  };
  console.log('tokenName ===================>>>',tokenName);
  const tokenId = tokenIdMap[tokenName];

  if (tokenId) {
    try {
      console.log(`Fetching price history for ${tokenName} from CoinGecko...`);
      const response = await axios.get(
        `https://api.coingecko.com/api/v3/coins/${tokenId}/market_chart`,
        {
          params: { vs_currency: 'usd', days },
        }
      );
      const prices = response.data.prices.map(([timestamp, price]: [number, number]) => ({
        date: new Date(timestamp).toLocaleString(), // Include time for precision
        price,
      }));
      console.log(`Price history fetched for ${tokenName}`);
      return prices;
    } catch (error) {
      console.error(`Error fetching price history for ${tokenName}:`, error);
    }
  }

  const simulatedPrices = Array.from({ length: days * 24 }, (_, i) => ({
    date: new Date(Date.now() - (days * 24 - i - 1) * 60 * 60 * 1000).toLocaleString(),
    price: 1 + (Math.random() - 0.5) * 0.1,
  }));
  console.warn(`Using simulated price data for ${tokenName}`);
  return simulatedPrices;
}

async function getAllPriceHistories(tokens: any, days = 7) {
  const priceHistories: any = {};
  console.log('Fetching chart data one by one...');
  for (const token of tokens) {
    priceHistories[token.name] = await getPriceHistory(token.name, days);
  }
  console.log('All chart data fetched',priceHistories);
  return priceHistories;
}

async function analyzeWithGrok(data: any, mode: 'buy' | 'sell', token?: any) {
  try {
    console.log(`Analyzing data with Grok for ${mode}...`);
    let prompt = '';
    if (mode === 'buy') {
      prompt = `
    You are a cryptocurrency trading expert. Analyze the following single token's spot market data and 7-day price history to determine if it is a good buy opportunity.
    
    Focus on:
    - Low or zero deployer fees (indicates cost-effective trading).
    - Canonical status (well-established and trusted).
    - EVM compatibility (important for DeFi integration).
    - Price trend (look for consistent uptrend, stability, or undervaluation).
    
    Use the following format:
    **Token: ${token?.name || 'Unknown'}**
    - Buy Signal: [Yes or No]
    - Reason: [Brief explanation]
    - Price Trend: [Uptrend / Downtrend / Stable / Simulated]
    - Metadata: [Fees, Canonical status, EVM compatible]
    
    Be honest — if it’s not a good time to buy, say "No" with reason.
    Here is the token data:\n\n${JSON.stringify(data, null, 2)}
      `;    
    } else if (mode === 'sell' && token) {
      prompt = `
        You are a cryptocurrency trading expert. Analyze the provided token data to decide whether to sell or hold the position for ${token.token_name}. Consider:
        - Current profit/loss: ${token.profit_loss.toFixed(2)} USD
        - Price trends over the last 7 days (uptrends, downtrends, volatility).
        - Market data (fees, liquidity, EVM compatibility).
        Provide a clear recommendation to either SELL or HOLD, with reasoning. Format as:
        **Recommendation: [SELL/HOLD]**
        - Reason: [Explanation]
        - Price Trend: [Trend or "Simulated"]
        - Profit/Loss: ${token.profit_loss.toFixed(2)} USD
        If data is insufficient, suggest further research:\n\n${JSON.stringify(data, null, 2)}
      `;
    }

    const completion = await openai.chat.completions.create({
      model: 'grok-3',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 1500,
    });
    console.log(`Grok ${mode} analysis completed`);
    return completion.choices[0].message.content;
  } catch (error) {
    console.error(`Error analyzing with Grok for ${mode}:`, error);
    throw error;
  }
}

// async function placeBuyOrder(tokenName: any, amount: any, price: any, tokenAddress = 'N/A') {
//   try {
//     console.log(`Placing buy order for ${amount} ${tokenName} at $${price}...`);
//     const orderPayload = {
//       type: 'limitOrder',
//       token: tokenName,
//       side: 'buy',
//       amount: amount.toString(),
//       price: price.toString(),
//       timestamp: Date.now(),
//     };
//     const signature = await wallet.signMessage(JSON.stringify(orderPayload));
//     const response = await axios.post(
//       `${hyperliquidBaseUrl}/exchange`,
//       { ...orderPayload, signature },
//       { headers: { 'Content-Type': 'application/json' } }
//     );
//     console.log(`Buy order placed: ${amount} ${tokenName} at $${price}`);

//     // Store buy transaction in database
//     const buyTime = Date.now();
    
//     return new Promise((resolve, reject) => {
//       db.query(
//         `INSERT INTO trades (token_name, token_address, amount, buy_price, buy_time, order_id, status)
//          VALUES (?, ?, ?, ?, ?, ?, ?)`,
//         [tokenName, tokenAddress, amount, price, buyTime,  response.data.orderId, 'open'],
//         (err: any, results: unknown) => {
//           if (err) reject(err);
//           else resolve(results);
//         }
//       );
//     });

//     // return response.data.orderId;
//   } catch (error) {
//     console.error(`Error placing buy order for ${tokenName}:`, error);
//     throw error;
//   }
// }


async function placeBuyOrder(tokenName: any, amount: any, price: any, tokenAddress = 'N/A') {
  try {
    console.log(`Placing buy order for ${amount} ${tokenName} at $${price}...`);
    
    const orderPayload = {
      type: 'limitOrder',
      token: tokenName,
      side: 'buy',
      amount: amount.toString(),
      price: price.toString(),
      timestamp: Date.now(),
    };

    const signature = await wallet.signMessage(JSON.stringify(orderPayload));
    
    const response = await axios.post(
      `${hyperliquidBaseUrl}/exchange`,
      { ...orderPayload, signature },
      { headers: { 'Content-Type': 'application/json' } }
    );

    console.log(`Buy order placed: ${amount} ${tokenName} at $${price}`);

    // Insert into database
    const buyTime = Date.now();
    const orderId = response.data.orderId;

    return new Promise((resolve, reject) => {
      db.query(
        `INSERT INTO trades (token_name, token_address, amount, buy_price, buy_time, order_id, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [tokenName, tokenAddress, amount, price, buyTime, orderId, 'open'],
        (err: any, results: unknown) => {
          if (err) {
            console.error('Database Insert Error:', err);
            reject(err);
          } else {
            console.log('Trade inserted into DB');

            // Emit socket event after successful insert
            if (globalThis.io) { // assuming socket.io is initialized globally
              globalThis.io.emit('new_trade', {
                tokenName,
                tokenAddress,
                amount,
                buyPrice: price,
                buyTime,
                orderId,
                status: 'open'
              });
              console.log('Socket event emitted: new_trade');
            }

            resolve(results);
          }
        }
      );
    });

  } catch (error) {
    console.error(`Error placing buy order for ${tokenName}:`, error);
    throw error;
  }
}


async function placeSellOrder(tokenName: any, amount: any, price: any, tradeId: number) {
  try {
    console.log(`Placing sell order for ${amount} ${tokenName} at $${price}...`);
    const orderPayload = {
      type: 'limitOrder',
      token: tokenName,
      side: 'sell',
      amount: amount.toString(),
      price: price.toString(),
      timestamp: Date.now(),
    };
    const signature = await wallet.signMessage(JSON.stringify(orderPayload));
    const response = await axios.post(
      `${hyperliquidBaseUrl}/exchange`,
      { ...orderPayload, signature },
      { headers: { 'Content-Type': 'application/json' } }
    );
    console.log(`Sell order placed: ${amount} ${tokenName} at $${price}`);

    // Update trade in database
    // const profitLoss = (price - (await db.get(`SELECT buy_price FROM trades WHERE id = ?`, tradeId)).buy_price) * amount;
// Get the buy price
const buyPrice: number = await new Promise((resolve, reject) => {
  db.query(
    `SELECT buy_price FROM trades WHERE id = ?`,
    [tradeId],
    (err: any, results: { buy_price: number }[]) => {
      if (err) reject(err);
      else resolve(results[0]?.buy_price);
    }
  );
});

// Calculate profit/loss (assuming 'price' is available)
const profitLoss = price - buyPrice;

// Update the trade with sell info
await new Promise((resolve, reject) => {
  db.query(
    `UPDATE trades SET status = ?, sell_price = ?, sell_time = ?, profit_loss = ? WHERE id = ?`,
    ['closed', price, Date.now(), profitLoss, tradeId],
    (err: any, results: unknown) => {
      if (err) reject(err);
      else resolve(results);
    }
  );
});

    return response.data.orderId;
  } catch (error) {
    console.error(`Error placing sell order for ${tokenName}:`, error);
    throw error;
  }
}

async function executeTrades(analysis: any) {
  console.log('Executing trades based on Grok analysis...');
  const trades = [];
  const recommendations = analysis.split('**Rank').slice(1).map((rec: any) => {
    const nameMatch = rec.match(/Rank \d+: (\w+)/);
    const priceTrendMatch = rec.match(/Price Trend: (.*?)\n/);
    return {
      token: nameMatch ? nameMatch[1] : null,
      priceTrend: priceTrendMatch ? priceTrendMatch[1] : 'Unknown',
    };
  }).filter((rec: any) => rec.token);

  for (const rec of recommendations) {
    const { token, priceTrend } = rec;
    if (priceTrend.includes('Simulated') || priceTrend === 'Unknown') {
      console.warn(`Skipping ${token}: Unreliable price data`);
      continue;
    }

    if (tradingState.positions[token]) {
      console.log(`Already holding ${token}, skipping buy`);
      continue;
    }

    const priceHistory = (await getPriceHistory(token))[0];
    const currentPrice = priceHistory.price;
    const tradeSize = tradingState.capital * 0.01;
    const amount = tradeSize / currentPrice;
    const buyOrderId = await placeBuyOrder(token, amount, currentPrice);
    
    tradingState.positions[token] = {
      amount,
      buyPrice: currentPrice,
      buyTime: Date.now(),
      buyOrderId,
    };
    trades.push({ token, type: 'buy', amount, price: currentPrice, orderId: buyOrderId });
  }
  console.log('Trades executed:', trades);
  return trades;
}

async function checkAndClosePositions() {
  console.log('Checking and closing positions...');
  const trades = [];
  
  // Fetch open trades from database
  // const openTrades = await db.all(`SELECT * FROM trades WHERE status = 'open'`);
  const openTrades:any = await new Promise((resolve, reject) => {
    db.query(`SELECT * FROM trades WHERE status = 'open'`, (err:any, results:any) => {
      if (err) reject(err);
      else resolve(results);
    });
  });
  
  
  for (const trade of openTrades) {
    const { id, token_name, amount, buy_price, buy_time } = trade;
    const priceHistory = await getPriceHistory(token_name);
    const currentPrice = priceHistory[0].price;
    const profitLoss = (currentPrice - buy_price) * amount;

    // Analyze with Grok for sell/hold decision
    const spotData = await getSpotMeta();
    const priceHistories = { [token_name]: priceHistory };
    const analysis:any = await analyzeWithGrok(
      { spotData, priceHistories, profitLoss },
      'sell',
      { token_name, profit_loss: profitLoss }
    );

    const recommendationMatch = analysis.match(/Recommendation: (\w+)/);
    const recommendation = recommendationMatch ? recommendationMatch[1] : 'HOLD';

    if (recommendation === 'SELL') {
      const sellOrderId = await placeSellOrder(token_name, amount, currentPrice, id);
      trades.push({
        token: token_name,
        type: 'sell',
        amount,
        price: currentPrice,
        orderId: sellOrderId,
        profitLoss,
      });
      delete tradingState.positions[token_name];
      console.log(
        `Closed position for ${token_name}: Sold ${amount} at $${currentPrice}, P/L: $${profitLoss.toFixed(2)}`
      );
    } else {
      console.log(
        `Holding ${token_name}: Current price $${currentPrice}, P/L: $${profitLoss.toFixed(2)}`
      );
    }
  }
  
  console.log('Closed trades:', trades);
  return trades;
}

// async function startTrade() {
//   try {
//     const spotData = await getSpotMeta();
//     const tokens = spotData.tokens || [];
//     const priceHistories = await getAllPriceHistories(tokens);
//     const analysis = await analyzeWithGrok({ spotData, priceHistories }, 'buy');
//     return { spotData, priceHistories, analysis };
//   } catch (error) {
//     console.error('Error in startTrade:', error);
//     throw error;
//   }
// }

async function startTrade() {
  try {
    const spotData = await getSpotMeta();
    const tokens = spotData.tokens || [];

    for (const token of tokens) {
      const priceHistory = await getPriceHistory(token); // adjust based on token structure
      const analysis = await analyzeWithGrok({ token, priceHistory }, 'buy', token);
      console.log(`Grok analysis for ${token.name}:`, analysis?.includes('Buy Signal: Yes'));
      if (analysis?.includes('Buy Signal: Yes')) {
        console.log(`Buy signal detected for ${token.name}`);
         await executeTrades(token); // You can pass token or parsed info
      }
      else {
        console.log(`No buy signal for ${token.name}`);
      }
    }

    return { success: true };
  } catch (error) {
    console.error('Error in startTrade:', error);
    throw error;
  }
}

async function tradingLoop() {
  console.log('Starting trading loop...');
  while (true) {
    try {
       await startTrade();
      // const newTrades = await executeTrades(analysis);
      const closedTrades = await checkAndClosePositions();
      
      console.log('Waiting for next iteration...');
      await new Promise((resolve) => setTimeout(resolve, 10 * 60 * 1000));
    } catch (error) {
      console.error('Error in trading loop:', error);
      await new Promise((resolve) => setTimeout(resolve, 60 * 1000));
    }
  }
}

app.get('/start', async (req, res) => {
  try {
    if (process.env.API_KEY && req.headers['x-api-key'] !== process.env.API_KEY) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const result = await startTrade();
    const trades = await executeTrades(result);
    res.json({ ...result, trades });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.listen(port, () => {
  console.log(`Server started on http://localhost:${port}`);
  tradingLoop();
});