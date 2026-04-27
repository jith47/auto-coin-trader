
import { getInstrumentDetails } from './src/coindcx.js';

async function main() {
    const details = await getInstrumentDetails('B-DOGE_USDT');
    console.log("Instrument Details:", JSON.stringify(details, null, 2));
}

main().catch(console.error);
