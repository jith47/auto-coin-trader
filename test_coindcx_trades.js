
import { getTradeHistory } from './src/coindcx.js';
import dotenv from 'dotenv';
import fs from 'fs';

// Load .dev.vars manually
const devVars = fs.readFileSync('.dev.vars', 'utf8');
const env = {};
devVars.split('\n').forEach(line => {
    const parts = line.split('=');
    if (parts.length === 2) {
        env[parts[0].trim()] = parts[1].trim().replace(/^"(.*)"$/, '$1');
    }
});

async function test() {
    console.log("Fetching trade history...");
    try {
        const trades = await getTradeHistory(env);
        console.log("Raw response from CoinDCX:");
        console.log(JSON.stringify(trades, null, 2));
    } catch (e) {
        console.error("Error:", e);
    }
}

test();
