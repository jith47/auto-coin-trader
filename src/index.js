// =============================================
//  CRYPTO TRADING BOT — FULLY AUTOMATED V4
// =============================================
//  Institutional Selective + 24/7 Paper Trading
// =============================================

const CONFIG = {
  symbol: "BTCUSDT",
  timeframe: "1h", htfTimeframe: "4h",
  emaFast: 20, emaSlow: 200, atrPeriod: 14,
  riskPerTrade: 0.03, stopLossAtrMult: 1.5, takeProfitAtrMult: 3.0,
  trailBreakevenR: 1.5, trailTightR: 2.5,
  swingLookback: 10, sweepWickMinAtr: 0.3, sessionActiveHours: [0, 23],
  minDisplacementBodyPct: 0.6,
  paperTrading: true, minTimeBetweenTrades: 60, baseUrl: "https://api.binance.com",
};

class BinanceClient {
  constructor(apiKey, apiSecret, baseUrl) { this.apiKey = apiKey; this.apiSecret = apiSecret; this.baseUrl = baseUrl; }
  async sign(qs) {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey("raw", encoder.encode(this.apiSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(qs));
    return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  async publicGet(endpoint, params = {}) {
    const qs = new URLSearchParams(params).toString();
    const res = await fetch(`${this.baseUrl}${endpoint}${qs ? "?" + qs : ""}`);
    if (!res.ok) throw new Error(`Binance API error: ${res.status}`);
    return res.json();
  }
  async signedGet(endpoint, params = {}) {
    params.timestamp = Date.now(); params.recvWindow = 5000;
    const qs = new URLSearchParams(params).toString(); const sig = await this.sign(qs);
    const res = await fetch(`${this.baseUrl}${endpoint}?${qs}&signature=${sig}`, { headers: { "X-MBX-APIKEY": this.apiKey } });
    return res.json();
  }
  async getKlines(symbol, interval, limit = 250) {
    const data = await this.publicGet("/api/v3/klines", { symbol, interval, limit });
    return data.map((k) => ({ openTime: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]), low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]) }));
  }
}

class Indicators {
  static ema(data, period) {
    const k = 2 / (period + 1); const res = [data[0]];
    for (let i = 1; i < data.length; i++) res.push(data[i] * k + res[i - 1] * (1 - k));
    return res;
  }
  static atr(candles, period = 14) {
    const trs = [candles[0].high - candles[0].low];
    for (let i = 1; i < candles.length; i++) trs.push(Math.max(candles[i].high - candles[i].low, Math.abs(candles[i].high - candles[i - 1].close), Math.abs(candles[i].low - candles[i - 1].close)));
    return this.ema(trs, period);
  }
  static volumeSpike(candles, period = 20) {
    const vols = candles.map(c => c.volume);
    const avgVol = vols.slice(-period).reduce((a, b) => a + b, 0) / period;
    return candles[candles.length - 1].volume > avgVol * 1.5;
  }
}

class SmartMoney {
  static findSwingPoints(candles, lookback = 10) {
    const swings = { highs: [], lows: [] };
    for (let i = lookback; i < candles.length - lookback; i++) {
      let isHigh = true, isLow = true;
      for (let j = 1; j <= lookback; j++) {
        if (candles[i].high < candles[i - j].high || candles[i].high < candles[i + j].high) isHigh = false;
        if (candles[i].low > candles[i - j].low || candles[i].low > candles[i + j].low) isLow = false;
      }
      if (isHigh) swings.highs.push({ price: candles[i].high, index: i });
      if (isLow) swings.lows.push({ price: candles[i].low, index: i });
    }
    return swings;
  }

  static analyze(candles) {
    const last = candles[candles.length - 1];
    const prev = candles[candles.length - 2];
    const prev2 = candles[candles.length - 3];
    const swings = this.findSwingPoints(candles, CONFIG.swingLookback);
    const atr = Indicators.atr(candles, 14)[candles.length - 1];

    let sweep = null, bos = false, displacement = false, multiSweep = false;
    let orderBlock = null, obSide = null;

    // 1. Detect Bullish Sweep (Liquidity Grab below Swing Low)
    const recentLows = swings.lows.filter(s => s.index < candles.length - 3);
    if (recentLows.length > 0) {
      const lastLow = recentLows[recentLows.length - 1];
      const wickedBelow = prev2.low < lastLow.price && prev2.close > lastLow.price;
      const wickSize = lastLow.price - prev2.low;

      if (wickedBelow && wickSize > atr * CONFIG.sweepWickMinAtr) {
        sweep = "BULL_SWEEP";
        orderBlock = prev2; obSide = "BULL";

        // Displacement: Reclaim candle must have strong body
        const range = prev.high - prev.low;
        const body = Math.abs(prev.close - prev.open);
        displacement = (body / range) >= CONFIG.minDisplacementBodyPct && prev.close > prev.open;

        // BOS (Break of Structure): Current candle breaks previous candle's high
        bos = last.close > prev.high;

        // Multi-sweep: Was this level swept recently?
        multiSweep = recentLows.filter(l => Math.abs(l.price - lastLow.price) / lastLow.price < 0.001).length > 1;
      }
    }

    // 2. Detect Bearish Sweep (Liquidity Grab above Swing High)
    const recentHighs = swings.highs.filter(s => s.index < candles.length - 3);
    if (recentHighs.length > 0) {
      const lastHigh = recentHighs[recentHighs.length - 1];
      const wickedAbove = prev2.high > lastHigh.price && prev2.close < lastHigh.price;
      const wickSize = prev2.high - lastHigh.price;

      if (wickedAbove && wickSize > atr * CONFIG.sweepWickMinAtr) {
        sweep = "BEAR_SWEEP";
        orderBlock = prev2; obSide = "BEAR";

        const range = prev.high - prev.low;
        const body = Math.abs(prev.close - prev.open);
        displacement = (body / range) >= CONFIG.minDisplacementBodyPct && prev.close < prev.open;

        bos = last.close < prev.low;
        multiSweep = recentHighs.filter(h => Math.abs(h.price - lastHigh.price) / lastHigh.price < 0.001).length > 1;
      }
    }

    const hour = new Date(last.openTime).getUTCHours();
    const sessionActive = hour >= CONFIG.sessionActiveHours[0] && hour <= CONFIG.sessionActiveHours[1];

    return { sweep, bos, displacement, multiSweep, orderBlock, obSide, sessionBias: sessionActive ? "ACTIVE" : "QUIET" };
  }
}

class Strategy {
  constructor(config) { this.config = config; }
  analyze(candles, htfCandles = null) {
    const closes = candles.map(c => c.close); const latest = candles.length - 1;
    const e200 = Indicators.ema(closes, 200)[latest];
    const e200Prev = Indicators.ema(closes, 200)[latest - 5];
    const atr = Indicators.atr(candles, 14)[latest];
    const price = closes[latest]; const slope = e200 - e200Prev;

    const smc = SmartMoney.analyze(candles);
    const volSpike = Indicators.volumeSpike(candles);

    let htfTrend = "NONE";
    if (htfCandles) {
      const htfCloses = htfCandles.map(c => c.close);
      const htfE200 = Indicators.ema(htfCloses, 200)[htfCloses.length - 1];
      const htfE200Prev = Indicators.ema(htfCloses, 200)[htfCloses.length - 6];
      htfTrend = (htfCloses[htfCloses.length - 1] > htfE200 && htfE200 > htfE200Prev) ? "BULL" : (htfCloses[htfCloses.length - 1] < htfE200 && htfE200 < htfE200Prev ? "BEAR" : "NONE");
    }

    let bull = 0, bear = 0; const reasons = [];

    // 1. Structural Confluence (Primary)
    if (smc.bos) {
      if (smc.sweep === "BULL_SWEEP") { bull += 4; reasons.push("BOS_BULL"); }
      if (smc.sweep === "BEAR_SWEEP") { bear += 4; reasons.push("BOS_BEAR"); }
    } else {
      // NO BOS = NO TRADE in V6 (Handled by action check below)
    }

    // 2. Trend & HTF Alignment
    if (htfTrend === "BULL") { bull += 2; reasons.push("HTF_BULL"); }
    else if (htfTrend === "BEAR") { bear += 2; reasons.push("HTF_BEAR"); }

    if (price > e200 && slope > 0) { bull += 1; reasons.push("TREND_BULL"); }
    else if (price < e200 && slope < 0) { bear += 1; reasons.push("TREND_BEAR"); }

    // 3. Smart Money Confluences
    if (smc.displacement) { bull += 2; bear += 2; reasons.push("DISPLACEMENT"); }
    if (smc.multiSweep) { bull += 2; bear += 2; reasons.push("MULTI_SWEEP"); }
    if (smc.obSide === "BULL" && price <= smc.orderBlock.high) { bull += 1; reasons.push("OB_CONFL_BULL"); }
    if (smc.obSide === "BEAR" && price >= smc.orderBlock.low) { bear += 1; reasons.push("OB_CONFL_BEAR"); }

    // 4. Volume
    if (volSpike) { bull += 1; bear += 1; reasons.push("VOL_SPIKE"); }

    // Entry Logic: Require BOS + (HTF Alignment OR High Score)
    const mandatory = smc.bos;
    const scoreThreshold = 8;
    const act = (mandatory && bull >= scoreThreshold) ? "BUY" : (mandatory && bear >= scoreThreshold ? "SELL" : "HOLD");

    return { action: act, bull, bear, reasons, indicators: { price, e200, atr, slope, smc, htfTrend } };
  }
}

class RiskManager {
  static calculateLevels(price, atr, side) {
    const slDist = atr * CONFIG.stopLossAtrMult; const tpDist = atr * CONFIG.takeProfitAtrMult;
    return { sl: side === "BUY" ? price - slDist : price + slDist, tp: side === "BUY" ? price + tpDist : price - tpDist };
  }
  static checkTrailingStop(pos, currentPrice, atr) {
    const pnlR = pos.side === "BUY" ? (currentPrice - pos.entry) / atr : (pos.entry - currentPrice) / atr;
    let newSl = pos.sl;

    // 1. Breakeven Trail
    if (pnlR >= CONFIG.trailBreakevenR) {
      const bePrice = pos.side === "BUY" ? pos.entry + (atr * 0.2) : pos.entry - (atr * 0.2);
      if (pos.side === "BUY") newSl = Math.max(newSl, bePrice);
      else newSl = Math.min(newSl, bePrice);
    }

    // 2. Tight Trail
    if (pnlR >= CONFIG.trailTightR) {
      const tightPrice = pos.side === "BUY" ? currentPrice - (atr * 1.0) : currentPrice + (atr * 1.0);
      if (pos.side === "BUY") newSl = Math.max(newSl, tightPrice);
      else newSl = Math.min(newSl, tightPrice);
    }

    return newSl;
  }
}

class Backtester {
  static run(c, htf) {
    let bal = 10000; let pos = null; let trades = []; const strat = new Strategy(CONFIG);
    const fee = 0.0005;
    for (let i = 250; i < c.length; i++) {
      if (pos) {
        // Trailing Stop Check
        const currentAtr = Indicators.atr(c.slice(0, i + 1), 14).pop();
        pos.sl = RiskManager.checkTrailingStop(pos, c[i].close, currentAtr);

        const hitSL = pos.side === "BUY" ? c[i].low <= pos.sl : c[i].high >= pos.sl;
        const hitTP = pos.side === "BUY" ? c[i].high >= pos.tp : c[i].low <= pos.tp;
        if (hitSL || hitTP) {
          const exit = hitSL ? pos.sl : pos.tp;
          const pnl = pos.side === "BUY" ? (exit - pos.entry) * pos.qty : (pos.entry - exit) * pos.qty;
          bal += pnl - (exit * pos.qty * fee); trades.push({ pnl }); pos = null;
        }
      } else {
        const htfSlice = htf.filter(h => h.openTime < c[i].openTime);
        const { action, indicators } = strat.analyze(c.slice(0, i + 1), htfSlice);
        if (action !== "HOLD") {
          const qty = (bal * 0.03) / (indicators.atr * CONFIG.stopLossAtrMult);
          const l = RiskManager.calculateLevels(c[i].close, indicators.atr, action);
          pos = { side: action, entry: c[i].close, qty, ...l };
          bal -= (c[i].close * qty * fee);
        }
      }
    }
    const wins = trades.filter(t => t.pnl > 0).length;
    return { net: bal - 10000, returnPct: ((bal / 10000) - 1) * 100, trades: trades.length, winRate: (wins / trades.length) * 100 || 0 };
  }
}

class StateManager {
  constructor(kv) { this.kv = kv; }
  async getState() { return (await this.kv.get("bot_state", "json")) || { position: null, totalPnl: 0, trades: [] }; }
  async saveState(s) { if (s.trades.length > 50) s.trades = s.trades.slice(-50); await this.kv.put("bot_state", JSON.stringify(s)); }
}

class TradingBot {
  constructor(env) {
    this.binance = new BinanceClient(env.BINANCE_API_KEY, env.BINANCE_API_SECRET, CONFIG.baseUrl);
    this.state = new StateManager(env.BOT_STATE); this.strat = new Strategy(CONFIG);
  }
  async run() {
    let s = await this.state.getState();
    const c = await this.binance.getKlines(CONFIG.symbol, CONFIG.timeframe, 250);
    const htf = await this.binance.getKlines(CONFIG.symbol, CONFIG.htfTimeframe, 250);
    const price = c[c.length - 1].close; const atr = Indicators.atr(c, 14)[c.length - 1];

    if (s.position) {
      const pos = s.position;
      // V6 Trailing Stop Update
      pos.sl = RiskManager.checkTrailingStop(pos, price, atr);

      const hitSL = pos.side === "BUY" ? price <= pos.sl : price >= pos.sl;
      const hitTP = pos.side === "BUY" ? price >= pos.tp : price <= pos.tp;
      if (hitSL || hitTP) {
        const pnl = pos.side === "BUY" ? (price - pos.entry) * pos.qty : (pos.entry - price) * pos.qty;
        s.trades.push({ side: pos.side, entry: pos.entry, exit: price, pnl, reason: hitSL ? "SL" : "TP", time: new Date().toISOString() });
        s.totalPnl += pnl; s.position = null;
      }
    } else {
      const { action } = this.strat.analyze(c, htf);
      if (action !== "HOLD") {
        const qty = ((10000 + s.totalPnl) * CONFIG.riskPerTrade) / (atr * CONFIG.stopLossAtrMult);
        const l = RiskManager.calculateLevels(price, atr, action);
        s.position = { side: action, entry: price, qty, ...l, time: Date.now() };
      }
    }
    await this.state.saveState(s); return s;
  }
}

const DASHBOARD_HTML = `
<!DOCTYPE html>
<html>
<head>
    <title>CryptoBot Pro — Dashboard</title>
    <style>
        :root { --bg: #0a0a0c; --card: #141416; --border: #262629; --text: #ecedee; --accent: #0070f3; --green: #00ce8e; --red: #ff4532; }
        body { background: var(--bg); color: var(--text); font-family: ui-sans-serif, system-ui, -apple-system, blinkmacsystemfont, "Segoe UI", roboto, "Helvetica Neue", arial, sans-serif; margin: 0; padding: 40px; }
        .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 24px; margin-bottom: 24px; }
        .card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 24px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1); transition: transform 0.2s; }
        h1 { font-size: 24px; margin: 0 0 40px 0; display: flex; align-items: center; }
        .label { color: #888; font-size: 14px; margin-bottom: 8px; }
        .value { font-size: 32px; font-weight: 700; }
        .green { color: var(--green); } .red { color: var(--red); }
        .btn { background: var(--accent); color: white; border: none; padding: 12px 24px; border-radius: 8px; cursor: pointer; font-weight: 600; font-size: 14px; margin-right: 8px; }
        .btn-sec { background: transparent; border: 1px solid var(--border); color: var(--text); }
        .btn:hover { opacity: 0.9; }
        table { width: 100%; border-collapse: collapse; margin-top: 16px; }
        th { text-align: left; color: #888; font-size: 12px; padding-bottom: 12px; }
        td { padding: 12px 0; border-top: 1px solid var(--border); font-size: 14px; }
        #bt-results { display: none; margin-top: 24px; background: rgba(0, 112, 243, 0.05); border-color: var(--accent); }
    </style>
</head>
<body>
    <h1>🤖 CryptoBot <span style="color: #888; font-weight: 400; margin-left: 12px;">v6 Institutional Structural</span></h1>
    <div class="grid">
        <div class="card"><div class="label">Balance</div><div class="value">$<span id="bal">10,000.00</span></div></div>
        <div class="card"><div class="label">Total PnL</div><div class="value" id="pnl">$0.00</div></div>
        <div class="card"><div class="label">Win Rate</div><div class="value" id="wr">0%</div></div>
    </div>
    <div class="grid" style="grid-template-columns: 2fr 1fr;">
        <div class="card">
            <h3>Recent Trades</h3>
            <table id="trades"><thead><tr><th>Time</th><th>Side</th><th>Entry</th><th>Exit</th><th>PnL</th><th>Reason</th></tr></thead><tbody></tbody></table>
        </div>
        <div class="card">
            <h3>Quick Actions</h3>
            <button class="btn" onclick="runBT()">Run Backtest (1h/1k)</button>
            <div id="bt-results" class="card">
                <div class="label">Backtest Result</div>
                <div class="value" id="bt-net" style="font-size: 24px;">$0.00</div>
                <div class="label" id="bt-pct" style="margin-top: 4px;">0% Return</div>
            </div>
        </div>
    </div>
    <script>
        async function load() {
            const res = await fetch('/api/status'); const s = await res.json();
            document.getElementById('bal').innerText = (10000 + s.totalPnl).toFixed(2);
            document.getElementById('pnl').innerText = (s.totalPnl >= 0 ? '+' : '') + s.totalPnl.toFixed(2);
            document.getElementById('pnl').className = 'value ' + (s.totalPnl >= 0 ? 'green' : 'red');
            const wins = s.trades.filter(t => t.pnl > 0).length;
            document.getElementById('wr').innerText = (wins / s.trades.length * 100 || 0).toFixed(1) + '%';
            const tbody = document.querySelector('#trades tbody'); tbody.innerHTML = '';
            s.trades.slice().reverse().slice(0, 10).forEach(t => {
                const tr = document.createElement('tr');
                tr.innerHTML = \`<td>\${t.time.slice(11, 19)}</td><td>\${t.side}</td><td>\${t.entry.toFixed(2)}</td><td>\${t.exit.toFixed(2)}</td><td class="\${t.pnl >= 0 ? 'green' : 'red'}">\${t.pnl >= 0 ? '+' : ''}\${t.pnl.toFixed(2)}</td><td>\${t.reason}</td>\`;
                tbody.appendChild(tr);
            });
        }
        async function runBT() {
            const bt = document.getElementById('bt-results'); bt.style.display = 'block';
            document.getElementById('bt-net').innerText = 'Calculating...';
            const res = await fetch('/api/backtest', { method: 'POST' }); const r = await res.json();
            document.getElementById('bt-net').innerText = (r.net >= 0 ? '+' : '') + '$' + r.net.toFixed(2);
            document.getElementById('bt-net').className = 'value ' + (r.net >= 0 ? 'green' : 'red');
            document.getElementById('bt-pct').innerText = r.returnPct.toFixed(2) + '% Return over ' + r.trades + ' trades';
        }
        load(); setInterval(load, 30000);
    </script>
</body>
</html>
`;

export default {
  async scheduled(event, env) { await (new TradingBot(env)).run(); },
  async fetch(req, env) {
    const url = new URL(req.url); const bot = new TradingBot(env);
    const state = new StateManager(env.BOT_STATE);
    if (url.pathname === "/") return new Response(DASHBOARD_HTML, { headers: { "Content-Type": "text/html" } });
    if (url.pathname === "/api/status") return new Response(JSON.stringify(await state.getState()));
    if (url.pathname === "/api/backtest") {
      const c = await bot.binance.getKlines(CONFIG.symbol, CONFIG.timeframe, 1000);
      const htf = await bot.binance.getKlines(CONFIG.symbol, CONFIG.htfTimeframe, 1000);
      return new Response(JSON.stringify(Backtester.run(c, htf)));
    }
    return new Response("Not Found", { status: 404 });
  }
};
