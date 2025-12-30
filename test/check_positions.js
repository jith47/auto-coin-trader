import { getOpenPositions, getFuturesWallets } from '../src/coindcx.js';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

// Load .dev.vars if it exists
try {
    const devVarsPath = path.resolve(process.cwd(), '.dev.vars');
    if (fs.existsSync(devVarsPath)) {
        const devVars = fs.readFileSync(devVarsPath, 'utf8');
        devVars.split('\n').forEach(line => {
            const [key, value] = line.split('=');
            if (key && value) {
                process.env[key.trim()] = value.trim().replace(/^["']|["']$/g, '');
            }
        });
    }
} catch (e) {
    console.error("Error loading .dev.vars:", e);
}

const env = {
    COINDCX_API_KEY: process.env.COINDCX_API_KEY,
    COINDCX_SECRET_KEY: process.env.COINDCX_SECRET_KEY
};

async function check() {
    console.log("--- Checking CoinDCX Positions ---");

    if (!env.COINDCX_API_KEY || !env.COINDCX_SECRET_KEY) {
        console.error("Error: Missing API keys in .dev.vars or environment.");
        return;
    }

    try {
        console.log("Fetching open positions...");
        const positions = await getOpenPositions(env);
        console.log("RAW POSITIONS RESPONSE:", JSON.stringify(positions, null, 2));

        if (Array.isArray(positions)) {
            console.log(`Found ${positions.length} position records.`);
            positions.forEach((p, i) => {
                console.log(`\nPosition ${i + 1}:`);
                console.log(`  Pair: ${p.pair}`);
                console.log(`  Active Pos: ${p.active_pos}`);
                console.log(`  Net Quantity: ${p.net_quantity}`);
                console.log(`  Locked Margin: ${p.locked_margin}`);
                console.log(`  Status: ${p.status}`);
            });
        } else {
            console.log("Positions response is not an array. Check 'RAW POSITIONS RESPONSE' above.");
        }

        console.log("\n--- Checking Futures Wallets ---");
        const wallets = await getFuturesWallets(env);
        console.log("RAW WALLETS RESPONSE:", JSON.stringify(wallets, null, 2));

    } catch (error) {
        console.error("Error during check:", error);
    }
}

check();
