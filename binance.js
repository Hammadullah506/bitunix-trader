// Binance spot API (https://api.binance.com). Public market data plus signed account and order calls.
// Signed requests: HMAC-SHA256 of the query string with the secret key, API key in X-MBX-APIKEY.
const crypto = require('crypto');

const BASE = 'https://api.binance.com';
let timeOffset = 0;
let timeSyncedAt = 0;

// Public market data. Falls back to Binance's public data mirror if the main API refuses.
const PUBLIC_BASES = [BASE, 'https://data-api.binance.vision'];
async function pub(path, params = {}) {
  const q = new URLSearchParams(params).toString();
  let lastErr = null;
  for (const base of PUBLIC_BASES) {
    try {
      const res = await fetch(`${base}${path}${q ? '?' + q : ''}`, { signal: AbortSignal.timeout(15000) });
      const body = await res.json().catch(() => ({}));
      if (res.ok) return body;
      lastErr = new Error(`Binance ${res.status} ${body.code || ''} ${body.msg || ''}`.trim());
      if (res.status !== 451 && res.status !== 403 && res.status < 500) throw lastErr; // a real request error: do not retry
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

// Keep our clock in line with Binance's, so signed requests are not rejected as too old/new
async function syncTime() {
  if (Date.now() - timeSyncedAt < 10 * 60 * 1000) return;
  const t = await pub('/api/v3/time');
  timeOffset = t.serverTime - Date.now();
  timeSyncedAt = Date.now();
}

async function signed(method, path, params, key, secret) {
  await syncTime();
  const query = new URLSearchParams({ ...params, recvWindow: 10000, timestamp: Date.now() + timeOffset }).toString();
  const signature = crypto.createHmac('sha256', secret).update(query).digest('hex');
  const res = await fetch(`${BASE}${path}?${query}&signature=${signature}`, {
    method,
    headers: { 'X-MBX-APIKEY': key },
    signal: AbortSignal.timeout(15000)
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

// Candles in the same shape the bot already uses: [{ time, open, high, low, close, baseVol }] as strings
async function klines(symbol, interval, limit, endTime) {
  const params = { symbol, interval, limit: Math.min(limit, 1000) };
  if (endTime) params.endTime = endTime;
  const rows = await pub('/api/v3/klines', params);
  return rows.map(k => ({ time: String(k[0]), open: k[1], high: k[2], low: k[3], close: k[4], baseVol: k[5] }));
}

// Order rules per symbol: quantity step, minimum quantity, minimum order value
let rulesCache = null;
let rulesAt = 0;
async function rules(symbols) {
  if (rulesCache && Date.now() - rulesAt < 6 * 3600 * 1000) return rulesCache;
  const info = await pub('/api/v3/exchangeInfo', { symbols: JSON.stringify(symbols) });
  const out = {};
  for (const s of info.symbols || []) {
    const f = Object.fromEntries((s.filters || []).map(x => [x.filterType, x]));
    out[s.symbol] = {
      base: s.baseAsset,
      stepSize: parseFloat((f.LOT_SIZE || {}).stepSize || '0.00000001'),
      minQty: parseFloat((f.LOT_SIZE || {}).minQty || '0'),
      minNotional: parseFloat((f.NOTIONAL || {}).minNotional || (f.MIN_NOTIONAL || {}).minNotional || '5'),
      trading: s.status === 'TRADING'
    };
  }
  rulesCache = out;
  rulesAt = Date.now();
  return out;
}

function roundDownToStep(qty, step) {
  if (!(step > 0)) return qty;
  const decimals = Math.max(0, Math.round(-Math.log10(step)));
  const n = Math.floor(qty / step + 1e-9) * step;
  return Number(n.toFixed(decimals));
}

async function balances(key, secret) {
  const r = await signed('GET', '/api/v3/account', { omitZeroBalances: 'true' }, key, secret);
  if (!r.ok) return { ok: false, msg: `${r.status} ${r.body.code || ''} ${r.body.msg || ''}`.trim() };
  const data = (r.body.balances || []).map(b => ({ coin: b.asset, balance: b.free, locked: b.locked }));
  return { ok: true, data, canTrade: r.body.canTrade !== false };
}

// Average fill price and the coin amount actually received (fee taken in the coin is subtracted)
function fillOf(order, baseAsset) {
  const executed = parseFloat(order.executedQty || 0);
  const quote = parseFloat(order.cummulativeQuoteQty || 0);
  let feeInBase = 0;
  for (const f of order.fills || []) if (f.commissionAsset === baseAsset) feeInBase += parseFloat(f.commission || 0);
  if (!(executed > 0)) return null;
  return { qty: executed - feeInBase, grossQty: executed, price: quote / executed, quote };
}

// Market buy for a USDT amount, or market sell of a coin amount
async function marketOrder(symbol, side, { quote, qty }, key, secret) {
  const params = { symbol, side, type: 'MARKET', newOrderRespType: 'FULL' };
  if (side === 'BUY') params.quoteOrderQty = quote.toFixed(2);
  else params.quantity = String(qty);
  const r = await signed('POST', '/api/v3/order', params, key, secret);
  if (!r.ok) return { ok: false, msg: `${r.status} ${r.body.code || ''} ${r.body.msg || ''}`.trim() };
  return { ok: true, orderId: r.body.orderId, order: r.body };
}

module.exports = { klines, rules, roundDownToStep, balances, marketOrder, fillOf };
