1. DOGE LAG SCORE
Window: Last 4 completed 1m candles

BTC_move = ((BTC_close_now - BTC_close_4min_ago) / BTC_close_4min_ago) * 100
DOGE_move = ((DOGE_close_now - DOGE_close_4min_ago) / DOGE_close_4min_ago) * 100

RULES:
IF abs(DOGE_move) < 0.02:
    Lag_Score = NULL
ELIF (DOGE_move > 0 AND BTC_move > 0) OR (DOGE_move < 0 AND BTC_move < 0):
    Lag_Score = abs(BTC_move) / abs(DOGE_move)
ELSE:
    Lag_Score = NULL

THRESHOLD: Lag_Score >= 2.65 required for entry

2. CORRELATION COEFFICIENT
Method: 60-period Pearson correlation on 1m closes between BTC and DOGE

Track over last 9 candles:
Corr_Min_9 = MIN(Correlation) over last 9 periods
Corr_Max_9 = MAX(Correlation) over last 9 periods
Corr_Current = Current correlation value

LONG SIGNAL: Corr_Min_9 <= 0.865 AND Corr_Current >= 0.938
SHORT SIGNAL: Corr_Max_9 >= 0.938 AND Corr_Current <= 0.865

3. DELTA PERCENTILE
Raw_Delta_3 = SUM(BTC buy volume - BTC sell volume) over last 3 candles
Delta_Percentile = Percentile rank of Raw_Delta_3 against last 500 candle readings

LONG: Delta_Percentile >= 92
SHORT: Delta_Percentile <= 8

4. VOLUME SPIKE
Volume_MA20 = SMA(Volume, 20)
Volume_Ratio = Current_1m_Volume / Volume_MA20

REQUIRED: Volume_Ratio >= 3.4

5. LIQUIDITY SWEEP DETECTION
Lookback = 20 candles

BULLISH SWEEP:
├── Current candle low < MIN(lows, last 20 candles)
├── Current candle close > that previous low
├── Current candle close > open
└── Volume_Ratio >= 3.4

BEARISH SWEEP:
├── Current candle high > MAX(highs, last 20 candles)
├── Current candle close < that previous high
├── Current candle close < open
└── Volume_Ratio >= 3.4

6. FAIR VALUE GAP (FVG)
BULLISH FVG:
├── Candle[-2].High < Candle[0].Low
├── Gap_Size = (Candle[0].Low - Candle[-2].High) / Candle[0].Close * 100
└── Gap_Size >= 0.04%

BEARISH FVG:
├── Candle[-2].Low > Candle[0].High
├── Gap_Size = (Candle[-2].Low - Candle[0].High) / Candle[0].Close * 100
└── Gap_Size >= 0.04%

STORE: FVG_Low and FVG_High boundaries at entry for exit logic

7. ATR FILTER
DOGE_ATR_14 = ATR(DOGE 1m, 14 periods)
ATR_Percent = (DOGE_ATR_14 / DOGE_Price) * 100

REQUIRED: ATR_Percent >= 0.08

8. TREND FILTER
BTC_21EMA_1H = EMA(BTC 1H close, 21)

LONG: BTC_1H_Close > BTC_21EMA_1H
SHORT: BTC_1H_Close < BTC_21EMA_1H

ENTRY CONDITIONS
LONG ENTRY
ALL conditions must be TRUE within 3-candle window:

1. BTC 1H close > 21 EMA
2. BTC 1m: Bullish sweep detected
3. BTC 1m: Bullish FVG created on sweep candle
4. BTC Delta_Percentile >= 92
5. DOGE Lag_Score >= 2.65 AND Lag_Score != NULL
6. Correlation: Corr_Min_9 <= 0.865 AND Corr_Current >= 0.938
7. DOGE max single candle move over last 4 candles < 0.28%
8. Funding rate <= +0.04%
9. ATR_Percent >= 0.08
10. Current spread <= 0.015%

EXECUTION TRIGGER:
Wait for DOGE 1m candle to CLOSE with:
├── (Close - Open) / Open * 100 >= 0.31%
├── Close > Open
└── Body / (High - Low) >= 0.60

ACTION: Market order LONG at next candle open

SHORT ENTRY
ALL conditions must be TRUE within 3-candle window:

1. BTC 1H close < 21 EMA
2. BTC 1m: Bearish sweep detected
3. BTC 1m: Bearish FVG created on sweep candle
4. BTC Delta_Percentile <= 8
5. DOGE Lag_Score >= 2.65 AND Lag_Score != NULL
6. Correlation: Corr_Max_9 >= 0.938 AND Corr_Current <= 0.865
7. DOGE max single candle move over last 4 candles < 0.28%
8. Funding rate >= -0.02%
9. ATR_Percent >= 0.08
10. Current spread <= 0.015%


EXECUTION TRIGGER:
Wait for DOGE 1m candle to CLOSE with:
├── (Open - Close) / Open * 100 >= 0.31%
├── Close < Open
└── Body / (High - Low) >= 0.60

ACTION: Market order SHORT at next candle open

EXIT STRATEGY
TAKE PROFIT
TP1:
├── Target: Entry +0.44% (long) / Entry -0.44% (short)
├── Action: Close 78% position
└── Order: Limit

TP2:
├── Target: Entry +1.18% (long) / Entry -1.18% (short)
├── Action: Close remaining 22%
└── Order: Limit

STOP LOSS
INITIAL:
├── Long: Entry - 0.29%
├── Short: Entry + 0.29%
└── Order: Stop-market

BREAK-EVEN ADJUSTMENT:
├── Trigger: Unrealized profit reaches +0.26%
└── Action: Move stop to Entry + 0.03%

FORCED EXIT CONDITIONS
Check every 10 seconds. Exit 100% at market if ANY condition TRUE:

1. TIME EXIT:
   Holding_Time >= 9 minutes 30 seconds AND TP1 not hit

2. DELTA FLIP:
   Delta moves against position by >= 720K raw value

3. FVG INVALIDATION:
   Long: Any 1m close < FVG_Low
   Short: Any 1m close > FVG_High

4. DOGE CATCH-UP:
   BTC_Move = (BTC_now - BTC_entry) / BTC_entry * 100
   DOGE_Move = (DOGE_now - DOGE_entry) / DOGE_entry * 100
   
   IF BTC_Move != 0:
       Catch_Up_Ratio = DOGE_Move / BTC_Move
       IF Catch_Up_Ratio >= 0.79: EXIT

POSITION SIZING
Risk_Per_Trade = 1.5% of Account_Balance
Stop_Distance = 0.29%
Position_Size = (Account_Balance * 0.015) / 0.0029
Leverage = Position_Size / Account_Balance

CAP: Maximum leverage = 10x

SESSION FILTERS
DO NOT TRADE (UTC):
├── 21:00 - 23:59
├── 04:00 - 05:30
├── FOMC/CPI/NFP announcements ± 30 minutes
└── First 5 minutes of any hour

DAILY LIMITS
├── Max daily loss: -3.0% → Stop all trading
├── Max trades per day: 5
├── 3 consecutive losses → Pause 4 hours
└── Daily profit +3.5% → Stop trading (protect gains)

TRADE LOGGING
Record for every trade:
├── Entry_Timestamp
├── Exit_Timestamp
├── Direction (LONG/SHORT)
├── Entry_Price
├── Exit_Price
├── BTC_Price_At_Entry
├── Lag_Score
├── Correlation_Value
├── Corr_Min_9
├── Corr_Max_9
├── Delta_Percentile
├── Volume_Ratio
├── Funding_Rate
├── ATR_Percent
├── FVG_Low
├── FVG_High
├── Exit_Reason (TP1/TP2/SL/BE/TIME/DELTA_FLIP/FVG_BREAK/CATCHUP)
├── Holding_Time_Seconds
├── PnL_Percent
└── PnL_USD

ERROR HANDLING
IF data feed interrupted > 5 seconds:
    Close any open position at market
    Pause new entries until feed restored for 60 seconds

IF spread > 0.03%:
    Do not enter new positions
    
IF exchange latency > 500ms:
    Pause trading until latency < 200ms for 30 seconds

IF position fill differs from expected by > 0.05%:
    Log slippage event
    Adjust TP/SL from actual fill price

EXECUTION PRIORITY
1. Check forced exit conditions (every 10 sec while in position)
2. Monitor TP/SL levels
3. Check for new entry signals (only if no position open)
4. Never hold more than 1 position simultaneously
5. Complete exit before considering new entry

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
```