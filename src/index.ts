import express from 'express';
import axios from 'axios';
import OpenAI from 'openai';
import dotenv from 'dotenv';
import NodeCache from 'node-cache';
import { ethers } from 'ethers';
import db from '../config/db_config';
import { Server } from 'socket.io';
import http from 'http';

const app = express();
const server = http.createServer(app);

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
    console.log('Fetching spot metadata...');
    const response = await axios.post(
      `${hyperliquidBaseUrl}/info`,
      { type: 'spotMeta' },
      { headers: { 'Content-Type': 'application/json' } }
    );
    cache.set('spotMeta', response.data);
    // console.log('Fetched spot metadata',response.data);
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
  const tokenId = tokenIdMap[tokenName];

  if (tokenId) {
    try {
      const response = await axios.get(
        `https://api.coingecko.com/api/v3/coins/${tokenId}/market_chart`,
        { params: { vs_currency: 'usd', days } }
      );
      return response.data.prices.map(([timestamp, price]: [number, number]) => ({
        date: new Date(timestamp).toLocaleString(),
        price,
      }));
    } catch (error) {
      console.error('Error fetching price history:', error);
    }
  }

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
        (err) => {
          if (err) reject(err);
          else resolve(null);
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
        const priceHistory = await getPriceHistory(trade.token_name);
        const latestPrice = priceHistory[0]?.price || trade.buy_price;

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
              if (updateErr) console.error('Sell update error:', updateErr);
              else console.log(`Sold ${trade.token_name} for ${profitLoss.toFixed(2)} USD`);
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

async function startTradingLoop() {
  setInterval(async () => {
    console.log('Checking buy signals...');
    // await startTrade();
    console.log('Checking sell signals...');
    await checkAndSellPositions();
  }, 1000 * 60 * 1); // every 5 minutes
}

async function startTrade() {
  try {
    const spotData = await getSpotMeta();
    const tokens = spotData.tokens || [];

    for (const token of tokens) {
      if (!token.name) {
        console.warn('Skipping invalid token:', token);
        continue;
      }
      const priceHistory = await getPriceHistory(token.name);
      const analysis:any = await analyzeWithGrok({ token, priceHistory }, 'buy', token);
      console.log(`Analysis for ${token.name}:`, analysis);
      if (analysis.includes('Buy Signal: Yes')) {
        const currentPrice = priceHistory[0]?.price;
        if (!currentPrice) {
          console.warn(`No valid price for ${token.name}, skipping.`);
          continue;
        }
        console.log(`Current Price for ${token.name}: ${currentPrice}`); // Log price
        const tradeSize = tradingState.capital * 0.01;
        const amount = tradeSize / currentPrice;
        await placeBuyOrder(token.name, amount, currentPrice);
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

  console.log('Starting trading loop...');
  startTradingLoop();
  res.send('Trading bot started!');
});


server.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
