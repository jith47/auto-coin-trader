import { launch } from "@cloudflare/playwright";

export default {
  async fetch(request, env) {
    const browser = await launch(env.MYBROWSER);
    const page = await browser.newPage();

    // Set viewport to ensure elements are rendered (matching Python script)
    await page.setViewportSize({ width: 1920, height: 1080 });

    const url = "https://www.coinglass.com/tv/Binance_BTCUSDT";
    console.log(`Navigating to ${url}...`);
    await page.goto(url);

    // Wait for the page to load
    try {
      // networkidle might not be fully supported in all CF worker envs or might timeout, 
      // but we'll try it as per Python script logic.
      await page.waitForLoadState("networkidle", { timeout: 30000 });
    } catch (e) {
      // Continue even if network is busy, matching Python's try/except pass
      console.log("Network idle wait timed out or failed, continuing...");
    }

    console.log("Waiting for data...");
    // Wait a bit for frames and dynamic content to load (10s)
    await page.waitForTimeout(10000);

    // Handle timeframe selection
    const { searchParams } = new URL(request.url);
    const timeframe = searchParams.get("timeframe"); // 1m, 30m, 1D

    if (timeframe) {
      console.log(`Switching timeframe to: ${timeframe}`);
      // Selectors for timeframe buttons. 
      // Based on research, they might be in the main page or iframe.
      // We'll try to find them in the main page first as they appeared in the top level DOM in research.
      // Common text: "1m", "30m", "1D"

      // Map timeframe param to button text/selector
      const timeframeMap = {
        "1m": "1m",
        "30m": "30m",
        "1d": "1D", // Handle lowercase 'd'
        "1D": "1D"
      };

      const targetText = timeframeMap[timeframe];

      if (targetText) {
        try {
          // Try to find the button. It might be a button tag or a div with role button or just text.
          // Using text=... is robust.
          // We look for a button specifically to avoid random text matches.
          const btn = page.locator(`button:has-text("${targetText}")`).first();

          // If not found, it might be inside the iframe (tradingview)
          if (await btn.count() > 0) {
            await btn.click();
            console.log(`Clicked ${targetText} button on main page`);
          } else {
            // Try inside iframe
            const frames = page.frames();
            let clicked = false;
            for (const frame of frames) {
              const frameBtn = frame.locator(`button:has-text("${targetText}")`).first();
              if (await frameBtn.count() > 0) {
                await frameBtn.click();
                console.log(`Clicked ${targetText} button in iframe`);
                clicked = true;
                break;
              }
            }
            if (!clicked) {
              console.log(`Could not find timeframe button for ${timeframe}`);
            }
          }

          // Wait for chart to update after click
          console.log("Waiting for chart update...");
          await page.waitForTimeout(5000);

        } catch (e) {
          console.error(`Error switching timeframe: ${e.message}`);
        }
      } else {
        console.log(`Invalid timeframe parameter: ${timeframe}`);
      }
    }

    let found = false;
    let deltaValue = null;

    // In Playwright JS, page.frames() is a method, not a property like in Python (page.frames)
    // Actually in JS it is page.frames() method.
    const frames = page.frames();

    for (const frame of frames) {
      try {
        // Check if text exists in this frame
        // locator count is async in some contexts but here we use it on frame
        const locator = frame.locator("text=Aggregated Futures Bid & Ask Delta");
        const count = await locator.count();

        if (count > 0) {
          // Locate the specific element
          const labelEl = locator.first();

          // Go up to the container to find the value
          // .. in xpath or using locator logic. Playwright locator("..") isn't standard CSS.
          // Python script used: label_el.locator("..").locator("..").locator("..")
          // In JS Playwright, we can use xpath '..' or locator('xpath=..')
          // Or better, use the same selector strategy if it works.
          // Python's locator("..") implies it resolves to parent. 
          // Let's use xpath for parent traversal which is reliable.
          const parent = labelEl.locator("xpath=../../..");

          const fullText = await parent.innerText();

          // Parse the number
          // Look for a number that might be negative (using hyphen or minus sign)
          // Regex: [−-]?\d+\.\d+[KkMm]?
          const matches = fullText.match(/[−-]?\d+\.\d+[KkMm]?/g);

          if (matches && matches.length > 0) {
            deltaValue = matches[matches.length - 1];
            // Normalize minus sign
            deltaValue = deltaValue.replace('−', '-');
            found = true;
            break;
          }
        }
      } catch (e) {
        // Ignore errors in individual frames
      }
    }

    if (found) {
      console.log(`BTC Delta: ${deltaValue}`);
    } else {
      console.log("Error: Could not find delta data.");
    }

    // Capture screenshot
    const img = await page.screenshot({ fullPage: true });
    console.log("Screenshot captured");

    await browser.close();

    return new Response(img, {
      headers: {
        "Content-Type": "image/png",
      },
    });
  },
};