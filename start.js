import { spawn } from 'child_process';

console.log("🚀 Starting Wrangler Dev (Event-Driven Scheduler)...");

// Start Wrangler Dev
// Use 'pipe' for stdio to capture output
const wrangler = spawn('npx', ['wrangler', 'dev'], { stdio: ['inherit', 'pipe', 'pipe'], shell: true });

let scheduler = null;

function startScheduler(isInitial = false) {
    if (scheduler) {
        console.log("ℹ️ [System] Scheduler already running. Sending WAKE-UP signal (SIGUSR1)...");
        try {
            scheduler.kill('SIGUSR1');
            console.log("⚡ [System] WAKE-UP signal sent to PID:", scheduler.pid);
        } catch (e) {
            console.error("❌ [System] Failed to send signal to scheduler:", e);
        }
        return;
    }
    console.log(`\n⏰ [System] Starting Local Scheduler (${isInitial ? 'Initial Check' : 'Active Trades Detected'})...`);
    try {
        scheduler = spawn('node', ['local-scheduler.js'], { stdio: 'inherit' });
        console.log("🚀 [System] Scheduler process spawned with PID:", scheduler.pid);

        scheduler.on('close', (code) => {
            console.log(`\n💤 [System] Scheduler stopped (Code ${code})`);
            scheduler = null;
        });

        scheduler.on('error', (err) => {
            console.error("❌ [System] Scheduler failed to start:", err);
            scheduler = null;
        });
    } catch (e) {
        console.error("❌ [System] Error spawning scheduler:", e);
        scheduler = null;
    }
}

function stopScheduler() {
    if (!scheduler) return; // Already stopped
    console.log("\n🛑 [System] Stopping Local Scheduler (No Active Trades)...");
    scheduler.kill();
    scheduler = null;
}

function handleOutput(data) {
    const output = data.toString();
    triggerInitialCheck(output);
    if (output.includes('>>> START_SCHEDULER <<<')) {
        console.log("🎯 [Debug] Detected START signal in output");
        startScheduler();
    }
    if (output.includes('>>> STOP_SCHEDULER <<<')) {
        console.log("🎯 [Debug] Detected STOP signal in output (Ignored for scheduled analysis)");
        // stopScheduler(); // Disabled to keep scheduler alive for 15-min checks
    }
}

// Pipe Wrangler output to stdout and listen for signals
wrangler.stdout.on('data', (data) => {
    process.stdout.write(data.toString());
    handleOutput(data);
});

wrangler.stderr.on('data', (data) => {
    process.stderr.write(data.toString());
    handleOutput(data);
});

wrangler.on('close', (code) => {
    console.log(`Wrangler exited with code ${code}`);
    if (scheduler) scheduler.kill();
    process.exit(code);
});

// Handle termination signals
process.on('SIGINT', () => {
    console.log("\n🛑 Stopping all processes...");
    wrangler.kill();
    if (scheduler) scheduler.kill();
    process.exit();
});

process.on('SIGTERM', () => {
    wrangler.kill();
    if (scheduler) scheduler.kill();
    process.exit();
});

// Initial check: Start scheduler once to check initial state
// It will kill itself if checkTradeStatus finds no trades
let initialCheckStarted = false;
function triggerInitialCheck(output) {
    if (!initialCheckStarted && /Ready on http:\/\/(localhost|127\.0\.0\.1):\d+/.test(output)) {
        initialCheckStarted = true;
        const portMatch = output.match(/:(\d+)/);
        const port = portMatch ? portMatch[1] : '8787';
        console.log(`\n🔍 [System] Wrangler is ready on port ${port}. Performing initial status check...`);
        setTimeout(() => startScheduler(true), 1500);
    }
}
