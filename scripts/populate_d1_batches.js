import fs from 'fs';
import { execSync } from 'child_process';

const data = JSON.parse(fs.readFileSync('tick_logs.json', 'utf8'));
const allTicks = data[0].results.slice(0, 2000);
console.log(`Loaded ${allTicks.length} ticks. Importing...`);

const BATCH_SIZE = 100;
for (let i = 0; i < allTicks.length; i += BATCH_SIZE) {
    const batch = allTicks.slice(i, i + BATCH_SIZE);
    let sql = 'INSERT INTO tick_logs (timestamp, symbol, price, open_interest, accumulation_score, minutes_accumulating, direction, taker_ratio, top_trader_delta, retail_long_pct, price_slope, atr_pct, cross_asset_status, tick_oi_acceleration) VALUES \n';

    const vals = batch.map(t => {
        const cleanDir = (t.direction || 'UNCLEAR').replace(/'/g, "''").toUpperCase();
        const cleanStatus = (t.cross_asset_status || 'BOTH_QUIET').replace(/'/g, "''").toUpperCase();
        return `(${t.timestamp}, '${t.symbol}', ${t.price}, ${t.open_interest}, ${t.accumulation_score || 0}, ${t.minutes_accumulating || 0}, '${cleanDir}', ${t.taker_ratio || 1}, ${t.top_trader_delta || 0}, ${t.retail_long_pct || 0.5}, ${t.price_slope || 0}, ${t.atr_pct || 0.005}, '${cleanStatus}', ${t.tick_oi_acceleration || 0})`;
    }).join(',\n');

    fs.writeFileSync('temp_batch.sql', sql + vals + ';');
    try {
        execSync(`npx wrangler d1 execute hypo_trade_db --file=temp_batch.sql --local`, { stdio: 'inherit' });
    } catch (e) {
        console.error(`Error at batch ${i}:`, e.message);
    }
}
console.log('Population complete.');
