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
  'BTCUSDT': { qty: '0.0004', name: 'BTC', precision: 4 },
  'ETHUSDT': { qty: '0.008', name: 'ETH', precision: 4 },
  'SOLUSDT': { qty: '0.15', name: 'SOL', precision: 2 },
  'XRPUSDT': { qty: '20', name: 'XRP', precision: 1 },
  'DOGEUSDT': { qty: '150', name: 'DOGE', precision: 0 }
};

function loadConfig() {
  const defaultCfg = {
    api_key: "81add794b9e4574b7d5219a3727d2911",
    secret_key: "2d6ffd217f070f4a2dfdce9ba9a3c2ce",
    symbol: "BTCUSDT",
    multi_coin_mode: true,
    spot_auto_mode: true,
    spot_tp_pct: 1.5,
    interval: "5m",
    trade_mode: "live",
    strategy: "rsi_ema",
    order_qty: 0.0004,
    leverage: 10,
    dynamic_profit_ride: true,
    trailing_drop_threshold: 0.3,
    fixed_stop_loss_pct: 0.5,
    paper_balance: 1000.0,
    check_interval_seconds: 5,
    rsi_oversold: 30,
    rsi_overbought: 70,
    telegram_bot_token: "9036982151:AAEuubGBVf722GnWtg-NG2I_w2wyOkdOjwg",
    telegram_chat_id: "7955301726",
    today_profit: 0.0,
    daily_goal: 4.0,
    max_concurrent_positions: 3
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

// Telegram Alert Sender with Markdown + Plain Text Fallback
async function sendTelegramAlert(text) {
  if (!config.telegram_bot_token || !config.telegram_chat_id) return;
  try {
    const url = `https://api.telegram.org/bot${config.telegram_bot_token}/sendMessage`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: config.telegram_chat_id,
        text: `⚡ *Bitunix Pro AI Trader*\n\n${text}`,
        parse_mode: 'Markdown'
      })
    });
    if (!res.ok) {
      // If Markdown has an entity parsing issue, send as clean plain text so notification is NEVER missed!
      const plain = text.replace(/[*_`]/g, '');
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: config.telegram_chat_id,
          text: `⚡ Bitunix Pro AI Trader\n\n${plain}`
        })
      });
    }
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

  if (params && Object.keys(params).length > 0) {
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
let currentTicker = { last: '65500', high: '69000', low: '64800' };
let currentIndicators = {};
let lastSignal = { signal: 'HOLD', reason: 'Scanning multi-coin market...', confidence: 0 };
let multiCoinScanner = {};
let spotBalance = null;
let spotHoldings = {};
let positionTrackers = {};
let totalRealizedProfitToday = 0.0;
let latestFuturesCash = "9.95";
let scanTickCount = 0;

function log(message, level = 'INFO') {
  const entry = {
    time: new Date().toISOString().replace('T', ' ').slice(0, 19),
    level: level,
    message: message
  };
  logs.unshift(entry);
  if (logs.length > 80) logs.pop();
  console.log(`[${entry.time}] [${level}] ${message}`);
}

// Parallel Ultra-Fast Multi-Coin Scan
async function futuresTick() {
  const interval = config.interval || '5m';
  const symbolsToScan = config.multi_coin_mode ? Object.keys(COIN_CONFIGS) : [config.symbol || 'BTCUSDT'];
  let bestOpportunity = null;

  // Run all coin scans in parallel for ultra-fast response
  const scanPromises = symbolsToScan.map(async (sym) => {
    try {
      const kRes = await bitunixRequest('GET', '/api/v1/futures/market/kline', { symbol: sym, interval: interval, limit: 50 });
      if (!kRes || kRes.code !== 0 || !Array.isArray(kRes.data) || kRes.data.length < 20) return null;

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
        reason = `Bullish Trend (EMA9>21 & Price>EMA50)`;
        confidence = 80;
      } else if (isBearCross) {
        sig = 'SELL';
        reason = `Bearish Trend (EMA9<21 & Price<EMA50)`;
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

      if (sym === (config.symbol || 'BTCUSDT')) {
        currentTicker = {
          symbol: sym,
          last: String(latestPrice),
          lastPrice: String(latestPrice),
          high: String(Math.max(...closes.slice(-24))),
          low: String(Math.min(...closes.slice(-24)))
        };
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

      if (confidence >= 80 && (sig === 'BUY' || sig === 'SELL')) {
        return {
          symbol: sym,
          signal: sig,
          price: latestPrice,
          confidence: confidence,
          reason: reason,
          qty: COIN_CONFIGS[sym].qty
        };
      }
      return null;
    } catch (e) {
      return null;
    }
  });

  const results = await Promise.all(scanPromises);
  const candidates = results.filter(Boolean);
  if (candidates.length > 0) {
    candidates.sort((a, b) => b.confidence - a.confidence);
    bestOpportunity = candidates[0];
  }

  scanTickCount++;
  if (scanTickCount % 2 === 0) {
    const btcP = multiCoinScanner['BTCUSDT'] ? multiCoinScanner['BTCUSDT'].price : '-';
    const ethP = multiCoinScanner['ETHUSDT'] ? multiCoinScanner['ETHUSDT'].price : '-';
    const solP = multiCoinScanner['SOLUSDT'] ? multiCoinScanner['SOLUSDT'].price : '-';
    log(`[RADAR 5s] BTC: $${btcP} | ETH: $${ethP} | SOL: $${solP} -> 5 Markets Scanned`, 'INFO');
  }

  // Active Futures Positions Monitoring
  const posRes = await bitunixRequest('GET', '/api/v1/futures/position/get_pending_positions', null, null, true);
  const activePositions = (posRes && posRes.code === 0 && Array.isArray(posRes.data)) 
    ? posRes.data.filter(p => parseFloat(p.qty) > 0)
    : [];

  // Check for positions that closed (e.g. Stop Loss executed by exchange)
  const activeIds = new Set(activePositions.map(p => String(p.positionId)));
  for (const id of Object.keys(positionTrackers)) {
    if (!activeIds.has(id)) {
      const trk = positionTrackers[id];
      if (trk && !trk.closedNotified) {
        trk.closedNotified = true;
        log(`[POSITION CLOSED] ${trk.symbol} trade closed. Sending Telegram confirmation...`, 'INFO');
        sendTelegramAlert(`🛡️ *POSITION CLOSED & SETTLED*\n\n• *Symbol:* ${trk.symbol || 'Crypto'}\n• *Side:* ${(trk.side || 'BUY').toUpperCase()}\n• *Entry:* ~$${trk.entryPrice || '-'}\n• *Status:* Position successfully closed & margin released back to wallet.\n• *Current Cash:* $${latestFuturesCash} USDT (100% Capital Safe)\n\n_Scanning next sniper setup..._`);
      }
      delete positionTrackers[id];
    }
  }

  // Strategic Dynamic Profit Runner & Strict Loss Protection
  for (const pos of activePositions) {
    const posId = String(pos.positionId);
    const entryPrice = parseFloat(pos.avgOpenPrice || 0);
    const currPrice = multiCoinScanner[pos.symbol] ? multiCoinScanner[pos.symbol].price : entryPrice;
    const isLong = (pos.side === 'BUY' || pos.side === 'LONG');
    
    const priceDiffPct = isLong 
      ? ((currPrice - entryPrice) / entryPrice) * 100 
      : ((entryPrice - currPrice) / entryPrice) * 100;
    
    const leveragedPnlPct = priceDiffPct * parseFloat(pos.leverage || config.leverage || 10);
    const pnlUsd = parseFloat(pos.unrealizedPNL || 0);

    if (!positionTrackers[posId]) {
      positionTrackers[posId] = {
        symbol: pos.symbol,
        entryPrice: entryPrice,
        side: pos.side,
        maxPnlPct: leveragedPnlPct,
        notifiedRide: false,
        closedNotified: false
      };
    }

    const tracker = positionTrackers[posId];
    if (leveragedPnlPct > tracker.maxPnlPct) {
      tracker.maxPnlPct = leveragedPnlPct;
    }

    // 1. Strict Fixed Loss Cut (-0.5% limit)
    const fixedSlPct = parseFloat(config.fixed_stop_loss_pct || 0.5);
    if (priceDiffPct <= -fixedSlPct) {
      log(`[STRICT SL CUT] ${pos.symbol} reached -${fixedSlPct}%! Exiting immediately...`, 'WARNING');
      tracker.closedNotified = true;
      await closeSpecificPosition(pos);
      delete positionTrackers[posId];
      sendTelegramAlert(`🛑 *FIXED STOP LOSS CUT*\n\n• *Symbol:* ${pos.symbol}\n• *Reason:* Hit strict -${fixedSlPct}% limit\n• *Closed Loss:* -$${Math.abs(pnlUsd).toFixed(4)} USDT\n\n_Capital preserved._`);
      continue;
    }

    // 2. Fast Scalping + Dynamic Profit Runner (Lock quick small gains or let runners fly)
    if (priceDiffPct >= 0.35) {
      if (priceDiffPct >= 0.8 && !tracker.notifiedRide) {
        tracker.notifiedRide = true;
        sendTelegramAlert(`🚀 *PROFIT RUNNER ACTIVE!*\n\n• *Symbol:* ${pos.symbol}\n• *Current Gain:* +${priceDiffPct.toFixed(2)}% (+$${pnlUsd.toFixed(4)} USDT)\n• *Status:* Profit is uncapped — letting winner run higher! 📈`);
      }

      // Fast rotation threshold: If trade hits +0.35% - +0.6% and pulls back 0.15%, lock it quickly!
      const dropThreshold = priceDiffPct >= 0.8 ? 0.25 : 0.15;
      const peakPriceDrop = (tracker.maxPnlPct - leveragedPnlPct) / parseFloat(pos.leverage || 10);

      if (peakPriceDrop >= dropThreshold && pnlUsd > 0.01) {
        log(`[QUICK SCALP PROFIT] ${pos.symbol} locked +$${pnlUsd.toFixed(4)} USDT (+${priceDiffPct.toFixed(2)}%). Rotating to next setup!`, 'SUCCESS');
        tracker.closedNotified = true;
        await closeSpecificPosition(pos);
        totalRealizedProfitToday += pnlUsd;
        delete positionTrackers[posId];
        sendTelegramAlert(`💰 *QUICK SCALP PROFIT LOCKED!*\n\n• *Symbol:* ${pos.symbol}\n• *Net Gain:* +${priceDiffPct.toFixed(2)}% (+$${pnlUsd.toFixed(4)} USDT)\n• *Action:* Profit secured quickly — rotating to next sniper trade!\n\n_Cash safe in wallet!_`);
        continue;
      }
    }
  }

  // 3. Multi-Coin Concurrent Trades (Up to 3 Simultaneous Positions on Distinct Coins)
  const maxActivePositions = parseInt(config.max_concurrent_positions || 3);
  const currentActiveSymbols = new Set(activePositions.map(p => p.symbol));

  if (isRunning && activePositions.length < maxActivePositions && candidates.length > 0) {
    for (const opp of candidates) {
      if (activePositions.length >= maxActivePositions) break;
      if (currentActiveSymbols.has(opp.symbol)) continue; // Never duplicate position on same coin

      const sym = opp.symbol;
      const side = opp.signal;
      const price = opp.price;
      const qty = opp.qty;

      const slPct = parseFloat(config.fixed_stop_loss_pct || 0.5) / 100.0;
      let slPrice = side === 'BUY' ? Math.round(price * (1 - slPct) * 100) / 100 : Math.round(price * (1 + slPct) * 100) / 100;

      log(`[MULTI-SNIPER] Opening concurrent trade on ${sym} (${activePositions.length + 1}/${maxActivePositions} slots). Executing ${side} ${qty} @ ~$${price}`, 'INFO');

      const orderRes = await bitunixRequest('POST', '/api/v1/futures/trade/place_order', null, {
        effect: 'GTC',
        orderType: 'MARKET',
        qty: String(qty),
        side: side,
        symbol: sym,
        tradeSide: 'OPEN',
        slPrice: String(slPrice),
        slOrderType: 'MARKET',
        slStopType: 'LAST_PRICE'
      }, true);

      if (orderRes && orderRes.code === 0) {
        currentActiveSymbols.add(sym);
        activePositions.push({ symbol: sym, qty: qty, avgOpenPrice: price, side: side });
        log(`[LIVE MULTI] Concurrent Order Placed: ${side} ${qty} ${sym}!`, 'SUCCESS');
        sendTelegramAlert(`⚡ *CONCURRENT MULTI-TRADE EXECUTED!*\n\n• *Coin:* ${sym} (${COIN_CONFIGS[sym].name})\n• *Action:* ${side} (Market)\n• *Size:* ${qty}\n• *Entry:* ~$${price}\n• *🛑 Fixed Stop:* $${slPrice} (-${config.fixed_stop_loss_pct}%)\n• *Active Positions:* ${activePositions.length}/${maxActivePositions} Slots In Play\n\n_Parallel multi-coin execution active!_`);
      }
    }
  }
}

async function closeSpecificPosition(p) {
  const side = p.side === 'LONG' || p.side === 'BUY' ? 'SELL' : 'BUY';
  await bitunixRequest('POST', '/api/v1/futures/trade/place_order', null, {
    effect: 'GTC',
    orderType: 'MARKET',
    positionId: String(p.positionId),
    qty: String(p.qty),
    side: side,
    symbol: p.symbol,
    tradeSide: 'CLOSE'
  }, true);
}

// Spot Autonomous Dip-Buyer & Seller Loop
async function spotTick() {
  if (!config.spot_auto_mode || !isRunning) return;

  try {
    const sAcc = await bitunixRequest('GET', '/api/spot/v1/user/account', null, null, true, true);
    if (!sAcc || sAcc.code !== '0' || !Array.isArray(sAcc.data)) return;
    spotBalance = sAcc.data;

    const usdtCoin = sAcc.data.find(c => c.coin === 'USDT');
    const usdtBal = usdtCoin ? parseFloat(usdtCoin.balance || 0) : 0;

    if (usdtBal >= 5.0) {
      for (const sym of ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']) {
        const scanner = multiCoinScanner[sym];
        if (scanner && scanner.rsi && scanner.rsi <= 30) {
          const buyAmount = "5";
          const baseCoin = sym.replace('USDT', '');
          log(`[SPOT AUTO-BUY] Extreme Dip on ${sym} (RSI: ${scanner.rsi})! Placing $${buyAmount} Spot Buy...`, 'INFO');

          const spotOrder = await bitunixRequest('POST', '/api/spot/v1/order/place_order', null, {
            symbol: sym,
            side: 2,
            type: 2,
            volume: buyAmount
          }, true, true);

          if (spotOrder && (spotOrder.code === 0 || spotOrder.code === '0')) {
            spotHoldings[baseCoin] = { buyPrice: scanner.price, buyTime: Date.now() };
            log(`[SPOT] Bought ${baseCoin} on Dip @ $${scanner.price}`, 'SUCCESS');
            sendTelegramAlert(`🟢 *SPOT AUTO-DIP BUY EXECUTED!*\n\n• *Coin:* ${baseCoin}\n• *Bought Amount:* $${buyAmount} USDT\n• *Buy Price:* ~$${scanner.price}\n• *Reason:* Extreme Oversold Dip (RSI: ${scanner.rsi})\n• *Target:* Dynamic Profit Exit\n\n_Zero Liquidation Risk on Spot!_`);
            break;
          }
        }
      }
    }

    for (const item of sAcc.data) {
      if (['BTC', 'ETH', 'SOL'].includes(item.coin) && parseFloat(item.balance || 0) > 0.0001) {
        const sym = `${item.coin}USDT`;
        const scanner = multiCoinScanner[sym];
        if (scanner && scanner.price) {
          // If we don't have recorded buy price, initialize with the bottom dip baseline
          if (!spotHoldings[item.coin]) {
            spotHoldings[item.coin] = { buyPrice: scanner.price, buyTime: Date.now() };
            log(`[SPOT DIP TRACKER] Monitoring ${item.balance} ${item.coin} @ dip price $${scanner.price}. Target sell on +1.2% bounce.`, 'INFO');
          }

          const buyP = spotHoldings[item.coin].buyPrice;
          const currP = scanner.price;
          const gainPct = ((currP - buyP) / buyP) * 100;

          // When coin rises +1.2% from bottom dip, sell for USDT profit!
          if (gainPct >= 1.2) {
            log(`[SPOT PROFIT EXIT] ${item.coin} bounced +${gainPct.toFixed(2)}%! Placing Spot Sell...`, 'SUCCESS');
            const sellRes = await bitunixRequest('POST', '/api/spot/v1/order/place_order', null, {
              symbol: sym,
              side: 1, // 1 = Sell
              type: 2, // 2 = Market
              volume: String(item.balance)
            }, true, true);

            if (sellRes && (sellRes.code === 0 || sellRes.code === '0')) {
              delete spotHoldings[item.coin];
              log(`[SPOT PROFIT LOCKED] Sold ${item.balance} ${item.coin} @ $${currP}!`, 'SUCCESS');
              sendTelegramAlert(`🎯 *SPOT PROFIT LOCKED!*\n\n• *Coin:* ${item.coin}\n• *Sold Amount:* ${item.balance} ${item.coin}\n• *Sold Price:* ~$${currP}\n• *Profit:* +${gainPct.toFixed(2)}% 💰\n\n_Spot USDT balance has increased!_`);
            }
          }
        }
      }
    }
  } catch (err) {}
}

async function masterTick() {
  await futuresTick();
  await spotTick();
}

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'templates', 'index.html')));
app.get('/manifest.json', (req, res) => res.sendFile(path.join(__dirname, 'templates', 'manifest.json')));
app.get('/sw.js', (req, res) => res.sendFile(path.join(__dirname, 'templates', 'sw.js')));
app.get('/icon.svg', (req, res) => res.sendFile(path.join(__dirname, 'templates', 'icon.svg')));

app.get('/api/status', async (req, res) => {
  let liveBal = null;
  let livePositions = [];
  try {
    const acc = await bitunixRequest('GET', '/api/v1/futures/account', { marginCoin: 'USDT' }, null, true);
    if (acc && acc.code === 0) {
      liveBal = acc.data;
      latestFuturesCash = parseFloat(acc.data.available || 9.95).toFixed(2);
    }
    const pos = await bitunixRequest('GET', '/api/v1/futures/position/get_pending_positions', null, null, true);
    if (pos && pos.code === 0 && Array.isArray(pos.data)) {
      livePositions = pos.data.filter(p => parseFloat(p.qty) > 0);
    }
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
    total_realized_today: totalRealizedProfitToday,
    logs: logs
  });
});

app.get('/api/config', (req, res) => res.json(config));
app.post('/api/config', (req, res) => {
  saveConfig(req.body);
  log("Configuration updated", "INFO");
  sendTelegramAlert(`⚙️ *Strategy Settings Updated*\n\n• *Mode:* Dynamic Uncapped Profit Runner 🚀\n• *TP (Take Profit):* Open / No 1% Limit (Runs as far as trend goes!)\n• *SL (Stop Loss):* -${config.fixed_stop_loss_pct}% (Strict Tiny Loss Cut)\n• *Multi-Coin Scanner:* ${config.multi_coin_mode ? 'ACTIVE (5 Coins)' : 'OFF'}\n• *Spot Dip-Buyer:* ${config.spot_auto_mode ? 'ACTIVE' : 'OFF'}`);
  res.json({ code: 0, msg: "Saved" });
});

app.post('/api/start', (req, res) => {
  isRunning = true;
  log("Bot Started", "INFO");
  sendTelegramAlert("🟢 *Strategic Bot Started!* Uncapped Profit Runner active on 5 markets.");
  res.json({ code: 0 });
});

app.post('/api/stop', (req, res) => {
  isRunning = false;
  log("Bot Stopped", "INFO");
  sendTelegramAlert("🛑 *Bot Stopped!* Auto-Trading paused.");
  res.json({ code: 0 });
});

app.post('/api/close_position', async (req, res) => {
  const pos = await bitunixRequest('GET', '/api/v1/futures/position/get_pending_positions', null, null, true);
  if (pos && pos.code === 0 && Array.isArray(pos.data)) {
    for (const p of pos.data) {
      if (parseFloat(p.qty) > 0) {
        await closeSpecificPosition(p);
      }
    }
    log("All positions manually closed", "INFO");
    sendTelegramAlert("✋ *All positions manually closed via Dashboard*");
    return res.json({ code: 0, msg: "Closed" });
  }
  res.json({ code: -1, msg: "No active position" });
});

setInterval(() => {
  masterTick().catch(e => console.error("Tick error:", e));
}, 5000);

app.listen(PORT, () => {
  log(`Bitunix Strategic Uncapped Profit Engine running on port ${PORT}`, 'SUCCESS');
  masterTick();
});
