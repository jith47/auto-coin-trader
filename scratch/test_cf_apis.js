async function testApis() {
    const urls = [
        'https://api.bybit.com/v5/market/funding/history?category=linear&symbol=ETHUSDT&limit=1',
        'https://api.bybit.com/v5/market/open-interest?category=linear&symbol=ETHUSDT&intervalTime=5min&limit=5',
        'https://api.bybit.com/v5/market/account-ratio?category=linear&symbol=ETHUSDT&period=5min&limit=5',
        'https://www.okx.com/api/v5/public/funding-rate?instId=ETH-USDT-SWAP',
        'https://www.okx.com/api/v5/public/open-interest?instType=SWAP&instId=ETH-USDT-SWAP',
        'https://www.okx.com/api/v5/rubik/stat/contracts/long-short-account-ratio?ccd=ETH',
        'https://fapi.binance.com/fapi/v1/premiumIndex?symbol=ETHUSDT',
        'https://api.alternative.me/fng/?limit=1'
    ];

    for (const url of urls) {
        try {
            const res = await fetch(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                }
            });
            console.log(`[${res.status}] ${url}`);
        } catch (e) {
            console.log(`[ERR] ${url}: ${e.message}`);
        }
    }
}

testApis();
