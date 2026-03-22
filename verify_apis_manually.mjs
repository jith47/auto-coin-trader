
async function run() {
    const URL = 'http://127.0.0.1:8788';
    const PASSWORD = 'scalper2025@A';

    console.log("🚀 Starting Manual API Verification...");

    try {
        // 0. Login to get token
        console.log("0/2 Logging in...");
        const loginRes = await fetch(`${URL}/api/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: PASSWORD })
        });
        const loginData = await loginRes.json();
        if (!loginData.success) throw new Error("Login failed: " + loginData.error);
        const token = loginData.token;
        console.log("✅ Authenticated.");

        const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };

        // 1. Call Optimize API
        console.log("1/2 Calling /api/optimize...");
        const optRes = await fetch(`${URL}/api/optimize`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ mode: 'BALANCED' })
        });

        if (!optRes.ok) throw new Error(`Optimize API failed: ${optRes.status} ${optRes.statusText}`);
        const optData = await optRes.json();
        const best = optData[0];

        if (!best) {
            console.log("❌ No strategy found by optimizer.");
            return;
        }

        const symbols = Object.keys(best.summary.bySymbol);
        const targetSymbol = symbols.find(s => best.summary.bySymbol[s].traded > 0);

        if (!targetSymbol) {
            console.log("❌ Optimizer found zero trades for all symbols in the best strategy.");
            return;
        }

        const optS = best.summary.bySymbol[targetSymbol];
        console.log(`✅ Optimizer found best strategy (${targetSymbol} focused): ${best.score.toFixed(2)} score.`);

        // 2. Call Backtest API with the best params
        console.log(`2/2 Calling /api/backtest for ${targetSymbol}...`);
        const p = best.params;
        const backtestParams = {
            symbol: targetSymbol,
            tpSlRatio: p.TP_SL_RATIO,
            accEntryThreshold: p.ACC_ENTRY_THRESHOLD,
            takerThresh: p.TAKER_THRESH,
            slopeThresh: p.SLOPE_THRESH,
            timeCutMin: p.TIME_CUT_MIN,
            absorptionThresh: p.ABSORPTION_THRESH,
            beTriggerPct: p.BE_TRIGGER_PCT,
            slAtrMult: p.SL_ATR_MULT,
            limit: 2000
        };

        const btRes = await fetch(`${URL}/api/backtest`, {
            method: 'POST',
            headers,
            body: JSON.stringify(backtestParams)
        });

        if (!btRes.ok) {
            const errData = await btRes.json().catch(() => ({}));
            console.log(`❌ Backtest API failed: ${btRes.status} ${btRes.statusText}`);
            console.log("Error details:", JSON.stringify(errData, null, 2));
            return;
        }
        const btData = await btRes.json();

        // 3. Compare Results
        const btS = btData.newSummary.bySymbol[targetSymbol] || { wins: 0, losses: 0, pnl: 0, traded: 0 };
        const optWinRate = Math.round((optS.wins / optS.traded) * 100);
        const btWinRate = btS.traded > 0 ? Math.round((btS.wins / btS.traded) * 100) : 0;

        console.log(`\n📊 COMPARISON RESULTS (${targetSymbol}):`);
        console.log("-----------------------------------------");
        console.log(`Metric      | Optimizer   | Backtester  | Match?`);
        console.log("-----------------------------------------");
        console.log(`Win Rate    | ${optWinRate}%       | ${btWinRate}%       | ${optWinRate === btWinRate ? '✅' : '❌'}`);
        console.log(`Trade Count | ${optS.traded}         | ${btS.traded}         | ${optS.traded === btS.traded ? '✅' : '❌'}`);
        console.log(`Net PnL     | ₹${optS.pnl.toFixed(2)}  | ₹${btS.pnl.toFixed(2)} | ${Math.abs(optS.pnl - btS.pnl) < 1 ? '✅' : '❌'}`);
        console.log("-----------------------------------------");

        if (optWinRate === btWinRate && optS.traded === btS.traded) {
            console.log("\n🎉 PARITY CONFIRMED! Both APIs are returning mathematically identical results.");
        } else {
            console.log("\n⚠️ DISCREPANCY DETECTED! Check the table above.");
        }

    } catch (e) {
        console.error("❌ Error during verification:", e.message);
    }
}

run();
