// Native fetch is available in Node.js 18+

console.log("🚀 [Scheduler] Local Cron Scheduler process started.");
console.log("⏰ Starting Local Cron Scheduler...");
console.log("   Target: http://localhost:8787/__scheduled?cron=*+*+*+*+*");
console.log("   Schedule: Every 60 seconds");

async function triggerCron(retryCount = 0) {
    try {
        console.log(`\n[${new Date().toLocaleTimeString()}] ⏳ Triggering scheduled event...`);
        const response = await fetch("http://127.0.0.1:8787/api/check-status", {
            method: "GET"
        });

        if (response.ok) {
            console.log(`[${new Date().toLocaleTimeString()}] ✅ Success! Worker responded with ${response.status}`);
        } else {
            console.log(`[${new Date().toLocaleTimeString()}] ❌ Failed! Worker responded with ${response.status}`);
            const text = await response.text();
            console.log("   Response:", text);
        }
    } catch (e) {
        console.error(`[${new Date().toLocaleTimeString()}] ❌ Error triggering cron:`, e.message);
        if (e.code === 'ECONNREFUSED') {
            console.log("   (Connection refused. Make sure 'npm run dev' is running on port 8787)");
        }
        if (retryCount < 3) {
            console.log(`   Retrying in 5 seconds... (Attempt ${retryCount + 1}/3)`);
            setTimeout(() => triggerCron(retryCount + 1), 5000);
        }
    }
}

// Trigger immediately on start
triggerCron();

// Then run every 60 seconds
setInterval(triggerCron, 60000);
