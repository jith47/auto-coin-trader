/**
 * Grok Strategy Module Tests
 * 
 * This script tests the individual components of the Grok Strategy v4.0
 * without placing any actual trades.
 */

import { DeltaDataClient } from "../api/binance_delta_client.js";
import { GrokStrategyEngine } from "../api/grok_strategy_engine.js";

async function testBinanceClient() {
    console.log("\n--- Testing Binance Delta Client ---");
    const client = new DeltaDataClient(["BTCUSDT", "DOGEUSDT"]);

    return new Promise((resolve) => {
        let dataReceived = false;
        client.onData = (snapshot) => {
            const btcReady = snapshot.btc.price > 0 && snapshot.btc.klines["1m"].open > 0 && snapshot.btc.fundingRate !== 0;
            const dogeReady = snapshot.doge.price > 0 && snapshot.doge.klines["1m"].open > 0 && snapshot.doge.fundingRate !== 0;
            const metricsReady = snapshot.correlation !== 0;

            if (!dataReceived && btcReady && dogeReady && metricsReady) {
                console.log("✅ Data received from Binance WebSocket & REST API (Full Sync)");
                console.log("\n--- FULL DATA SNAPSHOT ---");

                const cleanSnapshot = JSON.parse(JSON.stringify(snapshot));
                delete cleanSnapshot.btc.priceHistory;
                delete cleanSnapshot.btc.klineHistory;
                delete cleanSnapshot.btc.atrHistory;
                delete cleanSnapshot.doge.priceHistory;
                delete cleanSnapshot.doge.klineHistory;
                delete cleanSnapshot.doge.atrHistory;
                delete cleanSnapshot.corrHistory;

                console.log(JSON.stringify(cleanSnapshot, null, 2));

                console.log("\n--- KEY METRICS ---");
                console.log(`BTC Price: $${snapshot.btc.price}`);
                console.log(`DOGE Price: $${snapshot.doge.price}`);
                console.log(`Correlation: ${snapshot.correlation.toFixed(4)}`);
                console.log(`Lag Score: ${snapshot.lagScore.toFixed(4)}`);

                dataReceived = true;
                client.disconnect();
                resolve(true);
            }
        };

        client.connect();

        setTimeout(() => {
            if (!dataReceived) {
                console.log("❌ Timeout waiting for Binance data");
                client.disconnect();
                resolve(false);
            }
        }, 15000);
    });
}

async function testStrategyEngine() {
    console.log("\n--- Testing Grok Strategy Engine (Logic Check) ---");
    const engine = new GrokStrategyEngine();

    // Mock snapshot
    const mockSnapshot = {
        btc: {
            price: 95000,
            lastLow: 95050,
            sweepOccurred: false,
            deltaSum3: 600000,
            ohlc: { volume: 1000, open: 94000, high: 95100, low: 93900, close: 95000 }
        },
        doge: {
            price: 0.14,
            ohlc: { open: 0.1398, high: 0.1401, low: 0.1397, close: 0.14 },
            fundingRate: 0.01,
            deltaSum3: 1000,
            cvd: 5000,
            atr14: 0.001,
            sessionLow: 0.138
        },
        correlation: 0.95,
        lagScore: 3.0,
        corrHistory: [0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.8, 0.95], // 9 elements, dip at 8th, spike at 9th
        timestamp: Date.now()
    };

    // Mock engine state
    engine.btc1hEMA21 = 90000;
    engine.btcVolumeMA20 = 100;

    // Mock kline history for FVG and DOGE flat check
    const mockKlines = [
        { open: 94000, high: 94100, low: 93900, close: 94050 }, // c1
        { open: 94050, high: 94200, low: 94000, close: 94150 }, // c2
        { open: 94150, high: 94300, low: 94200, close: 94250 }  // c3
    ];
    const mockDogeKlines = Array(5).fill({ open: 0.1398, close: 0.14 });

    engine.client.data["BTCUSDT"].klineHistory["1m"] = mockKlines;
    engine.client.data["DOGEUSDT"].klineHistory["1m"] = mockDogeKlines;

    console.log("Testing LONG signal detection with Sweep-and-Reclaim...");

    // 1. Simulate Sweep
    mockSnapshot.btc.price = 95030; // Dipped $20 below lastLow (95050)
    engine.evaluate(mockSnapshot);
    console.log(`Sweep Occurred: ${mockSnapshot.btc.sweepOccurred}`);

    // 2. Simulate Reclaim
    mockSnapshot.btc.price = 95060; // Reclaimed above lastLow
    mockSnapshot.doge.price = 0.1405; // (0.1405 - 0.1398) / 0.1398 * 100 = 0.5% (Target >= 0.31%)

    let signalDetected = false;
    engine.onSignal = (signal) => {
        console.log(`✅ Signal Detected: ${signal.decision}`);
        console.log(`Reason: ${signal.reason}`);
        signalDetected = true;
    };

    // Add temporary logging to engine.evaluate for debugging
    const originalEvaluate = engine.evaluate;
    engine.evaluate = (snapshot) => {
        console.log("\n--- Evaluating Conditions ---");
        const doge1m = snapshot.doge.ohlc;
        const btc = snapshot.btc;
        const btc1m = btc.ohlc;
        const btcReclaimed = btc.sweepOccurred && btc.price > btc.lastLow;
        const btcHighVol = btc1m.volume >= engine.btcVolumeMA20 * 3.4;
        const dogeHistory = engine.client.data["DOGEUSDT"].klineHistory["1m"];
        const dogeIsDeadFlat = dogeHistory.length >= 5 && dogeHistory.slice(-5).every(k => {
            const move = Math.abs(k.close - k.open) / k.open * 100;
            return move < 0.28;
        });

        const checks = {
            btcTrend: snapshot.btc.price > engine.btc1hEMA21,
            btcSweep: btcReclaimed,
            btcFvg: engine.client.hasFVG("BTCUSDT", "BUY"),
            btcDelta: snapshot.btc.deltaSum3 >= 580000,
            lagScore: snapshot.lagScore >= 2.65,
            corrSpike: engine.hasCorrSpike(snapshot),
            dogeFlat: dogeIsDeadFlat,
            funding: snapshot.doge.fundingRate <= 0.038,
            btcVol: btcHighVol
        };
        console.log("Checks:", checks);

        const dogeMove = (snapshot.doge.price - doge1m.open) / doge1m.open * 100;
        console.log(`DOGE Entry Move: ${dogeMove.toFixed(2)}% (Target >= 0.31%)`);

        return originalEvaluate.call(engine, snapshot);
    };

    engine.evaluate(mockSnapshot);

    if (signalDetected) {
        console.log("✅ Sweep-and-Reclaim logic verified");

        console.log("\nTesting FVG Break Exit...");
        // FVG level for BUY is history[0].high = 94100
        mockSnapshot.btc.price = 94000; // Break FVG
        engine.checkExit(mockSnapshot);
        if (engine.activeTrade === null) {
            console.log("✅ FVG Break Exit verified");
        }
    } else {
        console.log("❌ Signal failed to trigger in test");
    }
}

async function runTests() {
    console.log("🚀 Starting Grok Strategy Module Tests...");

    const clientOk = await testBinanceClient();
    if (clientOk) {
        await testStrategyEngine();
    }

    console.log("\n--- Tests Completed ---");
    process.exit(0);
}

runTests().catch(console.error);
