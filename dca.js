// Dip-buying with averaging down on one coin (DCA), spot only, no leverage.
//  1. First buy when the price is `dip_pct`% below the highest price of the last 24 closed hours.
//  2. Each next buy when the price is `step_pct`% below the previous buy, `mult` times bigger,
//     at most `max_buys` buys in one round.
//  3. Sell everything the bot bought when the price is `tp_pct`% above the average cost, after fees.
// No stop loss: a round waits until the price comes back. Chosen from a 7-month backtest on ENA.
const fs = require('fs');

function createDca({ path: statePath, getConfig, BN, placeSpot, spotRules, log, alert, isLive, health }) {
  let st = null;
  try { st = JSON.parse(fs.readFileSync(statePath, 'utf-8')); } catch (e) {}
  if (!st) st = { round: null, cycles: 0, realized: 0, history: [] };
  const save = () => { try { fs.writeFileSync(statePath, JSON.stringify(st), 'utf-8'); } catch (e) {} };

  let hi24 = null, hiAt = 0, lastPrice = null, lastCheck = 0, retryAt = 0;
  const cfg = () => {
    const c = getConfig();
    return {
      on: c.dca_enabled !== false,
      symbol: (c.dca_symbol || 'ENAUSDT').toUpperCase(),
      dip: parseFloat(c.dca_dip_pct ?? 8),
      step: parseFloat(c.dca_step_pct ?? 5),
      mult: parseFloat(c.dca_mult ?? 1.5),
      maxBuys: parseInt(c.dca_max_buys ?? 3),
      tp: parseFloat(c.dca_tp_pct ?? 1.5),
      base: parseFloat(c.dca_base_usdt ?? 6.5),
      fee: parseFloat(c.spot_fee_pct ?? 0.1) / 100
    };
  };

  function view() {
    const c = cfg();
    const r = st.round;
    const avg = r && r.qty > 0 ? r.spent / r.qty : null;
    return {
      enabled: c.on, symbol: c.symbol, coin: c.symbol.replace('USDT', ''), price: lastPrice, high24: hi24,
      settings: { dip_pct: c.dip, step_pct: c.step, mult: c.mult, max_buys: c.maxBuys, tp_pct: c.tp, base_usdt: c.base },
      first_buy_at: !r && hi24 ? hi24 * (1 - c.dip / 100) : null,
      round: r ? {
        buys: r.buys.length, qty: r.qty, spent: r.spent, avg_price: avg,
        sell_at: avg ? avg * (1 + c.tp / 100) / (1 - c.fee) : null,
        next_buy_at: r.buys.length < c.maxBuys ? r.last * (1 - c.step / 100) : null,
        next_buy_usdt: r.buys.length < c.maxBuys ? c.base * Math.pow(c.mult, r.buys.length) : null,
        value_now: lastPrice ? r.qty * lastPrice * (1 - c.fee) : null,
        started_at: r.startedAt
      } : null,
      cycles: st.cycles, realized: st.realized, history: st.history.slice(-10)
    };
  }

  async function buy(c, usdt, price, cash) {
    const amount = Math.min(usdt, cash * 0.98);
    if (amount < 5.2) {
      if (Date.now() > retryAt) log(`[DCA] Buy point reached but only $${cash.toFixed(2)} USDT free (minimum order is $5).`, 'WARNING');
      retryAt = Date.now() + 30 * 60 * 1000;
      return false;
    }
    const res = await placeSpot(c.symbol, 'BUY', { quote: amount, price });
    if (!res.ok) {
      retryAt = Date.now() + 5 * 60 * 1000;
      log(`[DCA BUY FAILED] ${c.symbol}: ${res.msg}`, 'ERROR');
      health.lastOrderError = { at: new Date().toISOString(), msg: String(res.msg).slice(0, 120) };
      return false;
    }
    const fill = res.fill || { qty: (amount / price) * (1 - c.fee), price };
    if (!st.round) st.round = { buys: [], qty: 0, spent: 0, last: null, startedAt: new Date().toISOString() };
    const r = st.round;
    r.buys.push({ at: new Date().toISOString(), price: fill.price, qty: fill.qty, usdt: amount });
    r.qty += fill.qty; r.spent += amount; r.last = fill.price;
    save();
    health.lastOrderAt = new Date().toISOString(); health.lastOrderError = null;
    const avg = r.spent / r.qty;
    const sellAt = avg * (1 + c.tp / 100) / (1 - c.fee);
    const tag = isLive() ? '' : ' (paper)';
    log(`[DCA BUY] Order Placed${tag}: BUY ${fill.qty.toFixed(4)} ${c.symbol.replace('USDT', '')} @ $${Number(fill.price.toPrecision(6))} ($${amount.toFixed(2)}), buy ${r.buys.length}/${c.maxBuys}. Average $${Number(avg.toPrecision(6))}, sell at $${Number(sellAt.toPrecision(6))}`, 'SUCCESS');
    alert(`🟢 *DCA buy ${r.buys.length}/${c.maxBuys}${tag}* ${c.symbol.replace('USDT', '')}\n$${amount.toFixed(2)} @ $${Number(fill.price.toPrecision(6))}\nAverage: $${Number(avg.toPrecision(6))}\nWill sell all at: $${Number(sellAt.toPrecision(6))}`);
    return true;
  }

  async function sellAll(c, price, coinBalance) {
    const r = st.round;
    const rules = await spotRules(c.symbol);
    const qty = BN.roundDownToStep(Math.min(r.qty, coinBalance), rules.stepSize);
    if (!(qty > 0) || qty * price < rules.minNotional) {
      if (Date.now() > retryAt) log(`[DCA] Sell point reached but the amount is below the exchange minimum.`, 'WARNING');
      retryAt = Date.now() + 30 * 60 * 1000;
      return false;
    }
    const res = await placeSpot(c.symbol, 'SELL', { qty, price });
    if (!res.ok) {
      retryAt = Date.now() + 5 * 60 * 1000;
      log(`[DCA SELL FAILED] ${c.symbol}: ${res.msg}`, 'ERROR');
      return false;
    }
    const sellPrice = res.fill ? res.fill.price : price;
    const got = qty * sellPrice * (1 - c.fee);
    const pnl = got - r.spent * (qty / r.qty);
    st.cycles += 1; st.realized += pnl;
    st.history.push({ at: new Date().toISOString(), buys: r.buys.length, spent: r.spent, sold: got, pnl, days: (Date.now() - new Date(r.startedAt).getTime()) / 86400000 });
    st.round = null;
    save();
    const tag = isLive() ? '' : ' (paper)';
    log(`[DCA SELL] Profit taken${tag}: sold ${qty} ${c.symbol.replace('USDT', '')} @ $${Number(sellPrice.toPrecision(6))}, ${pnl >= 0 ? '+' : '-'}$${Math.abs(pnl).toFixed(3)}. Rounds done: ${st.cycles}, total ${st.realized >= 0 ? '+' : '-'}$${Math.abs(st.realized).toFixed(2)}`, 'SUCCESS');
    alert(`💰 *DCA profit${tag}* ${c.symbol.replace('USDT', '')}\nSold ${qty} @ $${Number(sellPrice.toPrecision(6))}\nThis round: ${pnl >= 0 ? '+' : '-'}$${Math.abs(pnl).toFixed(3)}\nAll rounds: ${st.realized >= 0 ? '+' : '-'}$${Math.abs(st.realized).toFixed(2)} (${st.cycles})`);
    return true;
  }

  // Called every few seconds by the trading copy, with the spot balances [{ coin, balance }]
  async function tick(balances, running) {
    const c = cfg();
    if (!c.on || Date.now() - lastCheck < 10 * 1000) return;
    lastCheck = Date.now();
    try {
      if (!hi24 || Date.now() - hiAt > 5 * 60 * 1000) {
        const k = await BN.klines(c.symbol, '1h', 25);
        hi24 = Math.max(...k.slice(0, -1).map(x => parseFloat(x.high))); // the 24 closed hours
        hiAt = Date.now();
      }
      const k1 = await BN.klines(c.symbol, '1m', 1);
      lastPrice = parseFloat(k1[k1.length - 1].close);
    } catch (e) { return; }
    if (Date.now() < retryAt) return;
    const bal = (coin) => parseFloat((balances.find(b => b.coin === coin) || {}).balance || 0);
    const cash = bal('USDT');
    const r = st.round;

    if (r) {
      const avg = r.spent / r.qty;
      if (lastPrice >= avg * (1 + c.tp / 100) / (1 - c.fee)) return void await sellAll(c, lastPrice, bal(c.symbol.replace('USDT', '')));
      if (running && r.buys.length < c.maxBuys && lastPrice <= r.last * (1 - c.step / 100)) {
        await buy(c, c.base * Math.pow(c.mult, r.buys.length), lastPrice, cash);
      }
      return;
    }
    if (running && lastPrice <= hi24 * (1 - c.dip / 100)) await buy(c, c.base, lastPrice, cash);
  }

  return { tick, view, state: () => st };
}

module.exports = { createDca };
