import { runBacktest } from './src/backtest_engine.js';
const dbMock = {
    prepare: (sql) => ({
        bind: () => ({ all: () => Promise.resolve({ results: [] }) }),
        all: () => {
            if (sql.includes('trades')) {
                return Promise.resolve({
                    results: [{
                        id: 'MOCK_BTC', symbol: 'BTCUSDT', direction: 'SHORT',
                        entry_price: 73828.11, exit_price: 71613.27,
                        entry_time: 1773726529997, exit_time: 1773728698285,
                        quantity: 0.0033, leverage: 10,
                        sl_price: 74714.04, tp_price: 71613.26
                    }]
                });
            }
            if (sql.includes('tick_logs')) {
                return Promise.resolve({
                    results: [
                        { symbol: 'BTCUSDT', price: 73828.11, timestamp: 1773726529997 },
                        { symbol: 'BTCUSDT', price: 71613.27, timestamp: 1773728698285 }
                    ]
                });
            }
            return Promise.resolve({ results: [] });
        }
    })
};

const res = await runBacktest(dbMock, { tpSlRatio: 2.5, leverage: 10 });
console.log('Result:', JSON.stringify(res, null, 2));
