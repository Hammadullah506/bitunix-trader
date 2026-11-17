// Dip-buying with averaging down on one coin (DCA), spot only, no leverage.
//  1. First buy when the price is `dip_pct`% below the highest price of the last `look_hours` closed hours.
//  2. Each next buy when the price is `step_pct`% below the previous buy, `mult` times bigger,
//     at most `max_buys` buys in one round.
//  3. Sell everything the bot bought when the price is `tp_pct`% above the average cost, after fees.
//  4. Optional `hold_hours`: sell everything after that many hours, even at a loss.
// Settings are read from config keys with the instance's prefix (e.g. "dca_" or "dca_fast_").
// A `paperOnly` instance keeps its own pretend wallet and never sends orders, whatever the live setting.
const fs = require('fs');

function createDca({ path: statePath, prefix = 'dca_', defaults = {}, label = 'DCA', paperOnly = false, getConfig, BN, placeSpot, spotRules, log, alert, isLive, health }) {
  let st = null;
  try { st = JSON.parse(fs.readFileSync(statePath, 'utf-8')); } catch (e) {}
  if (!st) st = { round: null, cycles: 0, realized: 0, history: [] };
  if (paperOnly && !st.wallet) st.wallet = { usdt: defaults.paper_usdt ?? 31, coin: 0, start: defaults.paper_usdt ?? 31, startedAt: new Date().toISOString() };
  const save = () => { try { fs.writeFileSync(statePath, JSON.stringify(st), 'utf-8'); } catch (e) {} };

  let hi = null, hiAt = 0, lastPrice = null, lastCheck = 0, retryAt = 0;
  const cfg = () => {
    const c = getConfig();
    const v = (k, d) => (c[prefix + k] ?? defaults[k] ?? d);
    const holdRaw = v('hold_hours', null);
    return {
      on: v('enabled', true) !== false,
      symbol: String(v('symbol', 'ENAUSDT')).toUpperCase(),
      look: parseInt(v('look_hours', 24)),
      dip: parseFloat(v('dip_pct', 8)),
      step: parseFloat(v('step_pct', 5)),
      mult: parseFloat(v('mult', 1.5)),
      maxBuys: parseInt(v('max_buys', 3)),
      tp: parseFloat(v('tp_pct', 1.5)),
      base: parseFloat(v('base_usdt', 6.5)),
      hold: holdRaw == null || holdRaw === '' ? null : parseFloat(holdRaw),
      fee: parseFloat(c.spot_fee_pct ?? 0.1) / 100
    };
  };
  const live = () => !paperOnly && isLive();
  const tag = () => (live() ? '' : paperOnly ? ' (test)' : ' (paper)');

  // A paper-only instance trades against its own pretend wallet
  async function order(c, side, { quote, qty, price }) {
    if (!paperOnly) return placeSpot(c.symbol, side, { quote, qty, price });
    const w = st.wallet;
    const px = price * (side === 'BUY' ? 1.0005 : 0.9995);
    if (side === 'BUY') {
      if (quote > w.usdt + 1e-9) return { ok: false, msg: 'test wallet: not enough USDT' };
      const got = (quote / px) * (1 - c.fee);
      w.usdt -= quote; w.coin += got;
      return { ok: true, fill: { qty: got, price: px } };
    }
    const q = Math.min(qty, w.coin);
    w.coin -= q; w.usdt += q * px * (1 - c.fee);
    return { ok: true, fill: { qty: q, price: px } };
  }

  function view() {
    const c = cfg();
    const r = st.round;
    const avg = r && r.qty > 0 ? r.spent / r.qty : null;
    const out = {
      label, paper_only: paperOnly,
      enabled: c.on, symbol: c.symbol, coin: c.symbol.replace('USDT', ''), price: lastPrice, high24: hi, look_hours: c.look,
      settings: { dip_pct: c.dip, step_pct: c.step, mult: c.mult, max_buys: c.maxBuys, tp_pct: c.tp, base_usdt: c.base, look_hours: c.look, hold_hours: c.hold },
      first_buy_at: !r && hi ? hi * (1 - c.dip / 100) : null,
      round: r ? {
        buys: r.buys.length, qty: r.qty, spent: r.spent, avg_price: avg,
        sell_at: avg ? avg * (1 + c.tp / 100) / (1 - c.fee) : null,
        next_buy_at: r.buys.length < c.maxBuys ? r.last * (1 - c.step / 100) : null,
        next_buy_usdt: r.buys.length < c.maxBuys ? c.base * Math.pow(c.mult, r.buys.length) : null,
        value_now: lastPrice ? r.qty * lastPrice * (1 - c.fee) : null,
        started_at: r.startedAt,
        force_sell_at: c.hold ? new Date(new Date(r.startedAt).getTime() + c.hold * 3600000).toISOString() : null
      } : null,
      cycles: st.cycles, realized: st.realized, history: st.history.slice(-10)
    };
    if (paperOnly) {
      const w = st.wallet;
      const equity = w.usdt + (lastPrice ? w.coin * lastPrice * (1 - c.fee) : 0);
      out.wallet = { start: w.start, startedAt: w.startedAt, equity, change: equity - w.start };
    }
    return out;
  }

  async function buy(c, usdt, price, cash) {
    const amount = Math.min(usdt, cash * 0.98);
    if (amount < 5.2) {
      if (Date.now() > retryAt) log(`[${label}] Buy point reached but only $${cash.toFixed(2)} USDT free (minimum order is $5).`, 'WARNING');
      retryAt = Date.now() + 30 * 60 * 1000;
      return false;
    }
    const res = await order(c, 'BUY', { quote: amount, price });
    if (!res.ok) {
      retryAt = Date.now() + 5 * 60 * 1000;
      log(`[${label} BUY FAILED] ${c.symbol}: ${res.msg}`, 'ERROR');
      if (!paperOnly) health.lastOrderError = { at: new Date().toISOString(), msg: String(res.msg).slice(0, 120) };
      return false;
    }
    const fill = res.fill || { qty: (amount / price) * (1 - c.fee), price };
    if (!st.round) st.round = { buys: [], qty: 0, spent: 0, last: null, startedAt: new Date().toISOString() };
    const r = st.round;
    r.buys.push({ at: new Date().toISOString(), price: fill.price, qty: fill.qty, usdt: amount });
    r.qty += fill.qty; r.spent += amount; r.last = fill.price;
    save();
    if (!paperOnly) { health.lastOrderAt = new Date().toISOString(); health.lastOrderError = null; }
    const avg = r.spent / r.qty;
    const sellAt = avg * (1 + c.tp / 100) / (1 - c.fee);
    const coin = c.symbol.replace('USDT', '');
    log(`[${label} BUY] Order Placed${tag()}: BUY ${fill.qty.toFixed(4)} ${coin} @ $${Number(fill.price.toPrecision(6))} ($${amount.toFixed(2)}), buy ${r.buys.length}/${c.maxBuys}. Average $${Number(avg.toPrecision(6))}, sell at $${Number(sellAt.toPrecision(6))}`, 'SUCCESS');
    alert(`🟢 *${label} buy ${r.buys.length}/${c.maxBuys}${tag()}* ${coin}\n$${amount.toFixed(2)} @ $${Number(fill.price.toPrecision(6))}\nAverage: $${Number(avg.toPrecision(6))}\nWill sell all at: $${Number(sellAt.toPrecision(6))}${c.hold ? `\nOr after ${c.hold}h at any price` : ''}`);
    return true;
  }

  async function sellAll(c, price, coinBalance, why) {
    const r = st.round;
    const rules = await spotRules(c.symbol);
    const have = paperOnly ? st.wallet.coin : coinBalance;
    const qty = BN.roundDownToStep(Math.min(r.qty, have), rules.stepSize);
    if (!(qty > 0) || qty * price < rules.minNotional) {
      if (Date.now() > retryAt) log(`[${label}] Sell point reached but the amount is below the exchange minimum.`, 'WARNING');
      retryAt = Date.now() + 30 * 60 * 1000;
      return false;
    }
    const res = await order(c, 'SELL', { qty, price });
    if (!res.ok) {
      retryAt = Date.now() + 5 * 60 * 1000;
      log(`[${label} SELL FAILED] ${c.symbol}: ${res.msg}`, 'ERROR');
      return false;
    }
    const sellPrice = res.fill ? res.fill.price : price;
    const got = qty * sellPrice * (1 - c.fee);
    const pnl = got - r.spent * (qty / r.qty);
    st.cycles += 1; st.realized += pnl;
    st.history.push({ at: new Date().toISOString(), buys: r.buys.length, spent: r.spent, sold: got, pnl, why, hours: (Date.now() - new Date(r.startedAt).getTime()) / 3600000 });
    if (st.history.length > 100) st.history = st.history.slice(-100);
    st.round = null;
    save();
    const coin = c.symbol.replace('USDT', '');
    const what = why === 'time' ? `Time limit (${c.hold}h)` : 'Profit taken';
    log(`[${label} SELL] ${what}${tag()}: sold ${qty} ${coin} @ $${Number(sellPrice.toPrecision(6))}, ${pnl >= 0 ? '+' : '-'}$${Math.abs(pnl).toFixed(3)}. Rounds: ${st.cycles}, total ${st.realized >= 0 ? '+' : '-'}$${Math.abs(st.realized).toFixed(2)}`, pnl >= 0 ? 'SUCCESS' : 'WARNING');
    alert(`${pnl >= 0 ? '💰' : '⏱'} *${label} ${what}${tag()}* ${coin}\nSold ${qty} @ $${Number(sellPrice.toPrecision(6))}\nThis round: ${pnl >= 0 ? '+' : '-'}$${Math.abs(pnl).toFixed(3)}\nAll rounds: ${st.realized >= 0 ? '+' : '-'}$${Math.abs(st.realized).toFixed(2)} (${st.cycles})`);
    return true;
  }

  // Called every few seconds by the trading copy, with the spot balances [{ coin, balance }]
  async function tick(balances, running) {
    const c = cfg();
    if (!c.on || Date.now() - lastCheck < 10 * 1000) return;
    lastCheck = Date.now();
    try {
      if (!hi || Date.now() - hiAt > 5 * 60 * 1000) {
        const k = await BN.klines(c.symbol, '1h', c.look + 1);
        hi = Math.max(...k.slice(0, -1).map(x => parseFloat(x.high))); // the closed hours only
        hiAt = Date.now();
      }
      const k1 = await BN.klines(c.symbol, '1m', 1);
      lastPrice = parseFloat(k1[k1.length - 1].close);
    } catch (e) { return; }
    if (Date.now() < retryAt) return;
    const bal = (coin) => parseFloat((balances.find(b => b.coin === coin) || {}).balance || 0);
    const cash = paperOnly ? st.wallet.usdt : bal('USDT');
    const coinBal = bal(c.symbol.replace('USDT', ''));
    const r = st.round;

    if (r) {
      const avg = r.spent / r.qty;
      if (lastPrice >= avg * (1 + c.tp / 100) / (1 - c.fee)) return void await sellAll(c, lastPrice, coinBal, 'profit');
      if (c.hold && Date.now() - new Date(r.startedAt).getTime() >= c.hold * 3600000) return void await sellAll(c, lastPrice, coinBal, 'time');
      if (running && r.buys.length < c.maxBuys && lastPrice <= r.last * (1 - c.step / 100)) {
        await buy(c, c.base * Math.pow(c.mult, r.buys.length), lastPrice, cash);
      }
      return;
    }
    if (running && lastPrice <= hi * (1 - c.dip / 100)) await buy(c, c.base, lastPrice, cash);
  }

  return { tick, view, state: () => st };
}

module.exports = { createDca };
