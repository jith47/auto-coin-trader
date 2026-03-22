import fs from 'fs';
import { execSync } from 'child_process';

const ticks = JSON.parse(fs.readFileSync('tick_logs.json', 'utf8')).slice(0, 2000);
console.log(`Loaded ${ticks.length} ticks from JSON.`);

const sqlFile = 'temp_ticks.sql';
let sql = 'INSERT INTO tick_logs (timestamp, symbol, price, open_interest, accumulation_score, minutes_accumulating, direction, taker_ratio, top_trader_delta, retail_long_pct, price_slope, atr_pct, cross_asset_status, tick_oi_acceleration) VALUES \n';

const vals = ticks.map(t => `(${t.timestamp}, '${t.symbol}', ${t.price}, ${t.open_interest}, ${t.accumulation_score || 0}, ${t.minutes_accumulating || 0}, '${t.direction || 'UNCLEAR'}', ${t.taker_ratio || 1}, ${t.top_trader_delta || 0}, ${t.retail_long_pct || 0.5}, ${t.price_slope || 0}, ${t.atr_pct || 0.005}, '${t.cross_asset_status || 'BOTH_QUIET'}', ${t.tick_oi_acceleration || 0})`).join(',\n');

fs.writeFileSync(sqlFile, sql + vals + ';');
console.log('SQL file generated. Executing...');
execSync(`npx wrangler d1 execute hypo_trade_db --file=${sqlFile} --local`, { stdio: 'inherit' });
console.log('Done!');
