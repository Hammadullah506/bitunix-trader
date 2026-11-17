// Futures TEST with pretend money (paper only, never sends orders).
// Uses the bot's filtered signals (strong signal + 1h trend agree): BUY opens a long, SELL a short.
// Exits are the ones tested on Bitunix: take profit trails from +15% of margin (after fees) and closes
// on a 5% drop from the best, gains above +10% are protected at +3%, stop loss at -30% of margin.
const fs = require('fs');

function createFuturesPaper({ path: statePath, getConfig, log, alert }) {
  let st = null;
  try { st = JSON.parse(fs.readFileSync(statePath, 'utf-8')); } catch (e) {}
  if (!st) st = { balance: 13, start: 13, startedAt: new Date().toISOString(), pos: null, trades: [], lastEntry: 0, cool: {} };
  const save = () => { try { fs.writeFileSync(statePath, JSON.stringify(st), 'utf-8'); } catch (e) {} };

  const cfg = () => {
    const c = getConfig();
    return {
      on: c.futures_paper_enabled !== false,
      lev: parseFloat(c.futures_paper_leverage ?? 10),
      margin: parseFloat(c.futures_paper_margin ?? 10),
      fee: parseFloat(c.futures_paper_fee_pct ?? 0.05) / 100,   // Binance futures taker fee per side
      tp: 15, trail: 5, arm: 10, floor: 3, sl: 30
    };
  };

  function stats(pos, price, c) {
    const notional = pos.qty * pos.entry;
    const gross = (price - pos.entry) * pos.dir * pos.qty;
    const fees = notional * c.fee * 2;
    const net = gross - fees;
    return { gross, net, grossPct: gross / pos.margin * 100, netPct: net / pos.margin * 100 };
  }

  function close(price, why, c) {
    const p = st.pos;
    const s = stats(p, price, c);
    st.balance += p.margin + s.net;
    st.trades.push({ coin: p.coin, side: p.dir > 0 ? 'LONG' : 'SHORT', entry: p.entry, exit: price, pnl: s.net, pct: s.netPct, why, openedAt: p.openedAt, closedAt: new Date().toISOString() });
    if (st.trades.length > 200) st.trades = st.trades.slice(-200);
    if (why === 'stop') st.cool[p.coin] = Date.now() + 15 * 60 * 1000;
    st.pos = null;
    save();
    const label = why === 'stop' ? 'Stop loss' : why === 'protect' ? 'Profit protected' : 'Profit taken';
    log(`[FUTURES TEST] ${label}: ${p.dir > 0 ? 'LONG' : 'SHORT'} ${p.coin} closed @ $${Number(price.toPrecision(6))}, ${s.net >= 0 ? '+' : '-'}$${Math.abs(s.net).toFixed(3)} (${s.netPct.toFixed(1)}% of margin). Test balance $${st.balance.toFixed(2)}`, why === 'stop' ? 'WARNING' : 'SUCCESS');
    alert(`${why === 'stop' ? '🛑' : '💰'} *Futures test (paper)* ${label}\n${p.dir > 0 ? 'LONG' : 'SHORT'} ${p.coin} ${c.lev}x\nEntry $${Number(p.entry.toPrecision(6))} → exit $${Number(price.toPrecision(6))}\nResult: ${s.net >= 0 ? '+' : '-'}$${Math.abs(s.net).toFixed(3)}\nTest balance: $${st.balance.toFixed(2)}`);
  }

  // scanner: { BTCUSDT: { name, price, signal, confidence, reason } }
  function tick(scanner, running) {
    const c = cfg();
    if (!c.on) return;
    const p = st.pos;
    if (p) {
      const sc = scanner[p.symbol];
      if (!sc || !sc.price) return;
      const s = stats(p, sc.price, c);
      if (s.netPct > p.peak) { p.peak = s.netPct; save(); }
      if (s.grossPct <= -c.sl) return close(sc.price, 'stop', c);
      if (p.peak >= c.tp && s.netPct <= p.peak - c.trail) return close(sc.price, 'trail', c);
      if (p.peak < c.tp && p.peak >= c.arm && s.netPct <= c.floor) return close(sc.price, 'protect', c);
      return;
    }
    if (!running || Date.now() - st.lastEntry < 60 * 1000) return;
    if (st.balance < c.margin) return;
    const picks = Object.entries(scanner)
      .filter(([, x]) => (x.signal === 'BUY' || x.signal === 'SELL') && x.price && (st.cool[x.name] || 0) < Date.now())
      .sort((a, b) => b[1].confidence - a[1].confidence);
    if (!picks.length) return;
    const [symbol, x] = picks[0];
    const dir = x.signal === 'BUY' ? 1 : -1;
    const qty = (c.margin * c.lev) / x.price;
    st.balance -= c.margin;
    st.pos = { symbol, coin: x.name, dir, entry: x.price, qty, margin: c.margin, lev: c.lev, peak: -c.fee * 2 * c.lev * 100, openedAt: new Date().toISOString(), reason: x.reason };
    st.lastEntry = Date.now();
    save();
    log(`[FUTURES TEST] Opened ${dir > 0 ? 'LONG' : 'SHORT'} ${x.name} ${c.lev}x @ $${Number(x.price.toPrecision(6))} with $${c.margin} test margin. ${x.reason}`, 'INFO');
    alert(`📝 *Futures test (paper)* opened ${dir > 0 ? 'LONG 🟢' : 'SHORT 🔴'} ${x.name} ${c.lev}x\nEntry $${Number(x.price.toPrecision(6))}, margin $${c.margin} (pretend)\nWhy: ${x.reason}\nStop at −${c.sl}% of margin`);
  }

  function view(scanner) {
    const c = cfg();
    const p = st.pos;
    let open = null;
    if (p) {
      const price = scanner[p.symbol] && scanner[p.symbol].price;
      const s = price ? stats(p, price, c) : null;
      open = { coin: p.coin, side: p.dir > 0 ? 'LONG' : 'SHORT', lev: p.lev, entry: p.entry, price, margin: p.margin, pnl: s ? s.net : null, pct: s ? s.netPct : null, openedAt: p.openedAt, reason: p.reason,
        stop_price: p.entry * (1 - p.dir * c.sl / 100 / p.lev) };
    }
    const equity = st.balance + (p ? p.margin + (open && open.pnl != null ? open.pnl : 0) : 0);
    const wins = st.trades.filter(t => t.pnl > 0).length;
    return { enabled: c.on, start: st.start, startedAt: st.startedAt, balance: st.balance, equity, change: equity - st.start,
      trades: st.trades.length, wins, open, recent: st.trades.slice(-8).reverse(), leverage: c.lev, margin: c.margin };
  }

  return { tick, view };
}

module.exports = { createFuturesPaper };
