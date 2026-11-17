const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(express.json());

app.use(express.urlencoded({ extended: false }));

// Dashboard login. Without DASHBOARD_PASSWORD the dashboard stays locked.
const OPEN_PATHS = new Set(['/manifest.json', '/sw.js', '/icon.svg', '/robots.txt', '/login', '/health']);
const SESSION_COOKIE = 'bx_session';
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}
function sessionToken(password) {
  return crypto.createHmac('sha256', password).update('bitunix-dashboard-session-v1').digest('hex');
}
function readCookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0 && part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim();
  }
  return '';
}
function isLoggedIn(req, password) {
  const cookie = readCookie(req, SESSION_COOKIE);
  if (cookie && safeEqual(cookie, sessionToken(password))) return true;
  const header = req.headers.authorization || '';
  if (header.startsWith('Basic ')) {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf-8');
    if (safeEqual(decoded.slice(decoded.indexOf(':') + 1), password)) return true;
  }
  return false;
}
function loginPage(message) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Login - Bitunix Trader</title>
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0b0e14;color:#e2e8f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}
form{width:min(340px,calc(100vw - 32px));background:#121722;border:1px solid #1e2634;border-radius:12px;padding:24px;box-sizing:border-box}
h1{font-size:18px;margin:0 0 16px}
input{width:100%;box-sizing:border-box;padding:12px;border-radius:8px;border:1px solid #2d3748;background:#0b0e14;color:#e2e8f0;font-size:16px}
button{width:100%;margin-top:12px;padding:12px;border:0;border-radius:8px;background:#00d68f;color:#000;font-weight:700;font-size:16px}
p{color:#f6465d;font-size:14px;margin:12px 0 0}
</style></head><body>
<form method="POST" action="/login">
<h1>Bitunix Trader</h1>
<input type="password" id="pw" name="password" placeholder="Password" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" autofocus required>
<label style="display:flex;align-items:center;gap:8px;margin-top:10px;font-size:14px;color:#94a3b8"><input type="checkbox" style="width:auto" onclick="document.getElementById('pw').type=this.checked?'text':'password'"> Show password</label>
<button type="submit">Login</button>
${message ? `<p>${message}</p>` : ''}
</form></body></html>`;
}

app.get('/login', (req, res) => {
  const password = (process.env.DASHBOARD_PASSWORD || '').trim();
  if (!password) return res.status(503).send(loginPage('Dashboard locked: DASHBOARD_PASSWORD is not set on the server.'));
  if (isLoggedIn(req, password)) return res.redirect('/');
  // Drop any old cached pages / service worker a phone may still hold from earlier versions
  res.setHeader('Clear-Site-Data', '"cache", "storage"');
  res.setHeader('Cache-Control', 'no-store');
  res.send(loginPage(''));
});

app.post('/login', async (req, res) => {
  const password = (process.env.DASHBOARD_PASSWORD || '').trim();
  if (!password) return res.status(503).send(loginPage('Dashboard locked: DASHBOARD_PASSWORD is not set on the server.'));
  const given = String((req.body && req.body.password) || '').trim();
  if (!safeEqual(given, password)) {
    await new Promise(r => setTimeout(r, 1500)); // slow down guessing
    return res.status(401).send(loginPage('Wrong password'));
  }
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${sessionToken(password)}; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax`);
  res.redirect('/');
});

app.get('/logout', (req, res) => {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`);
  res.redirect('/login');
});

app.use((req, res, next) => {
  if (OPEN_PATHS.has(req.path)) return next();
  const password = (process.env.DASHBOARD_PASSWORD || '').trim();
  if (!password) {
    return res.status(503).type('text/plain').send('Dashboard locked: set DASHBOARD_PASSWORD in the hosting environment variables.');
  }
  if (isLoggedIn(req, password)) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ code: 401, msg: 'Login required' });
  res.redirect('/login');
});

app.use(express.static(path.join(__dirname, 'templates'), { index: false }));

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
    api_key: "",
    secret_key: "",
    symbol: "BTCUSDT",
    multi_coin_mode: true,
    spot_auto_mode: true,
    spot_tp_pct: 5,               // sell a spot coin when it is this % above its buy price
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
    telegram_bot_token: "",
    telegram_chat_id: "",
    today_profit: 0.0,
    daily_goal: 4.0,
    max_concurrent_positions: 1,
    taker_fee_pct: 0.06,          // exchange fee per side, % of position size
    take_profit_net_pct: 15.0,    // start trailing profit at this % of margin AFTER fees
    trailing_drop_net_pct: 5.0,   // then close when profit falls this far from its peak
    protect_arm_net_pct: 10.0,    // once profit has reached this...
    protect_floor_net_pct: 3.0,   // ...never let it fall below this: close and keep the gain
    stop_loss_margin_pct: 30.0,   // give a trade room: cut a loser only at this % of margin
    min_confidence: 85,           // skip the weakest signals (plain EMA-cross state)
    futures_trading: false,       // open new futures trades? (open ones are still managed)
    spot_trading: true,           // buy and sell spot coins on signals
    spot_order_usdt: 11,          // USDT per spot buy (Bitunix minimum is 10)
    spot_max_positions: 3,        // at most this many coins bought by the bot at once
    spot_fee_pct: 0.1,            // spot fee per side, %
    spot_trail_start_pct: 2,      // after fees: start trailing once profit reaches this
    spot_trail_drop_pct: 0.7,     // then sell when profit falls this far from its best
    spot_protect_arm_pct: 1,      // once profit reached this...
    spot_protect_floor_pct: 0.3,  // ...sell before it drops below this
    spot_stop_pct: 3,             // sell a losing coin at this % below the buy price
    spot_site_min_score: 25,      // MHD Trade site score needed to buy (25 = Buy, 60 = Strong Buy)
    strategy_version: 5,
    max_daily_loss_usd: 1.5       // stop opening new trades after losing this much in a day
  };
  let cfg = defaultCfg;
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      const data = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
      cfg = { ...defaultCfg, ...data };
      // Settings saved by an older strategy version would undo the tested exit rules
      if (data.strategy_version !== defaultCfg.strategy_version) {
        for (const k of ['take_profit_net_pct', 'trailing_drop_net_pct', 'protect_arm_net_pct', 'protect_floor_net_pct',
          'stop_loss_margin_pct', 'min_confidence', 'spot_tp_pct', 'futures_trading', 'spot_trading', 'spot_order_usdt',
          'spot_max_positions', 'spot_trail_start_pct', 'spot_trail_drop_pct', 'spot_protect_arm_pct', 'spot_protect_floor_pct',
          'spot_stop_pct', 'strategy_version']) cfg[k] = defaultCfg[k];
      }
    } catch (e) {
      console.error("Config read error:", e);
    }
  }
  return { ...cfg, ...secretsFromEnv() };
}

// Secrets live ONLY in environment variables (hosting panel), never in git or config.json
const SECRET_FIELDS = ['api_key', 'secret_key', 'telegram_bot_token'];
function secretsFromEnv() {
  return {
    api_key: process.env.BITUNIX_API_KEY || "",
    secret_key: process.env.BITUNIX_SECRET_KEY || "",
    telegram_bot_token: process.env.TELEGRAM_BOT_TOKEN || "",
    telegram_chat_id: process.env.TELEGRAM_CHAT_ID || ""
  };
}

// Settings the dashboard is allowed to change
const EDITABLE_FIELDS = ['symbol', 'multi_coin_mode', 'spot_auto_mode', 'spot_tp_pct', 'interval', 'order_qty',
  'futures_trading', 'spot_trading', 'spot_order_usdt', 'spot_max_positions', 'spot_stop_pct',
  'leverage', 'fixed_stop_loss_pct', 'daily_goal', 'max_concurrent_positions',
  'taker_fee_pct', 'take_profit_net_pct', 'trailing_drop_net_pct', 'protect_arm_net_pct', 'protect_floor_net_pct',
  'stop_loss_margin_pct', 'min_confidence', 'max_daily_loss_usd'];

// Config as shown to the browser: secrets replaced by a set / not-set flag
function publicConfig() {
  const out = { ...config };
  for (const f of SECRET_FIELDS) out[f] = config[f] ? 'SET' : '';
  delete out.telegram_chat_id;
  return out;
}

let config = loadConfig();

function saveConfig(newCfg) {
  const allowed = {};
  for (const f of EDITABLE_FIELDS) {
    if (newCfg && Object.prototype.hasOwnProperty.call(newCfg, f)) allowed[f] = newCfg[f];
  }
  config = { ...config, ...allowed };
  try {
    const toDisk = { ...config };
    for (const f of [...SECRET_FIELDS, 'telegram_chat_id']) delete toDisk[f];
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(toDisk, null, 2), 'utf-8');
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

// Running flag and leader lock live in files outside the app folder, so that
// (a) Stop survives restarts and redeploys, and (b) if the host starts several
// copies of this app, they all obey the same Stop and only one of them trades.
const os = require('os');
const STATE_DIR = (() => {
  for (const dir of [os.homedir(), __dirname, os.tmpdir()]) {
    try { fs.accessSync(dir, fs.constants.W_OK); return dir; } catch (e) {}
  }
  return __dirname;
})();
const STATE_PATH = path.join(STATE_DIR, '.bitunix-trader-state.json');
const LEADER_PATH = path.join(STATE_DIR, '.bitunix-trader-leader.json');
const SPOT_PATH = path.join(STATE_DIR, '.bitunix-trader-spot.json');
const TRACKERS_PATH = path.join(STATE_DIR, '.bitunix-trader-positions.json');
function saveTrackers() {
  try { fs.writeFileSync(TRACKERS_PATH, JSON.stringify(positionTrackers), 'utf-8'); } catch (e) {}
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch (e) { return null; }
}
function readRunning() {
  const st = readJson(STATE_PATH);
  return st && typeof st.running === 'boolean' ? st.running : true;
}
let lastControl = null; // last Start/Stop press, shown on /health
function writeRunning(value) {
  const body = JSON.stringify({ running: value, at: new Date().toISOString() });
  try {
    const tmp = STATE_PATH + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, body, 'utf-8');
    fs.renameSync(tmp, STATE_PATH);
    const back = readJson(STATE_PATH);
    const ok = !!back && back.running === value;
    lastControl = { action: value ? 'start' : 'stop', at: new Date().toISOString(), saved: ok, error: ok ? null : 'saved file did not read back' };
    return ok;
  } catch (e) {
    console.error('State save error:', e.message);
    lastControl = { action: value ? 'start' : 'stop', at: new Date().toISOString(), saved: false, error: String(e.code || e.message).slice(0, 60) };
    return false;
  }
}
// Only the process holding a fresh leader lock may place or close orders.
let isLeader = false;
// Each running copy gets a unique id and its start time. The NEWEST copy always takes
// the lock and the others stand by. This stops old copies left behind by redeploys
// from trading with old code (or ignoring Stop).
const INSTANCE_ID = crypto.randomBytes(8).toString('hex');
const INSTANCE_STARTED = Date.now();
function claimLeadership() {
  const now = Date.now();
  const cur = readJson(LEADER_PATH);
  const curStarted = cur && typeof cur.started === 'number' ? cur.started : 0; // old versions wrote no start time
  if (cur && cur.id && cur.id !== INSTANCE_ID && curStarted > INSTANCE_STARTED && now - cur.at <= 20000) {
    // A newer copy is trading. Stay on standby (the host restarts copies that exit,
    // which would make them fight for the lock forever).
    isLeader = false;
    return false;
  }
  try { fs.writeFileSync(LEADER_PATH, JSON.stringify({ id: INSTANCE_ID, started: INSTANCE_STARTED, pid: process.pid, at: now }), 'utf-8'); } catch (e) {}
  const check = readJson(LEADER_PATH);
  isLeader = !check || check.id === INSTANCE_ID;
  return isLeader;
}

// State
let isRunning = readRunning();
let logs = [];
let currentTicker = { last: '65500', high: '69000', low: '64800' };
let currentIndicators = {};
let lastSignal = { signal: 'HOLD', reason: 'Scanning multi-coin market...', confidence: 0 };
let multiCoinScanner = {};
let spotBalance = null;
let spotHoldings = readJson(SPOT_PATH) || {}; // coin -> { buyPrice }, kept on disk so restarts do not lose it
let spotSellRetryAt = {};
const SPOT_COINS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE'];
const SPOT_BASE_PRECISION = { BTC: 5, ETH: 4, SOL: 3, XRP: 1, DOGE: 0 }; // from /api/spot/v1/common/coin_pair/list
let spotDay = null, spotRealizedToday = 0, lastSpotBuyAt = 0, spotCoolUntil = {};
function floorTo(x, decimals) { const f = Math.pow(10, decimals); return Math.floor(x * f + 1e-9) / f; }
function saveSpotHoldings() {
  try { fs.writeFileSync(SPOT_PATH, JSON.stringify(spotHoldings), 'utf-8'); } catch (e) { console.error('Spot state save error:', e.message); }
}
// Spot wallet as shown on the dashboard
function spotSummary() {
  const target = parseFloat(config.spot_tp_pct || 5);
  return (spotBalance || []).map(item => {
    const balance = parseFloat(item.balance || 0);
    if (item.coin === 'USDT') return { coin: 'USDT', balance: item.balance, price: 1, value: balance, tradable: false };
    const scanner = multiCoinScanner[`${item.coin}USDT`];
    const price = scanner && scanner.price ? scanner.price : 0;
    const rec = spotHoldings[item.coin] || {};
    const buyPrice = parseFloat(rec.buyPrice || 0);
    return {
      source: rec.source === 'bot' ? 'bot' : (buyPrice > 0 ? 'manual' : 'unknown'),
      bot_qty: rec.qty || null,
      stop_price: rec.source === 'bot' ? buyPrice * (1 - parseFloat(config.spot_stop_pct || 3) / 100) : null,
      coin: item.coin,
      balance: item.balance,
      price: price,
      value: balance * price,
      tradable: SPOT_COINS.includes(item.coin),
      buy_price: buyPrice,
      change_pct: buyPrice > 0 && price > 0 ? ((price - buyPrice) / buyPrice) * 100 : 0,
      target_pct: target
    };
  }).filter(h => parseFloat(h.balance || 0) > 0);
}
let positionTrackers = readJson(TRACKERS_PATH) || {}; // survives restarts
let totalRealizedProfitToday = 0.0;
let latestFuturesCash = "9.95";
let scanTickCount = 0;

// Risk guard state
let dayKey = null;            // current trading day (Pakistan time)
let dayStartEquity = null;    // futures equity at the start of the day
let dailyPnl = 0;             // real change in futures equity today (fees included)
let guardReason = null;       // 'loss' | 'goal' | null — when set, no new trades are opened
let lastEntryAt = 0;          // time of the last opened trade
let symbolCooldownUntil = {}; // symbol -> time before which it is not traded again

function tradingDay() {
  return new Date(Date.now() + 5 * 3600 * 1000).toISOString().slice(0, 10);
}

// Measures today's real result from the futures wallet itself, so fees and
// exchange-side stop-losses are counted too.
async function updateDailyGuard() {
  const acc = await bitunixRequest('GET', '/api/v1/futures/account', { marginCoin: 'USDT' }, null, true);
  if (!acc || acc.code !== 0 || !acc.data) return null;
  const d = acc.data;
  const num = (v) => parseFloat(v || 0) || 0;
  const equity = num(d.available) + num(d.frozen) + num(d.margin) + num(d.crossUnrealizedPNL) + num(d.isolationUnrealizedPNL);

  const today = tradingDay();
  if (dayKey !== today || dayStartEquity === null) {
    dayKey = today;
    dayStartEquity = equity;
    guardReason = null;
    log(`[DAILY GUARD] New baseline: $${equity.toFixed(2)} futures equity`, 'INFO');
  }
  dailyPnl = equity - dayStartEquity;

  const maxLoss = parseFloat(config.max_daily_loss_usd || 1.5);
  const goal = parseFloat(config.daily_goal || 4);
  let reason = null;
  if (dailyPnl <= -maxLoss) reason = 'loss';
  else if (dailyPnl >= goal) reason = 'goal';

  if (reason && guardReason !== reason) {
    if (reason === 'loss') {
      log(`[DAILY GUARD] Loss limit hit ($${dailyPnl.toFixed(2)}). No new trades today.`, 'WARNING');
      sendTelegramAlert(`🛑 *Daily loss limit reached*\n\nToday: $${dailyPnl.toFixed(2)} USDT\nNo new trades until tomorrow. Open positions are still managed.`);
    } else {
      log(`[DAILY GUARD] Daily goal reached (+$${dailyPnl.toFixed(2)}). No new trades today.`, 'SUCCESS');
      sendTelegramAlert(`🎯 *Daily goal reached*\n\nToday: +$${dailyPnl.toFixed(2)} USDT\nNo new trades until tomorrow, profit is kept.`);
    }
  }
  guardReason = reason;
  return num(d.available);
}

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
      const kRes = await bitunixRequest('GET', '/api/v1/futures/market/kline', { symbol: sym, interval: interval, limit: sym === (config.symbol || 'BTCUSDT') ? 120 : 50 });
      if (!kRes || kRes.code !== 0 || !Array.isArray(kRes.data) || kRes.data.length < 20) return null;

      const allSorted = [...kRes.data].sort((a, b) => parseInt(a.time) - parseInt(b.time));
      const sorted = allSorted.slice(-50); // signals use exactly the last 50 candles (as tested)
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

      // Market trend detection
      const isBearMarket = (cEma9 < cEma21 && cEma21 < cEma50); // All EMAs stacked bearish
      const isBullMarket = (cEma9 > cEma21 && cEma21 > cEma50); // All EMAs stacked bullish

      // RSI bounce signals — adaptive thresholds
      const oversoldLevel = isBearMarket ? 32 : 36;   // In bear market, wait deeper
      const overboughtLevel = isBullMarket ? 68 : 64; // In bull market, wait higher

      const isOversold  = (currRsi <= oversoldLevel && currRsi > prevRsi);   // RSI turning UP from bottom
      const isOverbought = (currRsi >= overboughtLevel && currRsi < prevRsi); // RSI turning DOWN from top

      // EMA cross signals
      const isBullCross = (cEma9 > cEma21 && currRsi >= 40 && currRsi <= 62 && latestPrice >= cEma21);
      const isBearCross = (cEma9 < cEma21 && currRsi <= 60 && currRsi >= 38 && latestPrice <= cEma21);

      // Bear market momentum SHORT — most profitable in current conditions!
      // If EMA9 < EMA21 < EMA50 and RSI is falling from mid-zone → strong SHORT
      const isBearMomentum = (isBearMarket && currRsi >= 38 && currRsi <= 55 && currRsi < prevRsi && latestPrice < cEma9);

      // Bull market momentum LONG
      const isBullMomentum = (isBullMarket && currRsi >= 45 && currRsi <= 62 && currRsi > prevRsi && latestPrice > cEma9);

      if (isOversold && !isBearMarket) {
        // Oversold bounce BUY — only valid when NOT in full bear trend
        sig = 'BUY';
        reason = `Oversold Bounce (RSI: ${currRsi} turning up)`;
        confidence = 88;
      } else if (isOverbought && !isBullMarket) {
        // Overbought rejection SELL — only valid when NOT in full bull trend
        sig = 'SELL';
        reason = `Overbought Rejection (RSI: ${currRsi} turning down)`;
        confidence = 88;
      } else if (isBearMomentum) {
        // Bear market momentum SHORT — ride the downtrend!
        sig = 'SELL';
        reason = `Bear Momentum SHORT (EMA bearish stack, RSI: ${currRsi})`;
        confidence = 85;
      } else if (isBullMomentum) {
        // Bull market momentum LONG
        sig = 'BUY';
        reason = `Bull Momentum LONG (EMA bullish stack, RSI: ${currRsi})`;
        confidence = 85;
      } else if (isBullCross) {
        sig = 'BUY';
        reason = `Bullish EMA Cross (EMA9>21, RSI: ${currRsi})`;
        confidence = 80;
      } else if (isBearCross) {
        sig = 'SELL';
        reason = `Bearish EMA Cross (EMA9<21, RSI: ${currRsi})`;
        confidence = 80;
      }

      // Only trade in the direction of the 1-hour trend
      const trend = await hourlyTrend(sym, latestPrice);
      if (sig !== 'HOLD' && trend !== (sig === 'BUY' ? 1 : -1)) {
        reason = `${sig} signal skipped: 1h trend is ${trend === 1 ? 'up' : trend === -1 ? 'down' : 'flat'}`;
        sig = 'HOLD';
        confidence = 40;
      }

      // Weak signals are not traded; show them as Wait so the screen matches what the bot does
      const minConf = parseFloat(config.min_confidence ?? 85);
      if (sig !== 'HOLD' && confidence < minConf) {
        reason = `${sig} signal too weak (${reason}), waiting for a stronger one`;
        sig = 'HOLD';
        confidence = 40;
      }

      multiCoinScanner[sym] = {
        symbol: sym,
        trend: trend,
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
          candles: allSorted.map(s => ({
            time: parseInt(s.time),
            open: parseFloat(s.open),
            high: parseFloat(s.high),
            low: parseFloat(s.low),
            close: parseFloat(s.close)
          }))
        };
        lastSignal = { signal: sig, reason: reason, confidence: confidence };
      }

      if (confidence >= parseFloat(config.min_confidence ?? 85) && (sig === 'BUY' || sig === 'SELL')) {
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
  health.apiOk = !!(posRes && posRes.code === 0);
  if (health.apiOk) lastPositionCount = activePositions.length;
  else if (posRes && scanTickCount % 12 === 0) log(`[EXCHANGE] Position check failed: ${posRes.code} ${posRes.msg}`, 'ERROR');

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
      if (trk) symbolCooldownUntil[trk.symbol] = Date.now() + 10 * 60 * 1000; // closed by the exchange stop: rest this coin
      delete positionTrackers[id];
    }
  }

  const availableNow = await updateDailyGuard();

  // Position management. Profit and loss are judged AFTER exchange fees, so a "win" is a real win.
  const feeRate = parseFloat(config.taker_fee_pct ?? 0.06) / 100;
  const tpNetPct = parseFloat(config.take_profit_net_pct ?? 15);
  const trailDropPct = parseFloat(config.trailing_drop_net_pct ?? 5);
  const protectArmPct = parseFloat(config.protect_arm_net_pct ?? 10);
  const protectFloorPct = parseFloat(config.protect_floor_net_pct ?? 3);
  const slMarginPct = parseFloat(config.stop_loss_margin_pct ?? 30);

  for (const pos of activePositions) {
    const posId = String(pos.positionId);
    const entryPrice = parseFloat(pos.avgOpenPrice || 0);
    const pnlUsd = parseFloat(pos.unrealizedPNL || 0);
    const marginUsd = parseFloat(pos.margin || 1.8);
    const feesUsd = parseFloat(pos.qty || 0) * entryPrice * feeRate * 2; // open + close
    const netUsd = pnlUsd - feesUsd;
    const grossPct = marginUsd > 0 ? (pnlUsd / marginUsd) * 100 : 0;
    const netPct = marginUsd > 0 ? (netUsd / marginUsd) * 100 : 0;

    if (!positionTrackers[posId]) {
      positionTrackers[posId] = {
        symbol: pos.symbol,
        entryPrice: entryPrice,
        side: pos.side,
        maxNetPct: netPct,
        closedNotified: false
      };
    }
    const tracker = positionTrackers[posId];
    if (netPct > tracker.maxNetPct) tracker.maxNetPct = netPct;

    // 1. Stop loss
    if (grossPct <= -slMarginPct) {
      log(`[STOP LOSS] ${pos.symbol} ${grossPct.toFixed(2)}% of margin (net -$${Math.abs(netUsd).toFixed(4)} after fees). Closing.`, 'WARNING');
      tracker.closedNotified = true;
      await closeSpecificPosition(pos);
      delete positionTrackers[posId];
      symbolCooldownUntil[pos.symbol] = Date.now() + 15 * 60 * 1000;
      sendTelegramAlert(`🛑 *Stop loss* ${pos.symbol}\nResult after fees: -$${Math.abs(netUsd).toFixed(4)} USDT\nThis coin rests for 15 minutes.`);
      continue;
    }

    // 2. Take profit: once net profit passes the target, let it run and close when it
    //    falls back from its peak (or close at once if profit riding is off).
    if (tracker.maxNetPct >= tpNetPct) {
      const ride = config.dynamic_profit_ride !== false;
      if (!ride || netPct <= tracker.maxNetPct - trailDropPct) {
        log(`[PROFIT LOCK] ${pos.symbol} net +$${netUsd.toFixed(4)} (+${netPct.toFixed(2)}% of margin after fees, peak ${tracker.maxNetPct.toFixed(2)}%). Closing.`, 'SUCCESS');
        tracker.closedNotified = true;
        await closeSpecificPosition(pos);
        totalRealizedProfitToday += netUsd;
        delete positionTrackers[posId];
        sendTelegramAlert(`💰 *Profit locked* ${pos.symbol}\nNet after fees: +$${netUsd.toFixed(4)} USDT (+${netPct.toFixed(2)}% of margin)\nEntry: $${entryPrice}`);
        continue;
      }
    } else if (protectArmPct > 0 && tracker.maxNetPct >= protectArmPct && netPct <= protectFloorPct) {
      // 3. Profit was good and is now falling back: close while it is still a gain
      log(`[PROFIT PROTECT] ${pos.symbol} fell from +${tracker.maxNetPct.toFixed(2)}% to +${netPct.toFixed(2)}% of margin. Closing with net $${netUsd.toFixed(4)}.`, 'SUCCESS');
      tracker.closedNotified = true;
      await closeSpecificPosition(pos);
      totalRealizedProfitToday += netUsd;
      delete positionTrackers[posId];
      sendTelegramAlert(`🛡️ *Profit protected* ${pos.symbol}\nProfit was falling, closed with net $${netUsd.toFixed(4)} USDT after fees.`);
      continue;
    }
  }

  saveTrackers(); // keep each trade's best profit across restarts, so trailing exits stay correct

  // 3. Multi-Coin Concurrent Trades (Up to 3 Simultaneous Positions on Distinct Coins)
  const maxActivePositions = parseInt(config.max_concurrent_positions || 1);
  const currentActiveSymbols = new Set(activePositions.map(p => p.symbol));

  const entryCooldownOver = Date.now() - lastEntryAt >= 60 * 1000; // exchange needs a moment to list a new position
  const futuresOn = config.futures_trading === true;
  if (futuresOn && isRunning && !guardReason && entryCooldownOver && activePositions.length < maxActivePositions && candidates.length > 0) {
    for (const opp of candidates) {
      if (activePositions.length >= maxActivePositions) break;
      if (currentActiveSymbols.has(opp.symbol)) continue; // Never duplicate position on same coin
      if ((symbolCooldownUntil[opp.symbol] || 0) > Date.now()) continue; // resting after a loss

      const sym = opp.symbol;
      const side = opp.signal;
      const price = opp.price;
      const qty = opp.qty;

      const slPct = exchangeStopPct();
      const slPrice = stopLossPrice(side, price, slPct);

      const needMargin = (parseFloat(qty) * price) / parseFloat(config.leverage || 10);
      const haveMargin = availableNow;
      if (haveMargin !== null && haveMargin < needMargin * 1.05) {
        if (scanTickCount % 12 === 0) {
          log(`[SKIP] ${sym} ${side}: needs ~$${needMargin.toFixed(2)} margin, futures wallet has $${haveMargin.toFixed(2)}`, 'WARNING');
        }
        continue;
      }

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
        lastEntryAt = Date.now();
        health.lastOrderAt = new Date().toISOString();
        health.lastOrderError = null;
        currentActiveSymbols.add(sym);
        activePositions.push({ symbol: sym, qty: qty, avgOpenPrice: price, side: side });
        log(`[LIVE MULTI] Concurrent Order Placed: ${side} ${qty} ${sym}!`, 'SUCCESS');
        sendTelegramAlert(`⚡ *CONCURRENT MULTI-TRADE EXECUTED!*\n\n• *Coin:* ${sym} (${COIN_CONFIGS[sym].name})\n• *Action:* ${side} (Market)\n• *Size:* ${qty}\n• *Entry:* ~$${price}\n• *🛑 Fixed Stop:* $${slPrice} (-${config.fixed_stop_loss_pct}%)\n• *Active Positions:* ${activePositions.length}/${maxActivePositions} Slots In Play\n\n_Parallel multi-coin execution active!_`);
      } else {
        log(`[ORDER FAILED] ${side} ${qty} ${sym}: ${orderRes ? `${orderRes.code} ${orderRes.msg}` : 'no response'}`, 'ERROR');
        health.lastOrderError = { at: new Date().toISOString(), code: orderRes ? orderRes.code : null, msg: orderRes ? String(orderRes.msg).slice(0, 120) : 'no response' };
      }
    }
  }
}

// Stop-loss price rounded to the same number of decimals as the coin's own price,
// so cheap coins (DOGE, XRP) do not get rounded past the entry price.
function stopLossPrice(side, price, slPct) {
  const text = String(price);
  const decimals = text.includes('.') ? text.split('.')[1].length : 0;
  const factor = Math.pow(10, decimals);
  const raw = side === 'BUY' ? price * (1 - slPct) : price * (1 + slPct);
  // Round away from the entry so the stop is never on the wrong side of the price
  const rounded = side === 'BUY' ? Math.floor(raw * factor) / factor : Math.ceil(raw * factor) / factor;
  return Number(rounded.toFixed(decimals));
}

// Price distance for the stop order placed on the exchange. It is a backup for when
// the bot is offline, so it sits 1.5x further away than the bot's own stop loss.
function exchangeStopPct() {
  const configured = parseFloat(config.fixed_stop_loss_pct || 0.5) / 100;
  const botStop = parseFloat(config.stop_loss_margin_pct ?? 30) / 100 / parseFloat(config.leverage || 10);
  return Math.max(configured, botStop * 1.5);
}

// 1-hour trend for a coin: +1 up, -1 down, 0 flat/unknown. Trades are only taken with it.
// Score from the MHD Trade signals site (signals.malikhammaddigital.com), same engine file.
// +25 or more = the site shows Buy, +60 = Strong Buy. Refreshed every 5 minutes per coin.
require('./signal-engine.js');
const TA = globalThis.TA;
const siteScores = {}; // sym -> { at, score, label }
async function refreshSiteScore(sym) {
  const cached = siteScores[sym];
  if (cached && Date.now() - cached.at < 5 * 60 * 1000) return cached;
  const rows = {};
  let end = Date.now();
  for (let page = 0; page < 2; page++) {
    const res = await bitunixRequest('GET', '/api/v1/futures/market/kline', { symbol: sym, interval: '1h', limit: 200, endTime: end });
    if (!res || res.code !== 0 || !Array.isArray(res.data) || !res.data.length) break;
    for (const c of res.data) rows[c.time] = { time: parseInt(c.time), open: +c.open, high: +c.high, low: +c.low, close: +c.close, volume: +(c.baseVol || 0) };
    end = Math.min(...res.data.map(c => parseInt(c.time))) - 1;
  }
  const candles = Object.values(rows).sort((a, b) => a.time - b.time).slice(0, -1); // closed candles only
  if (candles.length < 210) return cached || null;
  const a = TA.analyze(candles);
  siteScores[sym] = { at: Date.now(), score: a.score, label: a.label };
  return siteScores[sym];
}

const hourlyCache = {};
async function hourlyTrend(sym, price) {
  const cached = hourlyCache[sym];
  if (!cached || Date.now() - cached.at > 60 * 1000) {
    const res = await bitunixRequest('GET', '/api/v1/futures/market/kline', { symbol: sym, interval: '1h', limit: 61 });
    if (res && res.code === 0 && Array.isArray(res.data) && res.data.length >= 61) {
      const sorted = [...res.data].sort((a, b) => parseInt(a.time) - parseInt(b.time));
      hourlyCache[sym] = { at: Date.now(), closes: sorted.slice(0, -1).map(c => parseFloat(c.close)) };
    } else if (!cached) {
      return 0;
    }
  }
  const hist = [...hourlyCache[sym].closes, price];
  const e = calculateEMA(hist, 50);
  const last = e[e.length - 1];
  const before = e[e.length - 1 - 5];
  if (price > last && last > before) return 1;
  if (price < last && last < before) return -1;
  return 0;
}

async function futuresAvailable() {
  const acc = await bitunixRequest('GET', '/api/v1/futures/account', { marginCoin: 'USDT' }, null, true);
  if (acc && acc.code === 0 && acc.data) return parseFloat(acc.data.available || 0);
  return null;
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

// Spot trading. Buys only on a Buy signal that agrees with the 1-hour uptrend
// (the same filtered signals the dashboard shows), sells on the exit rules below.
// Coins the owner bought themselves are only sold at their own target, never at a loss.
async function spotOrder(sym, side, volume) {
  return bitunixRequest('POST', '/api/spot/v1/order/place_order', null, {
    symbol: sym,
    side: side,          // 1 = sell, 2 = buy
    type: 2,             // market
    volume: String(volume),
    price: '0'
  }, true, true);
}

// Average fill price and quantity of a spot order (null if the exchange does not say)
async function spotFill(sym, orderId) {
  if (!orderId) return null;
  await new Promise(r => setTimeout(r, 1500));
  const res = await bitunixRequest('POST', '/api/spot/v1/order/deal/list', null, { orderId: String(orderId), symbol: sym }, true, true);
  const rows = res && (res.code === 0 || res.code === '0') ? (Array.isArray(res.data) ? res.data : res.data ? [res.data] : []) : [];
  let qty = 0, quote = 0;
  for (const r of rows) {
    const v = parseFloat(r.volume || 0), pr = parseFloat(r.price || 0);
    if (v > 0 && pr > 0) { qty += v; quote += v * pr; }
  }
  return qty > 0 ? { qty, price: quote / qty } : null;
}

async function sellSpot(item, sym, price, qty, why, netPct) {
  const prec = SPOT_BASE_PRECISION[item.coin] ?? 4;
  const vol = floorTo(qty, prec);
  if (!(vol > 0) || vol * price < 10) {
    log(`[SPOT] ${item.coin}: amount $${(vol * price).toFixed(2)} is below Bitunix's $10 minimum, cannot sell yet.`, 'WARNING');
    spotSellRetryAt[item.coin] = Date.now() + 30 * 60 * 1000;
    return false;
  }
  const res = await spotOrder(sym, 1, vol);
  if (!(res && (res.code === 0 || res.code === '0'))) {
    spotSellRetryAt[item.coin] = Date.now() + 5 * 60 * 1000;
    log(`[SPOT SELL FAILED] ${item.coin}: ${res ? `${res.code} ${res.msg}` : 'no response'}. Retrying in 5 minutes.`, 'ERROR');
    return false;
  }
  const rec = spotHoldings[item.coin] || {};
  const fill = await spotFill(sym, res.data && res.data.orderId);
  const sellPrice = fill ? fill.price : price;
  const buyPrice = parseFloat(rec.buyPrice || 0);
  const fee = parseFloat(config.spot_fee_pct ?? 0.1) / 100;
  const pnl = buyPrice > 0 ? (sellPrice - buyPrice) * vol - (sellPrice + buyPrice) * vol * fee : 0;
  if (rec.source === 'bot') spotRealizedToday += pnl;
  delete spotHoldings[item.coin];
  saveSpotHoldings();
  if (why === 'stop') spotCoolUntil[item.coin] = Date.now() + 30 * 60 * 1000;
  const label = why === 'stop' ? 'Stop loss' : why === 'protect' ? 'Profit protected' : why === 'target' ? 'Target reached' : 'Profit taken';
  log(`[SPOT SELL] ${label}: sold ${vol} ${item.coin} @ ~$${Number(sellPrice.toPrecision(6))} (${netPct >= 0 ? '+' : ''}${netPct.toFixed(2)}% after fees, ${pnl >= 0 ? '+' : '-'}$${Math.abs(pnl).toFixed(3)})`, why === 'stop' ? 'WARNING' : 'SUCCESS');
  sendTelegramAlert(`${why === 'stop' ? '🛑' : '💰'} *Spot ${label}* ${item.coin}\nSold ${vol} @ ~$${sellPrice}\nResult: ${pnl >= 0 ? '+' : '-'}$${Math.abs(pnl).toFixed(3)} (${netPct.toFixed(2)}% after fees)`);
  return true;
}

async function spotTick() {
  try {
    const sAcc = await bitunixRequest('GET', '/api/spot/v1/user/account', null, null, true, true);
    if (!sAcc || !(sAcc.code === 0 || sAcc.code === '0') || !Array.isArray(sAcc.data)) return;
    spotBalance = sAcc.data;

    const today = tradingDay();
    if (spotDay !== today) { spotDay = today; spotRealizedToday = 0; }
    const fee = parseFloat(config.spot_fee_pct ?? 0.1) / 100;
    const balOf = (coin) => { const c = sAcc.data.find(x => x.coin === coin); return c ? parseFloat(c.balance || 0) : 0; };

    // ---- 1. manage held coins ----
    for (const item of sAcc.data) {
      if (!SPOT_COINS.includes(item.coin)) continue;
      const rec = spotHoldings[item.coin];
      if (!rec || !(parseFloat(rec.buyPrice) > 0)) continue;
      const bal = parseFloat(item.balance || 0);
      const sym = `${item.coin}USDT`;
      const scanner = multiCoinScanner[sym];
      if (!scanner || !scanner.price) continue;
      if ((spotSellRetryAt[item.coin] || 0) > Date.now()) continue;
      const price = scanner.price;
      const buyPrice = parseFloat(rec.buyPrice);
      const grossPct = (price / buyPrice - 1) * 100;
      const netPct = grossPct - fee * 2 * 100;

      if (rec.source === 'bot') {
        const qty = Math.min(parseFloat(rec.qty || bal), bal);
        if (!(qty > 0)) { delete spotHoldings[item.coin]; saveSpotHoldings(); continue; } // sold by hand
        if (!(rec.peakPct >= netPct)) { rec.peakPct = netPct; saveSpotHoldings(); }
        let why = null;
        if (grossPct <= -parseFloat(config.spot_stop_pct ?? 3)) why = 'stop';
        else if (rec.peakPct >= parseFloat(config.spot_trail_start_pct ?? 2) && netPct <= rec.peakPct - parseFloat(config.spot_trail_drop_pct ?? 0.7)) why = 'trail';
        else if (rec.peakPct < parseFloat(config.spot_trail_start_pct ?? 2) && rec.peakPct >= parseFloat(config.spot_protect_arm_pct ?? 1) && netPct <= parseFloat(config.spot_protect_floor_pct ?? 0.3)) why = 'protect';
        if (why) await sellSpot(item, sym, price, qty, why, netPct);
      } else if (isRunning && config.spot_auto_mode !== false && grossPct >= parseFloat(config.spot_tp_pct || 5)) {
        // the owner's own coins: only at their target, never at a loss
        await sellSpot(item, sym, price, bal, 'target', netPct);
      }
    }

    // ---- 2. buy on signals ----
    const maxLoss = parseFloat(config.max_daily_loss_usd || 1.5);
    if (!isRunning || config.spot_trading === false) return;
    if (spotRealizedToday <= -maxLoss) {
      if (scanTickCount % 60 === 0) log(`[SPOT] Daily loss limit reached ($${spotRealizedToday.toFixed(2)}). No new buys today.`, 'WARNING');
      return;
    }
    if (Date.now() - lastSpotBuyAt < 60 * 1000) return;
    const botCount = Object.values(spotHoldings).filter(r => r.source === 'bot').length;
    if (botCount >= parseInt(config.spot_max_positions || 3)) return;

    const usdt = balOf('USDT');
    const amount = Math.min(parseFloat(config.spot_order_usdt || 11), usdt * 0.98);
    if (amount < 10.2) {
      const wanted = Object.values(multiCoinScanner).some(c => c.signal === 'BUY');
      if (wanted && scanTickCount % 60 === 0) log(`[SPOT] Buy signal, but only $${usdt.toFixed(2)} USDT free in spot (Bitunix minimum order is $10).`, 'WARNING');
      return;
    }

    const picks = Object.values(multiCoinScanner)
      .filter(c => c.signal === 'BUY' && SPOT_COINS.includes(c.name) && !spotHoldings[c.name] && (spotCoolUntil[c.name] || 0) <= Date.now())
      .sort((a, b) => b.confidence - a.confidence);
    // The MHD Trade site must agree (Buy or Strong Buy) before the bot spends money
    const minSite = parseFloat(config.spot_site_min_score ?? 25);
    const agreed = picks.filter(c => siteScores[`${c.name}USDT`] && siteScores[`${c.name}USDT`].score >= minSite);
    if (picks.length && !agreed.length && scanTickCount % 24 === 0) {
      log(`[SPOT] Buy signal on ${picks.map(c => c.name).join(', ')}, but the MHD Trade site does not agree (${picks.map(c => `${c.name} ${siteScores[`${c.name}USDT`] ? siteScores[`${c.name}USDT`].score : '?'}`).join(', ')}). Waiting.`, 'INFO');
    }
    if (!agreed.length) return;
    const c = agreed[0];
    const sym = `${c.name}USDT`;
    log(`[SPOT BUY] ${c.name}: ${c.reason}. Buying $${amount.toFixed(2)} @ ~$${Number(c.price.toPrecision(6))}`, 'INFO');
    const res = await spotOrder(sym, 2, amount.toFixed(2));
    lastSpotBuyAt = Date.now();
    if (!(res && (res.code === 0 || res.code === '0'))) {
      spotCoolUntil[c.name] = Date.now() + 10 * 60 * 1000;
      log(`[SPOT BUY FAILED] ${c.name}: ${res ? `${res.code} ${res.msg}` : 'no response'}`, 'ERROR');
      health.lastOrderError = { at: new Date().toISOString(), code: res ? res.code : null, msg: res ? String(res.msg).slice(0, 120) : 'no response' };
      return;
    }
    const fill = await spotFill(sym, res.data && res.data.orderId);
    const buyPrice = fill ? fill.price : c.price;
    const qty = fill ? fill.qty * (1 - fee) : (amount / c.price) * (1 - fee); // fee may be taken in the coin
    spotHoldings[c.name] = { source: 'bot', buyPrice, qty, peakPct: -fee * 200, buyTime: Date.now() };
    saveSpotHoldings();
    health.lastOrderAt = new Date().toISOString();
    health.lastOrderError = null;
    log(`[SPOT BUY] Order Placed: BUY ${qty.toFixed(6)} ${c.name} @ ~$${Number(buyPrice.toPrecision(6))} ($${amount.toFixed(2)})`, 'SUCCESS');
    sendTelegramAlert(`🟢 *Spot buy* ${c.name}\n$${amount.toFixed(2)} @ ~$${buyPrice}\nWhy: ${c.reason}\nMHD Trade site: ${siteScores[sym] ? siteScores[sym].label + ' (' + siteScores[sym].score + ')' : '-'}\nStop: $${(buyPrice * (1 - parseFloat(config.spot_stop_pct ?? 3) / 100)).toPrecision(6)}`);
  } catch (err) {
    log(`[SPOT] ${err.message}`, 'ERROR');
  }
}

// Public health check: no balances, keys or amounts. Lets the owner (or support) see why no trade is happening.
const health = { startedAt: new Date().toISOString(), lastTickAt: null, lastOrderAt: null, lastOrderError: null, apiOk: null };
app.get('/health', (req, res) => {
  const signals = {};
  for (const [sym, c] of Object.entries(multiCoinScanner)) signals[sym] = { signal: c.signal, trend: c.trend, reason: c.reason, site: c.site_label ? `${c.site_label} (${c.site_score})` : null };
  res.json({
    running: readRunning(),
    last_start_stop: lastControl,
    trading_copy: isLeader,
    paused_for_today: guardReason,
    futures_trading: config.futures_trading === true,
    spot_trading: config.spot_trading !== false,
    spot_bot_positions: Object.values(spotHoldings).filter(r => r.source === 'bot').length,
    spot_usdt_enough_for_a_buy: spotBalance ? (parseFloat((spotBalance.find(c => c.coin === 'USDT') || {}).balance || 0) * 0.98 >= 10.2) : null,
    spot_buys_possible_now: spotBalance ? Math.max(0, Math.floor(parseFloat((spotBalance.find(c => c.coin === 'USDT') || {}).balance || 0) * 0.98 / parseFloat(config.spot_order_usdt || 11))) : null,
    keys_set: !!(config.api_key && config.secret_key),
    exchange_api_ok: health.apiOk,
    started_at: health.startedAt,
    last_scan_at: health.lastTickAt,
    last_order_at: health.lastOrderAt,
    last_order_error: health.lastOrderError,
    open_positions: lastPositionCount,
    signals
  });
});
let lastPositionCount = null;

let lastSiteRefresh = 0;
async function masterTick() {
  isRunning = readRunning();
  if (!claimLeadership()) return; // another copy of the app is doing the trading
  await futuresTick();
  health.lastTickAt = new Date().toISOString();
  if (Date.now() - lastSiteRefresh > 60 * 1000) { // one coin per minute keeps the API load tiny
    lastSiteRefresh = Date.now();
    const syms = Object.keys(COIN_CONFIGS);
    const stale = syms.find(sym => !siteScores[sym] || Date.now() - siteScores[sym].at >= 5 * 60 * 1000);
    if (stale) { try { await refreshSiteScore(stale); } catch (e) {} }
  }
  for (const [sym, sc] of Object.entries(siteScores)) if (multiCoinScanner[sym]) { multiCoinScanner[sym].site_score = sc.score; multiCoinScanner[sym].site_label = sc.label; }
  await spotTick();
}

app.get('/', (req, res) => {
  res.setHeader('Link', '</llms.txt>; rel="alternate"; type="text/plain", </.well-known/mcp/server-card.json>; rel="mcp-server-card"');
  res.sendFile(path.join(__dirname, 'templates', 'index.html'));
});
app.get('/manifest.json', (req, res) => res.sendFile(path.join(__dirname, 'templates', 'manifest.json')));
app.get('/sw.js', (req, res) => res.sendFile(path.join(__dirname, 'templates', 'sw.js')));
app.get('/icon.svg', (req, res) => res.sendFile(path.join(__dirname, 'templates', 'icon.svg')));

// robots.txt — tells crawlers/agents what they can access
app.get('/robots.txt', (req, res) => {
  res.type('text/plain');
  res.send(`User-agent: *
Allow: /
Disallow: /api/

Content-Signal: search=no, ai-train=no

Sitemap: https://trade.malikhammaddigital.com/sitemap.xml
`);
});

// sitemap.xml — lists all public pages
app.get('/sitemap.xml', (req, res) => {
  res.type('application/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://trade.malikhammaddigital.com/</loc>
    <changefreq>always</changefreq>
    <priority>1.0</priority>
  </url>
</urlset>`);
});

// llms.txt — summary for LLM agents
app.get('/llms.txt', (req, res) => {
  res.type('text/plain');
  res.send(`# Bitunix Pro AI Trader

> Automated 24/7 cryptocurrency futures trading bot running on Bitunix exchange.

## What This Site Does
- Real-time RSI + EMA signal engine scanning BTC, ETH, SOL, XRP, DOGE every 5 seconds
- Automatically opens and closes futures positions based on market signals
- Sends Telegram notifications for every trade open, profit lock, and stop-loss
- Tracks spot holdings and auto-sells at +1.2% bounce
- Dashboard shows live PnL, candlestick chart, wallet balances

## API
- All /api endpoints require the dashboard password.

## Owner
- Malik Hammad Digital
- Contact: https://t.me/Hammadmaliktrader_bot
- Source: https://github.com/Hammadullah506/bitunix-trader
`);
});

// MCP Server Card — for AI agent discovery
app.get('/.well-known/mcp/server-card.json', (req, res) => {
  res.json({
    name: "Bitunix Pro AI Trader",
    version: "2.0.0",
    description: "Automated crypto futures trading bot with RSI/EMA signals. Read live status, positions, and market signals.",
    endpoint: "https://trade.malikhammaddigital.com/api",
    capabilities: { tools: [] },
    contact: { url: "https://t.me/Hammadmaliktrader_bot" },
    source: "https://github.com/Hammadullah506/bitunix-trader"
  });
});

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
    running: readRunning(),
    instance: { id: INSTANCE_ID, trading: isLeader },
    config: publicConfig(),
    ticker: currentTicker,
    indicators: currentIndicators,
    last_signal: lastSignal,
    multi_coins: multiCoinScanner,
    trade_mode: config.trade_mode || 'live',
    live_balance: liveBal,
    spot_balance: spotBalance,
    spot_holdings: spotSummary(),
    spot_today: { realized: spotRealizedToday, max_loss: parseFloat(config.max_daily_loss_usd || 1.5) },
    mode: { futures: config.futures_trading === true, spot: config.spot_trading !== false },
    live_positions: livePositions,
    total_realized_today: dailyPnl,
    daily_guard: {
      day: dayKey,
      start_equity: dayStartEquity,
      pnl: dailyPnl,
      paused: guardReason,
      max_daily_loss_usd: parseFloat(config.max_daily_loss_usd || 1.5),
      daily_goal: parseFloat(config.daily_goal || 4)
    },
    logs: logs
  });
});

app.get('/api/config', (req, res) => res.json(publicConfig()));

// Telegram test endpoint — server se directly bhejta hai
app.get('/api/test_telegram', async (req, res) => {
  try {
    const url = `https://api.telegram.org/bot${config.telegram_bot_token}/sendMessage`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: config.telegram_chat_id,
        text: `✅ Bitunix Pro Test\n\nTelegram kaam kar raha hai!\nBTC: $${multiCoinScanner['BTCUSDT']?.price || '-'}\nBalance: $${latestFuturesCash} USDT`
      })
    });
    const data = await r.json();
    res.json({ ok: data.ok, telegram_response: data });
  } catch(e) {
    res.json({ ok: false, error: e.message });
  }
});
app.post('/api/config', (req, res) => {
  saveConfig(req.body);
  log("Configuration updated", "INFO");
  sendTelegramAlert(`⚙️ *Strategy Settings Updated*\n\n• *Mode:* Dynamic Uncapped Profit Runner 🚀\n• *TP (Take Profit):* Open / No 1% Limit (Runs as far as trend goes!)\n• *SL (Stop Loss):* -${config.fixed_stop_loss_pct}% (Strict Tiny Loss Cut)\n• *Multi-Coin Scanner:* ${config.multi_coin_mode ? 'ACTIVE (5 Coins)' : 'OFF'}\n• *Spot Dip-Buyer:* ${config.spot_auto_mode ? 'ACTIVE' : 'OFF'}`);
  res.json({ code: 0, msg: "Saved" });
});

app.post('/api/start', (req, res) => {
  isRunning = true;
  const saved = writeRunning(true);
  if (!saved) {
    log(`[CONTROL] Start could not be saved (${lastControl && lastControl.error}).`, 'ERROR');
    return res.json({ code: -1, msg: 'Start could not be saved on the server: ' + (lastControl && lastControl.error) });
  }
  dayStartEquity = null; // pressing Start re-measures today's baseline (use after a deposit or withdrawal)
  log("Bot Started", "INFO");
  sendTelegramAlert("🟢 *Bot started.* Spot trading is on.");
  res.json({ code: 0, running: readRunning() });
});

app.post('/api/stop', (req, res) => {
  isRunning = false;
  const saved = writeRunning(false);
  if (!saved) log(`[CONTROL] Stop could not be saved (${lastControl && lastControl.error}).`, 'ERROR');
  log("Bot Stopped", "INFO");
  sendTelegramAlert("🛑 *Bot stopped.* No new trades.");
  res.json({ code: saved ? 0 : -1, running: readRunning(), msg: saved ? 'Stopped' : 'Stop could not be saved on the server' });
});

// The owner tells the bot what they paid for a spot coin (0 clears it)
app.post('/api/spot_basis', (req, res) => {
  const coin = String((req.body && req.body.coin) || '').toUpperCase();
  const price = parseFloat(req.body && req.body.price);
  if (!SPOT_COINS.includes(coin)) return res.json({ code: -1, msg: 'Unknown coin' });
  if (price > 0) {
    spotHoldings[coin] = { source: 'manual', buyPrice: price, buyTime: Date.now() };
    log(`[SPOT] Buy price for ${coin} set to $${price}`, 'INFO');
  } else {
    delete spotHoldings[coin];
    log(`[SPOT] Buy price for ${coin} cleared`, 'INFO');
  }
  saveSpotHoldings();
  res.json({ code: 0, msg: 'Saved' });
});

app.post('/api/manual_trade', async (req, res) => {
  const side = String((req.body && req.body.side) || '').toUpperCase();
  if (side !== 'BUY' && side !== 'SELL') return res.json({ code: -1, msg: "Side must be BUY or SELL" });
  const sym = config.symbol || 'BTCUSDT';
  const coin = COIN_CONFIGS[sym];
  const price = multiCoinScanner[sym] ? multiCoinScanner[sym].price : null;
  if (!coin || !price) return res.json({ code: -1, msg: "No live price yet, try again in a few seconds" });

  const needMargin = (parseFloat(coin.qty) * price) / parseFloat(config.leverage || 10);
  const haveMargin = await futuresAvailable();
  if (haveMargin !== null && haveMargin < needMargin * 1.05) {
    return res.json({ code: -1, msg: `Not enough futures balance: need ~$${needMargin.toFixed(2)}, have $${haveMargin.toFixed(2)}` });
  }

  const slPct = exchangeStopPct();
  const slPrice = stopLossPrice(side, price, slPct);
  const orderRes = await bitunixRequest('POST', '/api/v1/futures/trade/place_order', null, {
    effect: 'GTC', orderType: 'MARKET', qty: String(coin.qty), side: side, symbol: sym, tradeSide: 'OPEN',
    slPrice: String(slPrice), slOrderType: 'MARKET', slStopType: 'LAST_PRICE'
  }, true);

  if (orderRes && orderRes.code === 0) {
    log(`[MANUAL] ${side} ${coin.qty} ${sym} placed @ ~$${price}`, 'SUCCESS');
    sendTelegramAlert(`✋ *Manual ${side}* ${coin.qty} ${sym} @ ~$${price} (SL $${slPrice})`);
    return res.json({ code: 0, msg: `Manual ${side} placed` });
  }
  const why = orderRes ? `${orderRes.code} ${orderRes.msg}` : 'no response';
  log(`[MANUAL ORDER FAILED] ${side} ${coin.qty} ${sym}: ${why}`, 'ERROR');
  res.json({ code: -1, msg: `Order failed: ${why}` });
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
  log(`Server started on port ${PORT}`, 'INFO');
  masterTick();
});
