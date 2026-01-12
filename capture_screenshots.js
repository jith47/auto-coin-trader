import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

async function switchTimeframe(page, timeframe) {
    try {
        const timeframeMap = {
            "1m": "1m", "3m": "3m", "5m": "5m", "15m": "15m", "30m": "30m",
            "1h": "1H", "2h": "2H", "4h": "4H", "6h": "6H", "8h": "8H",
            "12h": "12H", "1d": "1D", "3d": "3D", "1w": "1W", "1M": "1M"
        };

        const targetText = timeframeMap[timeframe] || timeframe;
        const frames = page.frames();

        for (const frame of frames) {
            // 1. Try exact match on button text first (most reliable if visible)
            const exactBtn = frame.locator(`button:text-is("${targetText}")`).first();
            if (await exactBtn.count() > 0 && await exactBtn.isVisible()) {
                await exactBtn.click();
                await page.waitForTimeout(2000);
                return;
            }

            // 2. If exact match not found/visible, try finding the dropdown
            // Strategy: Find the last visible interval button (e.g. "1D", "1M", "1H") and click the next button.
            const visibleIntervals = ["1D", "1M", "1W", "1H", "30m", "5m", "1m"];

            // Get all buttons
            const allButtons = frame.locator('button');
            const count = await allButtons.count();
            let lastIntervalIndex = -1;

            for (let i = 0; i < count; i++) {
                const txt = await allButtons.nth(i).textContent();
                if (txt && visibleIntervals.includes(txt.trim())) {
                    // Keep updating to find the last one in the list
                    lastIntervalIndex = i;
                }
            }

            if (lastIntervalIndex !== -1 && lastIntervalIndex + 1 < count) {
                const dropdownTrigger = allButtons.nth(lastIntervalIndex + 1);
                console.log(`Clicking potential dropdown trigger at index ${lastIntervalIndex + 1} (after button ${lastIntervalIndex})`);
                await dropdownTrigger.click();
                await page.waitForTimeout(500);

                // Now look for the item in the menu
                // Menu items might be div[role="menuitem"] or span
                const menuItem = frame.locator(`div[role="menuitem"]:has-text("${targetText}"), span:text-is("${targetText}"), div:text-is("${targetText}")`).first();
                if (await menuItem.count() > 0) {
                    await menuItem.click();
                    await page.waitForTimeout(2000);
                    return;
                }
            }
        }

        console.log(`Warning: Could not find button for timeframe ${timeframe}`);

        // Debugging: Log all buttons in the frame to see what we have
        console.log("--- DEBUG: Available Buttons ---");
        for (const frame of frames) {
            const buttons = frame.locator('button');
            const count = await buttons.count();
            if (count > 0) console.log(`Frame: ${frame.url()}`);
            for (let i = 0; i < count; i++) {
                const txt = await buttons.nth(i).textContent();
                if (txt && txt.length < 20) {
                    console.log(`Button [${i}]: "${txt.trim()}"`);
                }
            }
        }

        // Take a debug screenshot
        await page.screenshot({ path: `debug_failure_${timeframe}.png` });
        console.log(`Saved debug screenshot: debug_failure_${timeframe}.png`);

    } catch (e) {
        console.error(`Error switching timeframe to ${timeframe}: ${e.message}`);
    }
}

async function run() {
    const browser = await chromium.launch({ headless: false });

    const context = await browser.newContext({
        viewport: { width: 1920, height: 1080 }
    });
    const page = await context.newPage();

    const captureConfig = [
        { name: "BTC", url: "https://www.coinglass.com/tv/Binance_BTCUSDT", timeframes: ["1m", "3m"] },
        { name: "DOGE", url: "https://www.coinglass.com/tv/Binance_DOGEUSDT", timeframes: ["1m", "5m"] }
    ];

    const screenshotDir = path.join(process.cwd(), 'screenshots');
    if (!fs.existsSync(screenshotDir)) {
        fs.mkdirSync(screenshotDir);
    }

    for (const asset of captureConfig) {
        console.log(`Navigating to ${asset.name} chart: ${asset.url}...`);
        await page.goto(asset.url);

        try {
            await page.waitForLoadState("networkidle", { timeout: 30000 });
        } catch (e) {
            console.log("Network idle wait timed out, continuing...");
        }

        console.log(`Waiting for ${asset.name} data...`);
        await page.waitForTimeout(5000); // Wait for chart to render

        for (const tf of asset.timeframes) {
            console.log(`Switching ${asset.name} to timeframe: ${tf}`);
            await switchTimeframe(page, tf);
            console.log(`Capturing screenshot for ${asset.name} ${tf}...`);

            const filename = `${asset.name}_${tf}.png`;
            const filepath = path.join(screenshotDir, filename);

            await page.screenshot({ path: filepath, fullPage: true });
            console.log(`Saved: ${filepath}`);
        }
    }

    await browser.close();
    console.log("Done!");
}

run().catch(console.error);
