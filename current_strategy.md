# Improved BTC-DOGE Correlation Scalp Strategy v2.4

## Key Improvements Made:
- **CVD Divergence Priority**: Elevated Spot CVD (Cumulative Volume Delta) as a primary entry filter, as seen in recent successful "Relative Weakness" shorts.
- **SL/TP Parameter Validation**: Added a critical rule to ensure Stop Loss and Take Profit levels are mathematically aligned with trade direction to prevent anomalous offset errors.
- **Dynamic Delta Thresholds**: Adjusted BTC Delta requirements to be relative to recent 1H average volume rather than a fixed number.
- **Removed Session Constraints**: Shifted focus to structural triggers rather than specific UTC windows to capture volatility regardless of time.

---

## 1. ENHANCED CORRELATION FRAMEWORK

### Dynamic Correlation & Relative Strength
```
CORRELATION STATES:
├── HIGH (>0.90): BTC crash/pump → DOGE amplifies 2-3x → TRADE
├── MEDIUM (0.75-0.90): Normal trending → DOGE follows 1.5x → TRADE  
├── LOW/DECOUPLED (<0.75): DOGE daily % negative while BTC is positive → TRADE (Relative Weakness Short)
└── OVEREXTENDED: 
    ├── DOGE 24h% > 3x BTC 24h% → AVOID SHORTING (Selling Exhaustion/Mean Reversion Risk)
    └── DOGE 24h% > 3x BTC 24h% (Positive) → AVOID LONGS (Buying Exhaustion)
```

---

## 2. REFINED MULTI-TIMEFRAME MATRIX

| Timeframe | BTC Analysis | Weight | Specific Criteria |
|-----------|-------------|--------|-------------------|
| **1D** | Trend Filter | 30% | Price vs 21 EMA + 50 EMA slope direction |
| **4H** | Structure | 20% | Last swing high/low + current OB location |
| **1H** | Momentum | 30% | BTC Delta (>Avg 10-candle Vol) + Altcoin Sector Trend |
| **1M** | Trigger | 20% | Entry timing (3-candle stabilization + structural shift) |

---

## 3. PRECISE ENTRY TRIGGERS

### Long Scalp Entry Checklist:
```
□ BTC 1H: Price > 21 EMA AND BTC Delta sum (10 candles) is positive and rising.
□ SECTOR: BTC, ETH, and SOL must all be trading above their 1H 21 EMAs.
□ DOGE 1H: CVD must be making higher lows (confirms accumulation).
□ BTC 1M: Liquidity sweep below recent low + 3 consecutive closes above reclaim level.
□ DOGE 1M: 
   - Correlation > 0.80 (60-period)
   - Relative Strength: DOGE 24h% is between 0.5x and 2.0x of BTC 24h%
   - Parameter Check: SL must be < Entry; TP must be > Entry.
```

### Short Scalp Entry Checklist:
```
□ BTC 1H: Price < 21 EMA OR BTC rejecting key 1H/4H resistance levels.
□ BTC 1M: Liquidity sweep above recent high + 1M Lower High formation.
□ DOGE 1M: 
   - DOGE CVD: Declining spot CVD or Bearish Divergence (Price flat/up, CVD down).
   - Relative Weakness: DOGE underperforming BTC (DOGE negative vs BTC flat/positive).
   - DOGE Price > 0.2% above Daily/Session Low (prevents shorting the floor).
   - DOGE/BTC RS Ratio < 3.0 (Ensures move isn't already exhausted).
   - Parameter Check: SL must be > Entry; TP must be < Entry.
```

---

## 4. EXIT STRATEGY (The "Profit Guard")

### Take Profit (TP):
- **TP1**: 0.4% - 0.5% (Close 60% of position - locked in sooner).
- **TP2**: 1.0% - 1.5% (Close remaining 40%).
- **Dynamic TP**: If BTC delta flips aggressively (e.g., +300K to -100K), exit all immediately.

### Stop Loss (SL):
- **Hard SL**: 0.35% from entry. **CRITICAL**: For LONG, SL = Entry * 0.9965. For SHORT, SL = Entry * 1.0035.
- **Time SL**: If trade hasn't hit TP1 within 15 minutes, exit at market.
- **Break-even SL**: Move SL to entry + fees immediately once TP1 is hit.

---

## 5. DYNAMIC TRADE MANAGEMENT

```
IF position open > 10 min AND profit > 0.20%:  
    → Move SL to Entry + Fees
    
IF BTC 1M reclaims/breaks the trigger level (the high/low of the sweep):
    → EXIT IMMEDIATELY (Thesis invalidated)

IF DOGE CVD diverges sharply against trade direction:
    → EXIT IMMEDIATELY
```

---

## 6. ADDITIONAL FILTERS (Risk Reduction)

### Relative Strength Filter (CRITICAL):
```
DOGE/BTC 24h Performance Ratio:
├── > 3.0: DOGE overextended → AVOID SHORTS (Extreme risk of technical bounce)
├── < 0.2: DOGE decoupled/weak → AVOID LONGS (Unless specific recovery pattern)
└── 0.5 to 2.5: Healthy Correlation → Trade Lag/Lead Setups
```

### Funding Rate & Open Interest:
- **Funding**: Avoid longs if DOGE Funding > +0.05% (Longs too crowded).
- **OI**: Entry should ideally be supported by rising Open Interest.

---

## 7. DAILY WORKFLOW

1. Identify BTC 1H/4H Trend and 1M Liquidity Sweep zones.
2. Monitor DOGE Spot CVD for divergences against BTC price action.
3. Verify ETH/SOL 1H EMA status to confirm "Rising Tide" or "Sinking Ship."
4. Set automated alerts for BTC 1M Structural Shifts (Lower Highs/Higher Lows).

---

## 8. ENHANCED RISK RULES

```
HARD RULES:
├── Max 3 trades per day
├── Stop trading after 2 consecutive losses
├── Daily loss limit: 1.0%
├── No position held through 8-hour funding marks
├── Max leverage: 5x
└── Always use Isolated Margin
```

---

IMPORTANT:
At the end of your analysis, you MUST provide a JSON block with the final trade decision.
The JSON block must be strictly formatted as follows:
```json
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
```
If the decision is HOLD, quantity and leverage can be 0 or null.
If orderType is LIMIT, 'entry' is the limit price. If MARKET, 'entry' is current price (for reference).
Ensure 'stopLoss' and 'takeProfit' are always provided for BUY/SELL decisions.
