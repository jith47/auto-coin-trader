
import { StrategyService } from '../src/strategy_service.js';
import {
    computeRSI,
    detectVolumeSpike,
    detectBtcEthDivergence,
    detectWickReversal,
    evalDirectionalAlignment,
    evalRSIMeanReversion,
    evalVolumeSikeMomentum,
    evalBtcEthDivergence,
    evalWickReversal,
    runAllStrategies,
} from '../src/strategies.js';

async function testPositionSizing() {
    console.log('--- Testing Position Sizing ---');
    const service = new StrategyService({});

    const entry = 0.1;
    const sl = 0.099; // 1% SL
    const balanceInr = 2500;

    service.stepSize = 1;
    const qty = await service.calculateQuantity(entry, sl, balanceInr);
    console.log(`Entry: ${entry}, SL: ${sl}, Balance: ${balanceInr} INR`);
    console.log(`Calculated Qty: ${qty}`);

    const expectedQty = Math.floor(((2500 / 85) * 0.7 * 2) / entry);
    if (qty === expectedQty) {
        console.log('✅ Position sizing test passed!');
    } else {
        console.log(`❌ Position sizing test failed! Expected: ${expectedQty}, Got: ${qty}`);
    }
}

async function testRSI() {
    console.log('\n--- Testing RSI Calculation ---');
    // Create synthetic klines: 20 candles with rising prices
    const klines = [];
    for (let i = 0; i < 20; i++) {
        klines.push({ close: 100 + i * 0.5 }); // steadily rising
    }
    const rsi = computeRSI(klines, 14);
    console.log(`RSI value: ${rsi.value.toFixed(1)}, trend: ${rsi.trend}`);

    if (rsi.value >= 50) {
        console.log('✅ RSI calculation test passed!');
    } else {
        console.log(`❌ RSI calculation test failed! Expected >=50, Got: ${rsi.value}`);
    }
}

async function testVolumeSpike() {
    console.log('\n--- Testing Volume Spike Detection ---');
    const klines = [];
    // 30 normal candles
    for (let i = 0; i < 30; i++) {
        klines.push({ open: 100, high: 101, low: 99, close: 100.5, volume: 100 });
    }
    // 3 spike candles (green, 5x volume)
    for (let i = 0; i < 3; i++) {
        klines.push({ open: 100, high: 102, low: 100, close: 101.5, volume: 500 });
    }
    const spike = detectVolumeSpike(klines);
    console.log(`Detected: ${spike.detected}, Direction: ${spike.direction}, Ratio: ${spike.volumeRatio?.toFixed(1)}`);

    if (spike.detected && spike.direction === 'BUY' && spike.volumeRatio >= 2.0) {
        console.log('✅ Volume Spike test passed!');
    } else {
        console.log('❌ Volume Spike test failed!');
    }
}

async function testBtcEthDivergence() {
    console.log('\n--- Testing BTC-ETH Divergence ---');
    const div = detectBtcEthDivergence(0.5, 0.05);
    console.log(`Detected: ${div.detected}, Direction: ${div.direction}, Gap: ${div.gap?.toFixed(2)}`);

    if (div.detected && div.direction === 'BUY' && div.gap > 0.3) {
        console.log('✅ BTC-ETH Divergence test passed!');
    } else {
        console.log('❌ BTC-ETH Divergence test failed!');
    }
}

async function testWickReversal() {
    console.log('\n--- Testing Wick Reversal ---');
    const klines = [];
    // 30 normal candles
    for (let i = 0; i < 30; i++) {
        klines.push({ open: 100, high: 101, low: 99, close: 100.5, volume: 100 });
    }
    // 1 bullish wick reversal candle: long lower wick, green close, high volume
    klines.push({ open: 98, high: 100.5, low: 95, close: 100, volume: 200 });
    // range = 5.5, lower wick = 98-95 = 3, ratio = 3/5.5 = 0.545 (need >0.6)
    // Adjust: open=99.5, close=100.3, low=96, high=100.5 => range=4.5, lowerWick=(99.5-96)=3.5, ratio=3.5/4.5=0.77
    klines[klines.length - 1] = { open: 99.5, high: 100.5, low: 96, close: 100.3, volume: 200 };

    const wick = detectWickReversal(klines);
    console.log(`Detected: ${wick.detected}, Direction: ${wick.direction}, Wick: ${wick.wickRatio?.toFixed(2)}`);

    if (wick.detected && wick.direction === 'BUY') {
        console.log('✅ Wick Reversal test passed!');
    } else {
        console.log('❌ Wick Reversal test failed!');
    }
}

async function testMultiStrategyRunner() {
    console.log('\n--- Testing Multi-Strategy Runner ---');
    // Create indicators where DIRECTIONAL_ALIGNMENT and VOLUME_SPIKE should both fire
    const ind = {
        btc: { structure: 'breakout', change1h: 0.5, change5m: 0.2, cvdDirection: 'rising', cvdSlope: 'steep' },
        eth: {
            price: 1900,
            cvdDirection: 'rising', cvdSlope: 'steep', change5m: 0.3, change1h: 0.5,
            relativeStrength: 'stronger',
            klines: [], // empty for non-kline strategies
            distFromHigh: 5, distFromLow: 3,
        },
        sector: { bias: 'bullish' },
    };

    const result = runAllStrategies(ind, 60);
    console.log(`Winner: ${result?.type} ${result?.direction} score=${result?.score}`);

    if (result && result.direction === 'BUY' && result.score >= 60) {
        console.log('✅ Multi-Strategy Runner test passed!');
    } else {
        console.log('❌ Multi-Strategy Runner test failed!');
    }
}

async function runTests() {
    try {
        await testPositionSizing();
        await testRSI();
        await testVolumeSpike();
        await testBtcEthDivergence();
        await testWickReversal();
        await testMultiStrategyRunner();
    } catch (err) {
        console.error('Test error:', err);
    }
}

runTests();
