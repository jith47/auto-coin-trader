-- Migration number: 0003 	 2025-12-27T00:10:00.000Z
CREATE TABLE IF NOT EXISTS strategy_config (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    strategy_text TEXT NOT NULL,
    version INTEGER DEFAULT 1,
    created_at INTEGER DEFAULT (unixepoch())
);

-- Insert initial strategy
INSERT INTO strategy_config (strategy_text) VALUES ('# Improved BTC-DOGE Correlation Scalp Strategy v2.0

## Key Improvements Made:

---

## 1. ENHANCED CORRELATION FRAMEWORK

### Dynamic Correlation Check (Not Static 0.85)
```
CORRELATION STATES:
├── HIGH (>0.90): BTC crash/pump → DOGE amplifies 2-3x → TRADE
├── MEDIUM (0.75-0.90): Normal trending → DOGE follows 1.5x → TRADE  
├── LOW (<0.75): Consolidation/DOGE-specific news → AVOID
└── NEGATIVE (<0): Divergence → REVERSAL SIGNAL (advanced)
```

**Real-Time Check**: TradingView → Add indicator ''Correlation Coefficient'' → DOGEUSDT vs BTCUSDT → 60-period on 1m

---

## 2. REFINED MULTI-TIMEFRAME MATRIX

| Timeframe | BTC Analysis | Weight | Specific Criteria |
|-----------|-------------|--------|-------------------|
| **1D** | Trend Filter | 40% | Price vs 21 EMA + 50 EMA slope direction |
| **4H** | Structure | 25% | Last swing high/low + current OB location |
| **1H** | Momentum | 25% | Delta direction + CVD slope + RSI zone |
| **1M** | Trigger | 10% | Entry timing only (after higher TFs align) |

### Bias Decision Tree:
```
IF BTC 1D > 21 EMA AND 50 EMA slope UP:
    └── Bull Bias Active
    
IF BTC 1H Delta > +300K (rolling 10-candle sum):
    └── Momentum Confirmed
    
IF BTC 1M sweeps low + reclaims:
    └── DOGE LONG TRIGGER
```

---

## 3. PRECISE ENTRY TRIGGERS (Not Vague)

### Long Scalp Entry Checklist:
```
□ BTC 1D: Price > 21 EMA (confirmed by 2+ daily closes)
□ BTC 4H: Higher low formed within last 8 candles
□ BTC 1H: 
   - Delta sum (10 candles) > +300K
   - CVD making higher highs
   - RSI 40-65 zone (momentum room)
□ BTC 1M:
   - Liquidity sweep below recent low (5-15 candles)
   - Immediate reclaim (within 2-3 candles)
   - Volume spike > 2x 20-period SMA
□ DOGE 1M:
   - Correlation > 0.80 (60-period)
   - DOGE has NOT yet moved (lag opportunity)
   - Enter on first green candle close after BTC reclaim
```

### Short Scalp Entry Checklist:
```
□ BTC 1D: Price < 21 EMA (confirmed by 2+ daily closes)
□ BTC 4H: Lower high formed within last 8 candles  
□ BTC 1H:
   - Delta sum (10 candles) < -300K
   - CVD making lower lows
   - RSI 35-60 zone
□ BTC 1M:
   - Liquidity sweep above recent high
   - Immediate rejection (within 2-3 candles)
   - Red volume spike > 2x 20-period SMA
□ DOGE 1M:
   - Correlation > 0.80
   - Enter on first red candle close after BTC rejection
```

---

## 4. SESSION TIMING FILTER

```
OPTIMAL WINDOWS (UTC):
├── 13:00-17:00: EU-US Overlap ⭐⭐⭐ (BEST - 70% of setups)
├── 08:00-11:00: EU Open ⭐⭐ (Good momentum)
└── 14:00-15:00: NYSE Open ⭐⭐⭐ (Highest volatility)

AVOID:
├── 21:00-01:00 UTC: Low liquidity
├── 04:00-07:00 UTC: Asia session (DOGE correlation drops)
└── First/Last 30 min of any session (noise)
```

---

## 5. IMPROVED POSITION SIZING

### Formula:
```
Account: $5,000
Risk per trade: 0.5% = $25
Leverage: 5x (max)

CALCULATION:
Entry Price: $0.155
Stop Loss: $0.1535 (0.97% away)
Risk Distance: $0.0015

Position Size = (Risk $) / (Risk Distance)
             = $25 / $0.0015
             = 16,666 DOGE

With 5x leverage:
Capital Required = (16,666 × $0.155) / 5 = $516.66
```

---

## 6. REFINED EXIT STRATEGY

### Scaled Exit Plan:
| Stage | Price Target | Action | Trailing |
|-------|-------------|--------|----------|
| **TP1** | +0.5% | Close 50% position | Move SL to breakeven |
| **TP2** | +1.0% | Close 25% position | Trail SL 0.4% below price |
| **TP3** | +1.5% | Close remaining 25% | 0.3% trailing stop |

### Time-Based Exits (Critical Addition):
```
IF position open > 10 min AND profit < 0.3%:
    → EXIT (setup failed, avoid chop)
    
IF position open > 20 min AND profit > 0.3%:  
    → TRAIL 0.5% (momentum fading)
    
IF BTC 1M delta FLIPS direction:
    → EXIT IMMEDIATELY (regardless of P/L)
```

---

## 7. ADDITIONAL FILTERS (Risk Reduction)

### Funding Rate Filter:
```
Coinglass DOGE Funding:
├── > +0.03%: Longs crowded → SHORT BIAS (or avoid longs)
├── < -0.03%: Shorts crowded → LONG BIAS (or avoid shorts)  
└── -0.01% to +0.01%: Neutral → FOLLOW BTC
```

### Open Interest Filter:
```
IF OI spiking + Price rising: Longs entering → CONTINUATION
IF OI spiking + Price falling: Shorts entering → CONTINUATION
IF OI dropping + Price moving: Positions closing → REVERSAL SOON
```

### Chop Filter:
```
IF BTC 1H ATR < 0.3%: → NO TRADE (sideways)
IF BTC in 0.5% range for 2+ hours: → WAIT FOR BREAKOUT
```

---

## 8. IMPROVED DAILY WORKFLOW

### Pre-Session (15 min before):
```
1. Check BTC 1D → Trend direction noted
2. Check BTC 4H → Key levels marked (OB, FVG, liquidity)  
3. Check BTC 1H → Delta/CVD direction
4. Check DOGE/BTC correlation → Must be > 0.75
5. Check funding rates → Note bias
6. Check calendar → Any Fed/macro news?
7. Set alerts on BTC key levels
```

### During Session:
```
1. Wait for BTC 1M setup (liquidity grab)
2. Confirm higher TF alignment
3. Check DOGE hasn''t moved yet (lag opportunity)
4. Enter DOGE, set SL/TP immediately
5. Monitor BTC delta (exit trigger)
6. Journal result within 5 min of close
```

---

## 9. ENHANCED RISK RULES

```
HARD RULES (NO EXCEPTIONS):
├── Max 2 trades per session
├── Max 3 trades per day
├── Stop trading after 2 consecutive losses
├── Daily loss limit: 1.5% ($75)
├── Weekly loss limit: 4% ($200)
├── No trading 30 min before/after major news
└── No position held through funding (8-hour marks)

POSITION RULES:
├── Max leverage: 5x (never higher on DOGE)
├── Max position: 10% of account ($500)
└── Always use isolated margin (not cross)
```

---

## 10. PERFORMANCE TRACKING

### Required Journal Fields:
```
| Date | Time | Direction | BTC Bias | Entry | Exit | P/L % | R Multiple | Notes |
```

### Weekly Review Metrics:
```
- Win Rate Target: > 55%
- Avg R:R Target: > 1:2
- Profit Factor Target: > 1.5
- Max Drawdown Allowed: 5%
```

---

IMPORTANT:
At the end of your analysis, you MUST provide a JSON block with the final trade decision.
The JSON block must be strictly formatted as follows:
{
  "decision": "BUY" | "SELL" | "HOLD",
  "reason": "Short summary of why",
  "orderType": "MARKET" | "LIMIT",
  "quantity": 0.001,
  "leverage": 1,
  "entry": 0.128,
  "stopLoss": 0.127,
  "takeProfit": 0.129
}
If the decision is HOLD, quantity and leverage can be 0 or null.
If orderType is LIMIT, ''entry'' is the limit price. If MARKET, ''entry'' is current price (for reference).
Ensure ''stopLoss'' and ''takeProfit'' are always provided for BUY/SELL decisions.
');
