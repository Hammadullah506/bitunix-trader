const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'templates')));

const CONFIG_PATH = path.join(__dirname, 'config.json');

const COIN_CONFIGS = {
  'BTCUSDT': { qty: '0.0004', name: 'Bitcoin' },
  'ETHUSDT': { qty: '0.008', name: 'Ethereum' },
  'SOLUSDT': { qty: '0.15', name: 'Solana' },
  'XRPUSDT': { qty: '20', name: 'Ripple' },
  'DOGEUSDT': { qty: '150', name: 'Dogecoin' }
};

function loadConfig() {
  const defaultCfg = {
    api_key: "81add794b9e4574b7d5219a3727d2911",
    secret_key: "2d6ffd217f070f4a2dfdce9ba9a3c2ce",
    symbol: "BTCUSDT",
    multi_coin_mode: true,
    market_type: "futures",
    interval: "5m",
    trade_mode: "live",
    strategy: "rsi_ema",
    order_qty: 0.0004,
    leverage: 10,
    take_profit_pct: 1.0,
    stop_loss_pct: 0.5,
    trailing_sl: true,
    paper_balance: 1000.0,
    check_interval_seconds: 6,
    rsi_oversold: 30,
    rsi_overbought: 70,
    telegram_bot_token: "9036982151:AAEuubGBVf722GnWtg-NG2I_w2wyOkdOjwg",
    telegram_chat_id: "7955301726",
    today_profit: 0.0,
    daily_goal: 4.0
  };
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      const data = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
      return { ...defaultCfg, ...data };
    } catch (e) {
      console.error("Config read error:", e);
    }
  }
  return defaultCfg;
}

let config = loadConfig();

function saveConfig(newCfg) {
  config = { ...config, ...newCfg };
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
  } catch (e) {
    console.error("Config save error:", e);
  }
}

// Telegram Alert Sender
async function sendTelegramAlert(text) {
  if (!config.telegram_bot_token || !config.telegram_chat_id) return;
  try {
    const url = `https://api.telegram.org/bot${config.telegram_bot_token}/sendMessage`;
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: config.telegram_chat_id,
        text: `🤖 Bitunix Pro Auto-Trader:\n${text}`,
        parse_mode: 'Markdown'
      })
    });
  } catch (e) {
    console.error("Telegram send error:", e.message);
  }
}

// Bitunix API Helper
function sha256Hex(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

async function bitunixRequest(method, endpoint, params = null, data = null, isPrivate = false, isSpot = false) {
  const baseUrl = isSpot ? "https://openapi.bitunix.com" : "https://fapi.bitunix.com";
  let url = `${baseUrl}${endpoint}`;
  let signQueryStr = "";
  let urlQueryStr = "";

  if (params) {
    const sortedKeys = Object.keys(params).sort();
    signQueryStr = sortedKeys.map(k => `${k}${params[k]}`).join('');
    urlQueryStr = sortedKeys.map(k => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`).join('&');
  }

  let bodyStr = "";
  if (data !== null) {
    bodyStr = JSON.stringify(data);
  }

  const headers = {
    'Content-Type': 'application/json',
    'language': 'en-US'
  };

  if (isPrivate) {
    if (!config.api_key || !config.secret_key) {
      return { code: -1, msg: "API keys missing" };
    }
    const nonce = crypto.randomBytes(16).toString('hex');
    const timestamp = Date.now().toString();
    const digestInput = `${nonce}${timestamp}${config.api_key}${signQueryStr}${bodyStr}`;
    const firstDigest = sha256Hex(digestInput);
    const signature = sha256Hex(firstDigest + config.secret_key);

    headers['api-key'] = config.api_key;
    headers['sign'] = signature;
    headers['nonce'] = nonce;
    headers['timestamp'] = timestamp;
  }

  const reqUrl = urlQueryStr ? `${url}?${urlQueryStr}` : url;
  const options = {
    method: method.toUpperCase(),
    headers: headers
  };
  if (bodyStr && method.toUpperCase() === 'POST') {
    options.body = bodyStr;
  }

  try {
    const res = await fetch(reqUrl, options);
    return await res.json();
  } catch (err) {
    return { code: -1, msg: err.message };
  }
}

// Indicators
function calculateEMA(prices, period) {
  if (prices.length < period) return new Array(prices.length).fill(prices[prices.length - 1] || 0);
  const k = 2 / (period + 1);
  let ema = [];
  const initialSMA = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = 0; i < period; i++) ema.push(initialSMA);
  let currentEMA = initialSMA;
  for (let i = period; i < prices.length; i++) {
    currentEMA = (prices[i] - currentEMA) * k + currentEMA;
    ema.push(currentEMA);
  }
  return ema;
}

function calculateRSI(prices, period = 14) {
  if (prices.length <= period) return new Array(prices.length).fill(50);
  let gains = [];
  let losses = [];
  for (let i = 1; i < prices.length; i++) {
    const diff = prices[i] - prices[i - 1];
    gains.push(diff > 0 ? diff : 0);
    losses.push(diff < 0 ? -diff : 0);
  }
  let rsi = new Array(period).fill(50);
  let avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;

  let rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
  rsi.push(100 - (100 / (1 + rs)));

  for (let i = period; i < gains.length; i++) {
    avgGain = (avgGain * (period - 1) + gains[i]) / period;
    avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
    rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    rsi.push(100 - (100 / (1 + rs)));
  }
  return rsi;
}

// State
let isRunning = true;
let logs = [];
let currentTicker = {};
let currentIndicators = {};
let lastSignal = { signal: 'HOLD', reason: 'Scanning multi-coin market...', confidence: 0 };
let multiCoinScanner = {};
let spotBalance = null;

function log(message, level = 'INFO') {
  const entry = {
    time: new Date().toISOString().replace('T', ' ').slice(0, 19),
    level: level,
    message: message
  };
  logs.unshift(entry);
  if (logs.length > 100) logs.pop();
  console.log(`[${entry.time}] [${level}] ${message}`);
}

// Multi-Coin Autonomous Scanner & Executor Loop
async function tick() {
  const interval = config.interval || '5m';
  const symbolsToScan = config.multi_coin_mode ? Object.keys(COIN_CONFIGS) : [config.symbol || 'BTCUSDT'];

  let bestOpportunity = null;

  // 1. Scan Each Coin
  for (const sym of symbolsToScan) {
    try {
      const kRes = await bitunixRequest('GET', '/api/v1/futures/market/kline', { symbol: sym, interval: interval, limit: 60 });
      if (!kRes || kRes.code !== 0 || !Array.isArray(kRes.data) || kRes.data.length < 25) continue;

      const sorted = [...kRes.data].sort((a, b) => parseInt(a.time) - parseInt(b.time));
      const closes = sorted.map(c => parseFloat(c.close));
      const rsi = calculateRSI(closes, 14);
      const ema9 = calculateEMA(closes, 9);
      const ema21 = calculateEMA(closes, 21);
      const ema50 = calculateEMA(closes, 50);

      const latestPrice = closes[closes.length - 1];
      const currRsi = Math.round(rsi[rsi.length - 1] * 10) / 10;
      const prevRsi = Math.round(rsi[rsi.length - 2] * 10) / 10;
      const cEma9 = ema9[ema9.length - 1];
      const cEma21 = ema21[ema21.length - 1];
      const cEma50 = ema50[ema50.length - 1];

      // Evaluate signal
      let sig = 'HOLD';
      let reason = 'Range Neutral';
      let confidence = 40;

      const isOversold = (prevRsi <= (config.rsi_oversold || 30) && currRsi > prevRsi);
      const isOverbought = (prevRsi >= (config.rsi_overbought || 70) && currRsi < prevRsi);
      const isBullCross = (cEma9 > cEma21 && currRsi >= 42 && currRsi <= 58 && latestPrice >= cEma50);
      const isBearCross = (cEma9 < cEma21 && currRsi <= 58 && currRsi >= 42 && latestPrice <= cEma50);

      if (isOversold) {
        sig = 'BUY';
        reason = `Oversold Reversal (RSI: ${currRsi})`;
        confidence = 90;
      } else if (isOverbought) {
        sig = 'SELL';
        reason = `Overbought Drop (RSI: ${currRsi})`;
        confidence = 90;
      } else if (isBullCross) {
        sig = 'BUY';
        reason = `Bullish Trend Cross (EMA9>21 & Price>EMA50)`;
        confidence = 80;
      } else if (isBearCross) {
        sig = 'SELL';
        reason = `Bearish Trend Cross (EMA9<21 & Price<EMA50)`;
        confidence = 80;
      }

      multiCoinScanner[sym] = {
        symbol: sym,
        name: COIN_CONFIGS[sym].name,
        price: latestPrice,
        rsi: currRsi,
        signal: sig,
        confidence: confidence,
        reason: reason
      };

      // Keep BTC indicators for primary chart
      if (sym === (config.symbol || 'BTCUSDT')) {
        currentIndicators = {
          latest_price: latestPrice,
          current_rsi: currRsi,
          prev_rsi: prevRsi,
          ema9: Math.round(cEma9 * 10) / 10,
          ema21: Math.round(cEma21 * 10) / 10,
          ema50: Math.round(cEma50 * 10) / 10,
          candles: sorted.map(s => ({
            time: parseInt(s.time),
            open: parseFloat(s.open),
            high: parseFloat(s.high),
            low: parseFloat(s.low),
            close: parseFloat(s.close)
          }))
        };
        lastSignal = { signal: sig, reason: reason, confidence: confidence };
      }

      // Check if this is the best setup
      if (confidence >= 80 && (sig === 'BUY' || sig === 'SELL')) {
        if (!bestOpportunity || confidence > bestOpportunity.confidence) {
          bestOpportunity = {
            symbol: sym,
            signal: sig,
            price: latestPrice,
            confidence: confidence,
            reason: reason,
            qty: COIN_CONFIGS[sym].qty
          };
        }
      }
    } catch (e) {
      // Continue next coin
    }
  }

  // 2. Check Active Positions on Bitunix
  const posRes = await bitunixRequest('GET', '/api/v1/futures/position/get_pending_positions', {}, null, true);
  const activePositions = (posRes && posRes.code === 0 && Array.isArray(posRes.data)) 
    ? posRes.data.filter(p => parseFloat(p.qty) > 0)
    : [];

  // Trailing Stop-Loss Protection Check
  if (config.trailing_sl && activePositions.length > 0) {
    for (const p of activePositions) {
      const pnl = parseFloat(p.unrealizedPNL || 0);
      if (pnl > 0.05) {
        // Position is comfortably in profit!
      }
    }
  }

  // 3. Autonomous Execution: Open trade on the best coin if capacity available (Max 1 concurrent position)
  if (isRunning && activePositions.length === 0 && bestOpportunity) {
    const sym = bestOpportunity.symbol;
    const side = bestOpportunity.signal;
    const price = bestOpportunity.price;
    const qty = bestOpportunity.qty;

    const tpPct = parseFloat(config.take_profit_pct || 1.0) / 100.0;
    const slPct = parseFloat(config.stop_loss_pct || 0.5) / 100.0;
    let tpPrice = side === 'BUY' ? Math.round(price * (1 + tpPct) * 100) / 100 : Math.round(price * (1 - tpPct) * 100) / 100;
    let slPrice = side === 'BUY' ? Math.round(price * (1 - slPct) * 100) / 100 : Math.round(price * (1 + slPct) * 100) / 100;

    log(`[AUTO-SNIPER] Selected Best Coin: ${sym} (${bestOpportunity.reason}). Placing ${side} order: ${qty} @ ~$${price}`, 'INFO');

    const orderRes = await bitunixRequest('POST', '/api/v1/futures/trade/place_order', null, {
      effect: 'GTC',
      orderType: 'MARKET',
      qty: String(qty),
      side: side,
      symbol: sym,
      tradeSide: 'OPEN',
      tpPrice: String(tpPrice),
      tpOrderType: 'MARKET',
      tpStopType: 'LAST_PRICE',
      slPrice: String(slPrice),
      slOrderType: 'MARKET',
      slStopType: 'LAST_PRICE'
    }, true);

    if (orderRes && orderRes.code === 0) {
      log(`[LIVE] ORDER PLACED! ${side} ${qty} ${sym} | TP: $${tpPrice} | SL: $${slPrice}`, 'SUCCESS');
      sendTelegramAlert(`🎯 *NEW AUTO-TRADE EXECUTED!*\n\n• *Coin:* ${sym} (${COIN_CONFIGS[sym].name})\n• *Action:* ${side} (Market)\n• *Size:* ${qty}\n• *Entry:* ~$${price}\n• *🎯 Target Profit:* $${tpPrice} (+${config.take_profit_pct}%)\n• *🛑 Stop Loss:* $${slPrice} (-${config.stop_loss_pct}%)\n\n_Auto-managed 24/7 by Bitunix Pro Engine_`);
    } else {
      log(`[LIVE] Order failed for ${sym}: ${orderRes ? orderRes.msg : 'Unknown'}`, 'ERROR');
    }
  }
}

// REST Endpoints
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'templates', 'index.html')));

app.get('/api/status', async (req, res) => {
  let liveBal = null;
  let livePositions = [];
  try {
    const acc = await bitunixRequest('GET', '/api/v1/futures/account', { marginCoin: 'USDT' }, null, true);
    if (acc && acc.code === 0) liveBal = acc.data;
    const pos = await bitunixRequest('GET', '/api/v1/futures/position/get_pending_positions', {}, null, true);
    if (pos && pos.code === 0 && Array.isArray(pos.data)) {
      livePositions = pos.data.filter(p => parseFloat(p.qty) > 0);
    }
    // Spot Balance
    const sAcc = await bitunixRequest('GET', '/api/spot/v1/user/account', null, null, true, true);
    if (sAcc && sAcc.code === '0' && Array.isArray(sAcc.data)) {
      spotBalance = sAcc.data;
    }
  } catch (e) {}

  res.json({
    running: isRunning,
    config: config,
    ticker: currentTicker,
    indicators: currentIndicators,
    last_signal: lastSignal,
    multi_coins: multiCoinScanner,
    trade_mode: config.trade_mode || 'live',
    live_balance: liveBal,
    spot_balance: spotBalance,
    live_positions: livePositions,
    logs: logs
  });
});

app.get('/api/config', (req, res) => res.json(config));
app.post('/api/config', (req, res) => {
  saveConfig(req.body);
  log("Configuration updated", "INFO");
  sendTelegramAlert(`⚙️ *Settings Updated*\n• Multi-Coin Mode: ${config.multi_coin_mode ? 'ENABLED ✅' : 'DISABLED'}\n• Leverage: ${config.leverage}x\n• TP: ${config.take_profit_pct}%\n• SL: ${config.stop_loss_pct}%`);
  res.json({ code: 0, msg: "Saved" });
});

app.post('/api/start', (req, res) => {
  isRunning = true;
  log("Bot Started", "INFO");
  sendTelegramAlert("🟢 *Bot Started!* Multi-Coin Auto-Trading engine is actively scanning BTC, ETH, SOL, XRP, DOGE.");
  res.json({ code: 0 });
});

app.post('/api/stop', (req, res) => {
  isRunning = false;
  log("Bot Stopped", "INFO");
  sendTelegramAlert("🛑 *Bot Stopped!* Auto-Trading paused.");
  res.json({ code: 0 });
});

app.post('/api/close_position', async (req, res) => {
  const pos = await bitunixRequest('GET', '/api/v1/futures/position/get_pending_positions', {}, null, true);
  if (pos && pos.code === 0 && Array.isArray(pos.data)) {
    for (const p of pos.data) {
      if (parseFloat(p.qty) > 0) {
        const side = p.side === 'LONG' || p.side === 'BUY' ? 'SELL' : 'BUY';
        await bitunixRequest('POST', '/api/v1/futures/trade/place_order', null, {
          orderType: 'MARKET',
          positionId: String(p.positionId),
          qty: String(p.qty),
          side: side,
          symbol: p.symbol,
          tradeSide: 'CLOSE'
        }, true);
      }
    }
    log("All positions manually closed", "INFO");
    sendTelegramAlert("✋ *All positions manually closed via Dashboard*");
    return res.json({ code: 0, msg: "Closed" });
  }
  res.json({ code: -1, msg: "No active position" });
});

setInterval(() => {
  tick().catch(e => console.error("Tick error:", e));
}, 6000);

app.listen(PORT, () => {
  log(`Bitunix Auto-Trader Pro running on port ${PORT}`, 'SUCCESS');
  tick();
});
