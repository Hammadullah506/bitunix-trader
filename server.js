const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'templates')));

const CONFIG_PATH = path.join(__dirname, 'config.json');

function loadConfig() {
  const defaultCfg = {
    api_key: "81add794b9e4574b7d5219a3727d2911",
    secret_key: "2d6ffd217f070f4a2dfdce9ba9a3c2ce",
    symbol: "BTCUSDT",
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
    telegram_bot_token: "",
    telegram_chat_id: ""
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
        text: `🤖 Bitunix Auto-Trader:\n${text}`,
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

async function bitunixRequest(method, endpoint, params = null, data = null, isPrivate = false) {
  const baseUrl = "https://fapi.bitunix.com";
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

// Technical Indicators
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
let lastSignal = { signal: 'HOLD', reason: 'Bot analyzing...', confidence: 0 };
let paperPosition = null;

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

// Trading Tick Loop
async function tick() {
  const symbol = config.symbol || 'BTCUSDT';
  const interval = config.interval || '5m';

  // 1. Ticker
  const tRes = await bitunixRequest('GET', '/api/v1/futures/market/tickers', { symbol: symbol });
  if (tRes && tRes.code === 0 && Array.isArray(tRes.data)) {
    const item = tRes.data.find(d => d.symbol === symbol);
    if (item) currentTicker = item;
  }

  // 2. Klines
  const kRes = await bitunixRequest('GET', '/api/v1/futures/market/kline', { symbol: symbol, interval: interval, limit: 100 });
  if (!kRes || kRes.code !== 0 || !Array.isArray(kRes.data) || kRes.data.length === 0) return;

  const sorted = [...kRes.data].sort((a, b) => parseInt(a.time) - parseInt(b.time));
  const closes = sorted.map(c => parseFloat(c.close));
  const rsi = calculateRSI(closes, 14);
  const ema9 = calculateEMA(closes, 9);
  const ema21 = calculateEMA(closes, 21);
  const ema50 = calculateEMA(closes, 50);

  const latestPrice = closes[closes.length - 1];
  const currRsi = Math.round(rsi[rsi.length - 1] * 100) / 100;
  const prevRsi = Math.round(rsi[rsi.length - 2] * 100) / 100;
  const cEma9 = Math.round(ema9[ema9.length - 1] * 100) / 100;
  const cEma21 = Math.round(ema21[ema21.length - 1] * 100) / 100;
  const cEma50 = Math.round(ema50[ema50.length - 1] * 100) / 100;

  currentIndicators = {
    latest_price: latestPrice,
    current_rsi: currRsi,
    prev_rsi: prevRsi,
    ema9: cEma9,
    ema21: cEma21,
    ema50: cEma50,
    candles: sorted.map(s => ({
      time: parseInt(s.time),
      open: parseFloat(s.open),
      high: parseFloat(s.high),
      low: parseFloat(s.low),
      close: parseFloat(s.close)
    }))
  };

  // 3. Sniper Strategy Confluence
  let sig = 'HOLD';
  let reason = 'Market Range Neutral. Waiting for sniper setup.';
  let confidence = 50;

  const isOversold = (prevRsi <= (config.rsi_oversold || 30) && currRsi > prevRsi);
  const isOverbought = (prevRsi >= (config.rsi_overbought || 70) && currRsi < prevRsi);
  const isBullCross = (cEma9 > cEma21 && currRsi >= 40 && currRsi <= 58);
  const isBearCross = (cEma9 < cEma21 && currRsi <= 60 && currRsi >= 42);

  if (isOversold || (isBullCross && latestPrice >= cEma50)) {
    sig = 'BUY';
    reason = isOversold ? `🎯 SNIPER: Oversold Bounce (RSI: ${currRsi})` : `🎯 TREND: Bullish EMA9>EMA21 & Price>EMA50`;
    confidence = 85;
  } else if (isOverbought || (isBearCross && latestPrice <= cEma50)) {
    sig = 'SELL';
    reason = isOverbought ? `🎯 SNIPER: Overbought Drop (RSI: ${currRsi})` : `🎯 TREND: Bearish EMA9<EMA21 & Price<EMA50`;
    confidence = 85;
  }

  lastSignal = { signal: sig, reason: reason, confidence: confidence };

  // 4. Check active positions
  const posRes = await bitunixRequest('GET', '/api/v1/futures/position/get_pending_positions', { symbol: symbol }, null, true);
  const hasLivePos = posRes && posRes.code === 0 && Array.isArray(posRes.data) && posRes.data.some(p => parseFloat(p.qty) > 0);

  // 5. Open Order if no active position
  if (isRunning && !hasLivePos && (sig === 'BUY' || sig === 'SELL')) {
    const qty = parseFloat(config.order_qty || 0.0004);
    const tpPct = parseFloat(config.take_profit_pct || 1.0) / 100.0;
    const slPct = parseFloat(config.stop_loss_pct || 0.5) / 100.0;
    let tpPrice = sig === 'BUY' ? Math.round(latestPrice * (1 + tpPct) * 10) / 10 : Math.round(latestPrice * (1 - tpPct) * 10) / 10;
    let slPrice = sig === 'BUY' ? Math.round(latestPrice * (1 - slPct) * 10) / 10 : Math.round(latestPrice * (1 + slPct) * 10) / 10;

    log(`[LIVE] Placing ${sig} Order: ${qty} ${symbol} @ ~$${latestPrice} | TP: ${tpPrice} | SL: ${slPrice}`, 'INFO');
    const orderRes = await bitunixRequest('POST', '/api/v1/futures/trade/place_order', null, {
      effect: 'GTC',
      orderType: 'MARKET',
      qty: String(qty),
      side: sig,
      symbol: symbol,
      tradeSide: 'OPEN',
      tpPrice: String(tpPrice),
      tpOrderType: 'MARKET',
      tpStopType: 'LAST_PRICE',
      slPrice: String(slPrice),
      slOrderType: 'MARKET',
      slStopType: 'LAST_PRICE'
    }, true);

    if (orderRes && orderRes.code === 0) {
      log(`[LIVE] ORDER PLACED! ${sig} ${qty} ${symbol} | TP: ${tpPrice} | SL: ${slPrice}`, 'SUCCESS');
      sendTelegramAlert(`⚡ *NEW TRADE OPENED!*\n\n• *Symbol:* ${symbol}\n• *Direction:* ${sig}\n• *Quantity:* ${qty}\n• *Entry Price:* ~$${latestPrice}\n• *Take Profit:* $${tpPrice} (🎯 +${config.take_profit_pct}%)\n• *Stop Loss:* $${slPrice} (🛑 -${config.stop_loss_pct}%)`);
    } else {
      log(`[LIVE] Order failed: ${orderRes ? orderRes.msg : 'Unknown'}`, 'ERROR');
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
    const pos = await bitunixRequest('GET', '/api/v1/futures/position/get_pending_positions', { symbol: config.symbol || 'BTCUSDT' }, null, true);
    if (pos && pos.code === 0 && Array.isArray(pos.data)) livePositions = pos.data;
  } catch (e) {}

  res.json({
    running: isRunning,
    config: config,
    ticker: currentTicker,
    indicators: currentIndicators,
    last_signal: lastSignal,
    trade_mode: config.trade_mode || 'live',
    live_balance: liveBal,
    live_positions: livePositions,
    logs: logs
  });
});

app.get('/api/config', (req, res) => res.json(config));
app.post('/api/config', (req, res) => {
  saveConfig(req.body);
  log("Configuration updated", "INFO");
  sendTelegramAlert(`⚙️ *Settings Updated*\n• Symbol: ${config.symbol}\n• Leverage: ${config.leverage}x\n• TP: ${config.take_profit_pct}%\n• SL: ${config.stop_loss_pct}%`);
  res.json({ code: 0, msg: "Saved" });
});

app.post('/api/start', (req, res) => {
  isRunning = true;
  log("Bot Started", "INFO");
  sendTelegramAlert("🟢 *Bot Started!* Auto-Trading engine is now actively scanning market.");
  res.json({ code: 0 });
});

app.post('/api/stop', (req, res) => {
  isRunning = false;
  log("Bot Stopped", "INFO");
  sendTelegramAlert("🛑 *Bot Stopped!* Auto-Trading is paused.");
  res.json({ code: 0 });
});

app.post('/api/close_position', async (req, res) => {
  const symbol = config.symbol || 'BTCUSDT';
  const pos = await bitunixRequest('GET', '/api/v1/futures/position/get_pending_positions', { symbol: symbol }, null, true);
  if (pos && pos.code === 0 && Array.isArray(pos.data)) {
    for (const p of pos.data) {
      if (parseFloat(p.qty) > 0) {
        const side = p.side === 'LONG' || p.side === 'BUY' ? 'SELL' : 'BUY';
        await bitunixRequest('POST', '/api/v1/futures/trade/place_order', null, {
          orderType: 'MARKET',
          positionId: String(p.positionId),
          qty: String(p.qty),
          side: side,
          symbol: symbol,
          tradeSide: 'CLOSE'
        }, true);
      }
    }
    log("Position manually closed via Dashboard", "INFO");
    sendTelegramAlert(`✋ *Position Manually Closed* on ${symbol}`);
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
