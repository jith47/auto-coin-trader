
async function checkLogs() {
    try {
        const response = await fetch('http://localhost:8787/api/logs');
        const logs = await response.json();
        const active = logs.filter(l => l.status === 'OPEN' || l.status === 'FILLED');
        console.log('Active Trades in DB:', JSON.stringify(active, null, 2));
    } catch (e) {
        console.error('Failed to fetch logs:', e.message);
    }
}
checkLogs();
