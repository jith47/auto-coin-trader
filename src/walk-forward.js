const CONFIG = { startingBalance: 10000, fee: 0.0005, riskPerTrade: 0.03, slMult: 1.5, tpMult: 3.0, swingLookback: 10, trailBreakevenR: 1.5, trailTightR: 2.5 };

class Indicators {
  static ema(d, p) { const k = 2 / (p + 1); const r = [d[0]]; for (let i = 1; i < d.length; i++) r.push(d[i] * k + r[i - 1] * (1 - k)); return r; }
  static atr(c, p) {
    const tr = [c[0].high - c[0].low]; for (let i = 1; i < c.length; i++) tr.push(Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i - 1].close), Math.abs(c[i].low - c[i - 1].close)));
    return this.ema(tr, p);
  }
  static volumeSpike(c) {
    const vols = c.map(x => x.volume); const avg = vols.slice(-20).reduce((a, b) => a + b, 0) / 20;
    return c[c.length - 1].volume > avg * 1.5;
  }
}

class Strategy {
  analyze(c, htf) {
    const last = c[c.length - 1], prev = c[c.length - 2], prev2 = c[c.length - 3];
    const closes = c.map(x => x.close), price = last.close;
    const atr = Indicators.atr(c, 14).pop();
    const e200 = Indicators.ema(closes, 200).pop();
    const slope = e200 - Indicators.ema(closes, 200)[c.length - 6];

    // HTF Trend (simplified for WFA)
    const htfCloses = htf.map(x => x.close);
    const htfE200 = Indicators.ema(htfCloses, 200).pop();
    const htfTrend = htfCloses[htfCloses.length - 1] > htfE200 ? "BULL" : "BEAR";

    // BOS Detection
    let bull = 0, bear = 0, bos = false;
    // (Simplified swing for performance in WFA)
    const low = Math.min(...c.slice(-20, -3).map(x => x.low));
    const high = Math.max(...c.slice(-20, -3).map(x => x.high));

    if (prev2.low < low && prev2.close > low) { // Sweep
      if (last.close > prev.high) { bos = true; bull += 10; } // BOS
    }
    if (prev2.high > high && prev2.close < high) { // Sweep
      if (last.close < prev.low) { bos = true; bear += 10; } // BOS
    }

    if (htfTrend === "BULL") bull += 2; else bear += 2;
    if (price > e200 && slope > 0) bull += 1; else if (price < e200 && slope < 0) bear += 1;

    const action = (bos && bull >= 8) ? "BUY" : (bos && bear >= 8 ? "SELL" : "HOLD");
    return { action, atr };
  }
}

class Backtester {
  run(c, htf) {
    let bal = CONFIG.startingBalance; let pos = null; let trades = 0, wins = 0;
    const strat = new Strategy();
    for (let i = 250; i < c.length; i++) {
      if (pos) {
        const curAtr = Indicators.atr(c.slice(0, i + 1), 14).pop();
        const pnlR = pos.side === "BUY" ? (c[i].close - pos.entry) / curAtr : (pos.entry - c[i].close) / curAtr;
        if (pnlR >= CONFIG.trailBreakevenR) pos.sl = pos.side === "BUY" ? Math.max(pos.sl, pos.entry) : Math.min(pos.sl, pos.entry);

        const hitSL = pos.side === "BUY" ? c[i].low <= pos.sl : c[i].high >= pos.sl;
        const hitTP = pos.side === "BUY" ? c[i].high >= pos.tp : c[i].low <= pos.tp;
        if (hitSL || hitTP) {
          const exit = hitSL ? pos.sl : pos.tp;
          const pnl = pos.side === "BUY" ? (exit - pos.entry) * pos.qty : (pos.entry - exit) * pos.qty;
          bal += pnl - (exit * pos.qty * CONFIG.fee); if (pnl > 0) wins++; trades++; pos = null;
        }
      } else {
        const htfSlice = htf.filter(h => h.openTime < c[i].openTime);
        const { action, atr } = strat.analyze(c.slice(0, i + 1), htfSlice);
        if (action !== "HOLD") {
          const qty = (bal * CONFIG.riskPerTrade) / (atr * CONFIG.slMult);
          pos = { side: action, entry: c[i].close, qty, sl: action === "BUY" ? c[i].close - atr * CONFIG.slMult : c[i].close + atr * CONFIG.slMult, tp: action === "BUY" ? c[i].close + atr * CONFIG.tpMult : c[i].close - atr * CONFIG.tpMult };
          bal -= (c[i].close * qty * CONFIG.fee);
        }
      }
    }
    return { net: bal - CONFIG.startingBalance, returnPct: ((bal / CONFIG.startingBalance) - 1) * 100, trades, winRate: (wins / trades) * 100 || 0 };
  }
}

export default {
  async fetch() {
    const res1 = await fetch("https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=1000");
    const res2 = await fetch("https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=4h&limit=1000");
    const data = (await res1.json()).map(k => ({ openTime: k[0], high: parseFloat(k[2]), low: parseFloat(k[3]), close: parseFloat(k[4]), open: parseFloat(k[1]), volume: parseFloat(k[5]) }));
    const htf = (await res2.json()).map(k => ({ openTime: k[0], high: parseFloat(k[2]), low: parseFloat(k[3]), close: parseFloat(k[4]), open: parseFloat(k[1]), volume: parseFloat(k[5]) }));
    const results = (new Backtester()).run(data, htf);
    return new Response(`<h1>V6 Institutional Verification</h1><pre>${JSON.stringify(results, null, 2)}</pre>`, { headers: { "Content-Type": "text/html" } });
  }
};
