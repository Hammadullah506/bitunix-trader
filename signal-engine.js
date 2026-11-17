/* Copied unchanged from signals.malikhammaddigital.com/assets/js/indicators.js (the MHD Trade signal engine). */
/* Technical indicators + signal engine. Pure functions, no DOM. */
(function (root) {
  function sma(v, p) {
    const out = new Array(v.length).fill(null);
    let sum = 0;
    for (let i = 0; i < v.length; i++) {
      sum += v[i];
      if (i >= p) sum -= v[i - p];
      if (i >= p - 1) out[i] = sum / p;
    }
    return out;
  }

  function ema(v, p) {
    const out = new Array(v.length).fill(null);
    if (v.length < p) return out;
    let prev = 0;
    for (let i = 0; i < p; i++) prev += v[i];
    prev /= p;
    out[p - 1] = prev;
    const k = 2 / (p + 1);
    for (let i = p; i < v.length; i++) {
      prev = v[i] * k + prev * (1 - k);
      out[i] = prev;
    }
    return out;
  }

  function rsi(v, p = 14) {
    const out = new Array(v.length).fill(null);
    if (v.length <= p) return out;
    let gain = 0, loss = 0;
    for (let i = 1; i <= p; i++) {
      const d = v[i] - v[i - 1];
      if (d >= 0) gain += d; else loss -= d;
    }
    gain /= p; loss /= p;
    out[p] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
    for (let i = p + 1; i < v.length; i++) {
      const d = v[i] - v[i - 1];
      gain = (gain * (p - 1) + Math.max(d, 0)) / p;
      loss = (loss * (p - 1) + Math.max(-d, 0)) / p;
      out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
    }
    return out;
  }

  function macd(v, fast = 12, slow = 26, sig = 9) {
    const ef = ema(v, fast), es = ema(v, slow);
    const line = v.map((_, i) => (ef[i] != null && es[i] != null ? ef[i] - es[i] : null));
    const start = line.findIndex(x => x != null);
    const signal = new Array(v.length).fill(null);
    if (start >= 0) {
      const s = ema(line.slice(start), sig);
      for (let i = 0; i < s.length; i++) signal[start + i] = s[i];
    }
    const hist = line.map((x, i) => (x != null && signal[i] != null ? x - signal[i] : null));
    return { line, signal, hist };
  }

  function bollinger(v, p = 20, mult = 2) {
    const mid = sma(v, p);
    const upper = new Array(v.length).fill(null), lower = new Array(v.length).fill(null);
    for (let i = p - 1; i < v.length; i++) {
      let s = 0;
      for (let j = i - p + 1; j <= i; j++) s += (v[j] - mid[i]) ** 2;
      const sd = Math.sqrt(s / p);
      upper[i] = mid[i] + mult * sd;
      lower[i] = mid[i] - mult * sd;
    }
    return { mid, upper, lower };
  }

  function atr(c, p = 14) {
    const out = new Array(c.length).fill(null);
    if (c.length <= p) return out;
    const tr = c.map((x, i) => i === 0 ? x.high - x.low
      : Math.max(x.high - x.low, Math.abs(x.high - c[i - 1].close), Math.abs(x.low - c[i - 1].close)));
    let a = 0;
    for (let i = 1; i <= p; i++) a += tr[i];
    a /= p;
    out[p] = a;
    for (let i = p + 1; i < c.length; i++) {
      a = (a * (p - 1) + tr[i]) / p;
      out[i] = a;
    }
    return out;
  }

  /* Heikin Ashi candles (smoothed view of the same prices). */
  function heikin(c) {
    const out = [];
    for (let i = 0; i < c.length; i++) {
      const close = (c[i].open + c[i].high + c[i].low + c[i].close) / 4;
      const open = i === 0 ? (c[i].open + c[i].close) / 2 : (out[i - 1].open + out[i - 1].close) / 2;
      out.push({ time: c[i].time, open, close, high: Math.max(c[i].high, open, close), low: Math.min(c[i].low, open, close) });
    }
    return out;
  }

  function label(score) {
    if (score >= 60) return { label: 'Strong Buy', cls: 'sbuy', dir: 1 };
    if (score >= 25) return { label: 'Buy', cls: 'buy', dir: 1 };
    if (score <= -60) return { label: 'Strong Sell', cls: 'ssell', dir: -1 };
    if (score <= -25) return { label: 'Sell', cls: 'sell', dir: -1 };
    return { label: 'Neutral', cls: 'neutral', dir: 0 };
  }

  const MIN = 60;       // candles needed before the first score
  const SL = 1.5, TP1 = 1.5, TP2 = 3;   // ATR multiples

  function build(candles) {
    const closes = candles.map(c => c.close);
    return {
      candles, closes,
      e20: ema(closes, 20), e50: ema(closes, 50), e200: ema(closes, 200),
      rsi: rsi(closes, 14), macd: macd(closes), bb: bollinger(closes),
      atr: atr(candles, 14), volAvg: sma(candles.map(c => c.volume), 20)
    };
  }

  /* Score candle i using only data up to i (no look-ahead). */
  function scoreAt(x, i, withReasons) {
    if (i < MIN - 1) return null;
    const close = x.closes[i], last = x.candles[i];
    const e20 = x.e20[i], e50 = x.e50[i], e200 = x.e200[i], r = x.rsi[i];
    const hist = x.macd.hist[i], histPrev = x.macd.hist[i - 1];
    let pts = 0, max = 0;
    const reasons = [];
    const add = (w, dir, text) => { max += w; pts += w * dir; if (withReasons && dir !== 0) reasons.push({ dir, text }); };

    if (e200 != null) add(20, close > e200 ? 1 : -1, close > e200 ? 'Price is above EMA 200 (long-term uptrend)' : 'Price is below EMA 200 (long-term downtrend)');
    add(15, e20 > e50 ? 1 : -1, e20 > e50 ? 'EMA 20 is above EMA 50 (bullish trend)' : 'EMA 20 is below EMA 50 (bearish trend)');
    add(10, close > e20 ? 1 : -1, close > e20 ? 'Price is holding above EMA 20' : 'Price is trading below EMA 20');
    add(15, hist > 0 ? 1 : -1, hist > 0 ? 'MACD histogram is positive' : 'MACD histogram is negative');
    add(5, hist > histPrev ? 1 : -1, hist > histPrev ? 'MACD momentum is rising' : 'MACD momentum is falling');

    if (r < 30) add(15, 1, 'RSI ' + r.toFixed(0) + ' — oversold, bounce possible');
    else if (r > 70) add(15, -1, 'RSI ' + r.toFixed(0) + ' — overbought, pullback possible');
    else if (r >= 50) add(10, 1, 'RSI ' + r.toFixed(0) + ' — buyers in control');
    else add(10, -1, 'RSI ' + r.toFixed(0) + ' — sellers in control');

    if (close < x.bb.lower[i]) add(10, 1, 'Price is below the lower Bollinger Band');
    else if (close > x.bb.upper[i]) add(10, -1, 'Price is above the upper Bollinger Band');
    else add(10, 0, '');

    const volAvg = x.volAvg[i - 1];
    if (volAvg && last.volume > volAvg * 1.5) {
      const up = last.close >= last.open;
      add(5, up ? 1 : -1, 'High volume on a ' + (up ? 'green' : 'red') + ' candle');
    } else add(5, 0, '');

    const score = Math.round((pts / max) * 100);
    return { score, reasons, ...label(score) };
  }

  /* candles: [{time, open, high, low, close, volume}] — pass CLOSED candles only. */
  function analyze(candles) {
    if (!candles || candles.length < MIN) return null;
    const x = build(candles), n = candles.length - 1;
    const cur = scoreAt(x, n, true);
    const close = x.closes[n], a = x.atr[n];

    // Direction of every candle, then: entries (direction flips), age of the current signal, past results.
    const dirs = new Array(candles.length).fill(0);
    for (let i = MIN - 1; i <= n; i++) dirs[i] = scoreAt(x, i, false).dir;
    const events = [];
    let lastEv = null;
    for (let i = MIN; i <= n; i++) {
      const d = dirs[i];
      if (d === 0 || d === dirs[i - 1]) continue;                       // an entry is the candle where a signal starts
      if (lastEv && lastEv.dir === d && lastEv.end >= i) continue;       // same-direction trade still running
      const at = x.atr[i], entry = x.closes[i];
      const ev = { index: i, time: candles[i].time, dir: d, entry, stop: entry - d * SL * at, tp1: entry + d * TP1 * at, result: 'open', end: Infinity };
      for (let j = i + 1; j <= n; j++) {
        const c = candles[j];
        const hitStop = d > 0 ? c.low <= ev.stop : c.high >= ev.stop;
        const hitTp = d > 0 ? c.high >= ev.tp1 : c.low <= ev.tp1;
        if (hitStop) { ev.result = 'loss'; ev.end = j; break; }         // both in one candle counts as a loss (conservative)
        if (hitTp) { ev.result = 'win'; ev.end = j; break; }
      }
      events.push(ev);
      lastEv = ev;
    }
    let age = 0;
    if (cur.dir !== 0) for (let i = n; i >= 0 && dirs[i] === cur.dir; i--) age++;
    const wins = events.filter(e => e.result === 'win').length, losses = events.filter(e => e.result === 'loss').length;

    let levels = null;
    if (cur.dir !== 0 && a) {
      levels = {
        side: cur.dir > 0 ? 'LONG' : 'SHORT', entry: close,
        stop: close - cur.dir * SL * a, tp1: close + cur.dir * TP1 * a, tp2: close + cur.dir * TP2 * a
      };
    }
    return {
      score: cur.score, label: cur.label, cls: cur.cls, dir: cur.dir, reasons: cur.reasons, levels, close, age,
      bulls: cur.reasons.filter(r => r.dir > 0).length, bears: cur.reasons.filter(r => r.dir < 0).length,
      events, stats: { wins, losses, total: wins + losses },
      rsi: x.rsi[n], macd: x.macd.line[n], macdSignal: x.macd.signal[n], macdHist: x.macd.hist[n],
      ema20: x.e20[n], ema50: x.e50[n], ema200: x.e200[n], atr: a,
      bbUpper: x.bb.upper[n], bbLower: x.bb.lower[n], bbMid: x.bb.mid[n]
    };
  }

  root.TA = { sma, ema, rsi, macd, bollinger, atr, heikin, analyze, label };
})(typeof window !== 'undefined' ? window : globalThis);
