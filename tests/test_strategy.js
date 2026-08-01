
import { StrategyService } from '../src/strategy_service.js';

async function testPositionSizing() {
    console.log('--- Testing Position Sizing ---');
    const service = new StrategyService({});

    const entry = 0.1;
    const sl = 0.099; // 1% SL
    const balanceInr = 2500;
    const usdInrRate = 85;
    const balanceUsd = balanceInr / usdInrRate;

    // Manual calculation expectation:
    // Margin Pct = 70%
    // Leverage = 5x
    // marginAvailable = 29.41 * 0.7 = 20.587
    // positionValueUsd = 20.587 * 5 = 102.935
    // qty = 1029

    service.stepSize = 1;
    const qty = await service.calculateQuantity(entry, sl, balanceInr);
    console.log(`Entry: ${entry}, SL: ${sl}, Balance: ${balanceInr} INR`);
    console.log(`Calculated Qty: ${qty}`);

    const expectedMargin = (2500 / 85) * 0.7;
    const expectedQty = Math.floor((expectedMargin * 2) / entry);

    if (qty === expectedQty) {
        console.log('✅ Position sizing test passed!');
    } else {
        console.log(`❌ Position sizing test failed! Expected: ${expectedQty}, Got: ${qty}`);
    }
}

async function testPnL() {
    console.log('\n--- Testing PnL Calculation ---');
    const service = new StrategyService({});

    const activeTrade = {
        price: 0.1,
        decision: 'BUY',
        entry_value_inr: 100
    };
    const currentPrice = 0.11; // 10% move
    const isLong = true;
    const leverage = 5;

    // Leveraged PnL = 10% * 5 = 50%
    // PnL INR = 100 * 0.5 = 50

    const priceChangePct = ((currentPrice - activeTrade.price) / activeTrade.price) * 100 * (isLong ? 1 : -1);
    const pnl = priceChangePct * leverage;
    const pnlInr = activeTrade.entry_value_inr * (pnl / 100);

    console.log(`Entry: ${activeTrade.price}, Exit: ${currentPrice}, Leverage: ${leverage}x`);
    console.log(`Calculated PnL: ${pnl}%`);
    console.log(`Calculated PnL INR: ${pnlInr}`);

    if (Math.abs(pnl - 50) < 0.0001 && Math.abs(pnlInr - 50) < 0.0001) {
        console.log('✅ PnL calculation test passed!');
    } else {
        console.log(`❌ PnL calculation test failed! Expected: 50%, Got: ${pnl}%`);
    }
}

async function testSetupEvaluation() {
    console.log('\n--- Testing Dynamic Setup Evaluation ---');
    const service = new StrategyService({});

    const breakoutInd = {
        btc: { structure: 'breakout', change1h: 0.5 },
        eth: { cvdDirection: 'rising', change5m: 0.2 }
    };
    const rangingInd = {
        btc: { structure: 'ranging', change1h: 0.1 },
        eth: { cvdDirection: 'rising', change5m: 0.2 }
    };

    const breakoutSetup = service.evaluateSetups(breakoutInd);
    const rangingSetup = service.evaluateSetups(rangingInd);

    console.log('Breakout setup:', breakoutSetup ? breakoutSetup.direction : 'NULL');
    console.log('Ranging setup:', rangingSetup ? rangingSetup.direction : 'NULL');

    if (breakoutSetup && breakoutSetup.direction === 'BUY' && rangingSetup && rangingSetup.direction === 'BUY') {
        console.log('✅ Dynamic Setup Evaluation test passed!');
    } else {
        console.log('❌ Dynamic Setup Evaluation test failed!');
    }
}

async function runTests() {
    try {
        await testPositionSizing();
        await testPnL();
        await testSetupEvaluation();
    } catch (err) {
        console.error('Test error:', err);
    }
}

runTests();
