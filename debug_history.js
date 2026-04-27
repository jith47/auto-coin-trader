
import { getTradeHistory } from './src/coindcx.js';

async function main() {
    const env = {
        COINDCX_API_KEY: process.env.COINDCX_API_KEY,
        COINDCX_SECRET_KEY: process.env.COINDCX_SECRET_KEY
    };

    console.log("Fetching trade history...");
    const history = await getTradeHistory(env);
    console.log(JSON.stringify(history, null, 2));
}

main().catch(console.error);
