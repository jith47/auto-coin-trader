# Institutional Flow Rider v2.0

## Core Concept
Tracking institutional accumulation and distribution phases through Open Interest (OI), Taker Ratios, and Price Compression.

### Phase 1: Accumulation
- **Score Requirement**: ≥ 50/100
- **Duration**: Sustained for at least 5 minutes.
- **Components**:
    - **OI Trend Consistency (25 pts)**: Upward movement in OI.
    - **OI Acceleration (25 pts)**: Growth rate versus previous window.
    - **Absorption (25 pts)**: High volume with minimal price movement.
    - **Price Compression (25 pts)**: Narrowing ATR during accumulation.

### Phase 2: Entry Transition
Triggers when accumulation is sustained AND:
- **OI Acceleration**: Growth rate surges > 1.5x previous.
- **OR ATR Breakout**: Price volatility expands > 1.2x.

### Phase 3: Direction Bias
Need 2 out of 3:
- **Taker Ratio**: > 1.02 for LONG, < 0.98 for SHORT.
- **Top Trader Net Delta**: Postive/Negative shift in smart money positioning.
- **Linear Price Slope**: Direction of the price drift.

### Phase 4: Exit Management
- **Take Profit**: 50% at +1.5 ATR, Full at +2.5 ATR.
- **Stop Loss**: -1.5 ATR from entry.
- **Distribution Exits**:
    - **Volume Spike**: > 3x average without OI growth (Blow-off top).
    - **OI Drop**: > 0.5% drop in 3-minute window (Position closing).
    - **OI Deceleration**: 3 consecutive minutes of slowing growth.

## Safety Measures
- **Max Daily Losses**: 3 (Bot pauses for 24h).
- **Retail Bias Cap**: < 85% (Anti-trap filter).
- **Time Stop**: 60-minute maximum hold duration.
