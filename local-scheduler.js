// Native fetch is available in Node.js 18+

console.log("🚀 [Scheduler] Local Cron Scheduler process started.");
console.log("⏰ Starting Local Cron Scheduler...");
console.log("   Target: http://localhost:8787/__scheduled?cron=*+*+*+*+*");
console.log("   Schedule: Checks every minute (Smart Polling), Triggers every 15 mins (IST)");

// Configuration
const CHECK_INTERVAL_MS = 60 * 1000;
const BASE_URL = "http://127.0.0.1:8787/api/check-status?trade=true";
const ALLOWED_HOURS_IST = [6, 11, 13, 16, 17, 0];

let isProcessing = false;
let lastTriggeredAnalysisSlot = null;
let monitorTrades = true; // Start as true to perform initial check

// Helper to get IST time
function getISTTime() {
    const now = new Date();
    const utcOffset = now.getTime() + (now.getTimezoneOffset() * 60000);
    const istOffset = 5.5 * 60 * 60 * 1000;
    const istTime = new Date(utcOffset + istOffset);
    return istTime;
}

async function triggerCron() {
    const istTime = getISTTime();
    const hours = istTime.getHours();
    const minutes = istTime.getMinutes();
    const timeString = istTime.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' });

    if (isProcessing) return;

    // 1. Check if this is a scheduled 15-minute slot for FULL ANALYSIS
    const isAllowedHourTarget = ALLOWED_HOURS_IST.includes(hours);
    const isSlotTime = (minutes % 15 === 0);
    const currentSlotIdentifier = `${hours}:${minutes}`;

    let shouldRunAnalysis = false;
    if (isAllowedHourTarget && isSlotTime) {
        if (lastTriggeredAnalysisSlot !== currentSlotIdentifier) {
            shouldRunAnalysis = true;
            lastTriggeredAnalysisSlot = currentSlotIdentifier;
        }
    }

    // 2. Decision: Should we actually hit the API?
    // We hit the API if:
    // a) It's a scheduled analysis slot.
    // b) monitorTrades is true (meaning previous check found active trades).
    const shouldPollAPI = shouldRunAnalysis || monitorTrades;

    if (!shouldPollAPI) {
        // Log sparingly when idle
        if (minutes % 5 === 0) {
            // console.log(`[${timeString}] 💤 Monitoring paused (No active trades). Waiting for scheduled slot...`);
        }
        return;
    }

    isProcessing = true;
    try {
        let logMsg = `[${timeString}] 🔍 Checking Status...`;
        if (shouldRunAnalysis) logMsg = `[${timeString}] 🚀 Triggering Scheduled Analysis...`;
        console.log(logMsg);

        let finalUrl = BASE_URL;
        if (shouldRunAnalysis) finalUrl += "&analyze=true";

        const response = await fetch(finalUrl);
        if (response.ok) {
            const data = await response.json().catch(() => ({}));

            // Extract active trade count from API response
            const activeCount = data.activeTradesCount || 0;

            if (activeCount > 0) {
                if (!monitorTrades) console.log(`[${timeString}] 🔔 Active trades detected (${activeCount}). Resuming minute-by-minute monitoring.`);
                monitorTrades = true;
            } else {
                if (monitorTrades && !shouldRunAnalysis) {
                    console.log(`[${timeString}] ⏹️ No active trades. Pausing status checks until next event/slot.`);
                }
                monitorTrades = false;
            }

            if (shouldRunAnalysis) {
                console.log(`[${timeString}] ✅ Analysis triggered successfully.`);
            }
        } else {
            console.log(`[${timeString}] ❌ API Error: ${response.status}`);
        }
    } catch (e) {
        console.error(`[${timeString}] ❌ Request failed:`, e.message);
    } finally {
        isProcessing = false;
    }
}

// Start polling
triggerCron();
setInterval(triggerCron, CHECK_INTERVAL_MS);
