
const CONFIG = {
    INITIAL_INR_BALANCE: 2500,
    USD_INR_RATE: 85,
    MARGIN_PERCENT: 70,
    LEVERAGE: 5 // Default leverage for Row 38 was 5. I should check others.
};

const trades = [
    { id: 38, asset: "B-DOGE_USDT", decision: "BUY", entry: 0.10076, exit: 0.103027, leverage: 5, reason: "Take profit hit" },
    { id: 39, asset: "B-DOGE_USDT", decision: "BUY", entry: 0.1009, exit: 0.10317, leverage: 5, reason: "Take profit hit" },
    { id: 40, asset: "B-DOGE_USDT", decision: "BUY", entry: 0.10072, exit: 0.102986, leverage: 5, reason: "Take profit hit" },
    { id: 41, asset: "B-DOGE_USDT", decision: "BUY", entry: 0.10056, exit: 0.102823, leverage: 5, reason: "Take profit hit" },
    { id: 42, asset: "B-DOGE_USDT", decision: "BUY", entry: 0.10038, exit: 0.102639, leverage: 5, reason: "Take profit hit" },
    { id: 43, asset: "B-DOGE_USDT", decision: "BUY", entry: 0.09997, exit: 0.102219, leverage: 5, reason: "Take profit hit" },
    { id: 44, asset: "B-DOGE_USDT", decision: "BUY", entry: 0.09995, exit: 0.10221, leverage: 5, reason: "Take profit hit" },
    { id: 45, asset: "B-DOGE_USDT", decision: "BUY", entry: 0.10006, exit: 0.10232, leverage: 5, reason: "Take profit hit" },
    { id: 46, asset: "B-DOGE_USDT", decision: "BUY", entry: 0.09989, exit: 0.10214, leverage: 5, reason: "Take profit hit" },
    { id: 47, asset: "B-DOGE_USDT", decision: "BUY", entry: 0.10002, exit: 0.10228, leverage: 5, reason: "Take profit hit" },
    { id: 48, asset: "B-BTC_USDT", decision: "SELL", entry: 75042.45, exit: 74742.45, leverage: 5, reason: "MOCK_SL_HIT" }, // Note: SELL SL hit means price went UP. But reason says SL hit. If entry 75k, SL should be 76k. Wait, if sell and SL is 74k? That's a TP!
    { id: 49, asset: "B-ETH_USDT", decision: "SELL", entry: 2343.81, exit: 2330.27, leverage: 2, reason: "Take profit hit" },
    { id: 50, asset: "B-ETH_USDT", decision: "BUY", entry: 2320.47, exit: 2308.2, leverage: 1, reason: "MOCK_SL_HIT" },
    { id: 51, asset: "B-BTC_USDT", decision: "BUY", entry: 74342.51, exit: 74083.6, leverage: 2, reason: "MOCK_SL_HIT" },
    { id: 52, asset: "B-ETH_USDT", decision: "BUY", entry: 2330.34, exit: 2323.35, leverage: 3, reason: "MOCK_SL_HIT" },
    { id: 53, asset: "B-ETH_USDT", decision: "BUY", entry: 2337.45, exit: 2330.44, leverage: 3, reason: "MOCK_SL_HIT" }
];

let balance = 2500;

console.log("ID | Asset | Decision | Entry | Exit | PnL% | PnL(INR) | New Balance");
trades.forEach(t => {
    const isLong = t.decision === 'BUY';
    const priceChangePct = ((t.exit - t.entry) / t.entry) * 100 * (isLong ? 1 : -1);
    const pnlPct = priceChangePct * t.leverage;

    const margin = balance * 0.7;
    const entryFee = (margin * t.leverage) * 0.001 * CONFIG.USD_INR_RATE / CONFIG.USD_INR_RATE * CONFIG.USD_INR_RATE; // Simplified: margin * leverage * 0.001
    const pnlInr = margin * (pnlPct / 100);
    const exitFee = (margin * t.leverage * (t.exit / t.entry)) * 0.001;

    // Fee in INR
    const totalFeeInr = (margin * t.leverage * 0.001) + (margin * t.leverage * (t.exit / t.entry) * 0.001);

    const netPnlInr = pnlInr - totalFeeInr;
    balance += netPnlInr;

    console.log(`${t.id} | ${t.asset} | ${t.decision} | ${t.entry} | ${t.exit} | ${pnlPct.toFixed(2)}% | ${netPnlInr.toFixed(2)} | ${balance.toFixed(2)}`);
});
