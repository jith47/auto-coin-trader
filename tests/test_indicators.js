import { computeEMA, computeRSI, computeATR, computeVolumeSMA, computeAllIndicators } from '../src/binance.js';

// ─── Test Helpers ───
let passed = 0, failed = 0;
function assert(condition, label) {
    if (condition) { console.log(`  ✅ ${label}`); passed++; }
    else { console.error(`  ❌ ${label}`); failed++; }
}
function approx(a, b, tolerance = 0.01) {
    return Math.abs(a - b) < tolerance;
}

// ─── Test EMA ───
function testEMA() {
    console.log('\n─── EMA Tests ───');
    const data = [22, 22.27, 22.19, 22.08, 22.17, 22.18, 22.13, 22.23, 22.43, 22.24, 22.29, 22.15];

    // EMA(5) on this data
    const ema5 = computeEMA(data, 5);

    // First 4 should be NaN
    assert(isNaN(ema5[0]), 'EMA[0] is NaN');
    assert(isNaN(ema5[3]), 'EMA[3] is NaN');

    // EMA[4] = SMA of first 5 = (22 + 22.27 + 22.19 + 22.08 + 22.17) / 5 = 22.142
    assert(approx(ema5[4], 22.142), `EMA[4] = SMA seed: ${ema5[4].toFixed(4)} ≈ 22.142`);

    // EMA[5] = 22.18 * (2/6) + 22.142 * (4/6) = 22.1547
    const expected5 = 22.18 * (2 / 6) + 22.142 * (4 / 6);
    assert(approx(ema5[5], expected5, 0.01), `EMA[5]: ${ema5[5].toFixed(4)} ≈ ${expected5.toFixed(4)}`);

    // Length must match
    assert(ema5.length === data.length, `EMA length: ${ema5.length} === ${data.length}`);
}

// ─── Test RSI ───
function testRSI() {
    console.log('\n─── RSI Tests ───');
    // Construct a simple series with known gains/losses
    // 14-period RSI: first 14 deltas needed
    const data = [44, 44.34, 44.09, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84,
        46.08, 45.89, 46.03, 45.61, 46.28, 46.28, 46.00, 46.03, 46.41, 46.22, 45.64];

    const rsi = computeRSI(data, 14);

    // First 14 should be NaN
    assert(isNaN(rsi[0]), 'RSI[0] is NaN');
    assert(isNaN(rsi[13]), 'RSI[13] is NaN');

    // RSI at index 14 should be a valid number between 0-100
    assert(!isNaN(rsi[14]), `RSI[14] is a number: ${rsi[14]?.toFixed(2)}`);
    assert(rsi[14] >= 0 && rsi[14] <= 100, `RSI[14] in range 0-100: ${rsi[14]?.toFixed(2)}`);

    // All subsequent should also be valid
    for (let i = 14; i < rsi.length; i++) {
        assert(!isNaN(rsi[i]) && rsi[i] >= 0 && rsi[i] <= 100, `RSI[${i}] valid: ${rsi[i]?.toFixed(2)}`);
    }
}

// ─── Test ATR ───
function testATR() {
    console.log('\n─── ATR Tests ───');
    // Simple kline data
    const klines = [];
    for (let i = 0; i < 20; i++) {
        const base = 100 + i * 0.5;
        klines.push({ high: base + 2, low: base - 1, close: base + 0.5 });
    }

    const atr = computeATR(klines, 5);

    // First 5 should be NaN (index 0 has no TR, so first valid at index 5)
    assert(isNaN(atr[0]), 'ATR[0] is NaN');
    assert(isNaN(atr[4]), 'ATR[4] is NaN');
    assert(!isNaN(atr[5]), `ATR[5] is a number: ${atr[5]?.toFixed(4)}`);

    // ATR should be positive
    assert(atr[5] > 0, `ATR[5] > 0: ${atr[5]?.toFixed(4)}`);

    // All subsequent should be valid and positive
    for (let i = 5; i < atr.length; i++) {
        assert(!isNaN(atr[i]) && atr[i] > 0, `ATR[${i}] valid: ${atr[i]?.toFixed(4)}`);
    }
}

// ─── Test Volume SMA ───
function testVolumeSMA() {
    console.log('\n─── Volume SMA Tests ───');
    const volumes = [100, 200, 300, 400, 500, 150, 250, 350];

    const sma3 = computeVolumeSMA(volumes, 3);

    assert(isNaN(sma3[0]), 'SMA[0] is NaN');
    assert(isNaN(sma3[1]), 'SMA[1] is NaN');
    assert(approx(sma3[2], 200), `SMA[2] = (100+200+300)/3 = ${sma3[2]}`);  // 200
    assert(approx(sma3[3], 300), `SMA[3] = (200+300+400)/3 = ${sma3[3]}`);  // 300
    assert(approx(sma3[4], 400), `SMA[4] = (300+400+500)/3 = ${sma3[4]}`);  // 400
}

// ─── Test Entry Signal Logic ───
function testEntryLogic() {
    console.log('\n─── Entry Signal Tests ───');

    // Build synthetic klines that should trigger a LONG signal:
    // - fastEMA > slowEMA (uptrend)
    // - close > trendEMA(200)
    // - low <= fastEMA AND close > fastEMA (pullback)
    // - RSI crosses above 50
    // - volume > volumeMA * 1.10

    // This is a high-level logic test — we just verify computeAllIndicators
    // returns the right derived flags when given appropriate data

    const config = {
        SYMBOL: 'BTCUSDT', INTERVAL: '5m',
        FAST_EMA: 3, SLOW_EMA: 5, TREND_EMA: 10,
        USE_TREND_200: true,
        RSI_LEN: 5, RSI_LONG: 50, RSI_SHORT: 50,
        VOL_LEN: 3, VOL_MULT: 1.10,
        ATR_LEN: 5,
    };

    // Create 20 klines with an uptrend
    const klines = [];
    for (let i = 0; i < 20; i++) {
        const base = 100 + i * 2; // strong uptrend
        klines.push({
            openTime: i * 300000,
            open: base - 0.5,
            high: base + 3,
            low: base - 2,
            close: base + 1,
            volume: 1000 + (i > 17 ? 500 : 0), // volume spike on last 2
            closeTime: (i + 1) * 300000,
        });
    }

    const result = computeAllIndicators(klines, config);

    assert(result !== null, 'computeAllIndicators returns non-null');
    assert(!isNaN(result.fastEma), `fastEma computed: ${result.fastEma?.toFixed(2)}`);
    assert(!isNaN(result.slowEma), `slowEma computed: ${result.slowEma?.toFixed(2)}`);
    assert(!isNaN(result.trendEma), `trendEma computed: ${result.trendEma?.toFixed(2)}`);
    assert(!isNaN(result.rsi), `RSI computed: ${result.rsi?.toFixed(2)}`);
    assert(!isNaN(result.atr), `ATR computed: ${result.atr?.toFixed(2)}`);
    assert(!isNaN(result.volumeMA), `volumeMA computed: ${result.volumeMA?.toFixed(2)}`);
    assert(result.trendUp === true, `trendUp = true (uptrend data): ${result.trendUp}`);
    assert(result.price > 0, `price > 0: ${result.price}`);
}

// ─── Run All ───
console.log('═══════════════════════════════════════');
console.log('  EMA Scalper — Indicator Tests');
console.log('═══════════════════════════════════════');

testEMA();
testRSI();
testATR();
testVolumeSMA();
testEntryLogic();

console.log('\n═══════════════════════════════════════');
console.log(`  Results: ${passed} passed, ${failed} failed`);
console.log('═══════════════════════════════════════');

if (failed > 0) process.exit(1);
