export function getLogsHTML() {
    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Trade Logs Dashboard</title>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
    <style>
        :root {
            --bg-color: #0f172a;
            --card-bg: #1e293b;
            --text-primary: #f8fafc;
            --text-secondary: #94a3b8;
            --accent-blue: #38bdf8;
            --accent-green: #22c55e;
            --accent-red: #ef4444;
            --accent-yellow: #eab308;
            --border-color: #334155;
        }

        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
            font-family: 'Inter', sans-serif;
        }

        body {
            background-color: var(--bg-color);
            color: var(--text-primary);
            padding: 2rem;
            line-height: 1.5;
        }

        .container {
            max-width: 1200px;
            margin: 0 auto;
        }

        header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 2rem;
        }

        h1 {
            font-size: 1.875rem;
            font-weight: 700;
            background: linear-gradient(to right, var(--accent-blue), #818cf8);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
        }

        .refresh-btn {
            background-color: var(--card-bg);
            border: 1px solid var(--border-color);
            color: var(--text-primary);
            padding: 0.5rem 1rem;
            border-radius: 0.5rem;
            cursor: pointer;
            font-weight: 500;
            transition: all 0.2s;
            display: flex;
            align-items: center;
            gap: 0.5rem;
        }

        .refresh-btn:hover {
            background-color: var(--border-color);
        }

        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 1.5rem;
            margin-bottom: 2rem;
        }

        .stat-card {
            background-color: var(--card-bg);
            padding: 1.5rem;
            border-radius: 1rem;
            border: 1px solid var(--border-color);
        }

        .stat-label {
            color: var(--text-secondary);
            font-size: 0.875rem;
            margin-bottom: 0.5rem;
        }

        .stat-value {
            font-size: 1.5rem;
            font-weight: 700;
        }

        .logs-table-container {
            background-color: var(--card-bg);
            border-radius: 1rem;
            border: 1px solid var(--border-color);
            overflow: hidden;
            box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1);
        }

        table {
            width: 100%;
            border-collapse: collapse;
            text-align: left;
        }

        th {
            background-color: rgba(255, 255, 255, 0.02);
            padding: 1rem;
            font-size: 0.75rem;
            text-transform: uppercase;
            letter-spacing: 0.05em;
            color: var(--text-secondary);
            border-bottom: 1px solid var(--border-color);
        }

        td {
            padding: 1rem;
            font-size: 0.875rem;
            border-bottom: 1px solid var(--border-color);
        }

        tr:last-child td {
            border-bottom: none;
        }

        tr:hover td {
            background-color: rgba(255, 255, 255, 0.01);
        }

        .badge {
            padding: 0.25rem 0.5rem;
            border-radius: 0.375rem;
            font-size: 0.75rem;
            font-weight: 600;
        }

        .badge-buy { background-color: rgba(34, 197, 94, 0.2); color: #4ade80; }
        .badge-sell { background-color: rgba(239, 68, 68, 0.2); color: #f87171; }
        .badge-hold { background-color: rgba(148, 163, 184, 0.2); color: #cbd5e1; }
        .badge-skipped { background-color: rgba(234, 179, 8, 0.2); color: #fde047; }
        .badge-open { border: 1px solid var(--accent-blue); color: var(--accent-blue); }

        .reason-cell {
            max-width: 300px;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            color: var(--text-secondary);
        }

        .reason-cell:hover {
            white-space: normal;
            overflow: visible;
        }

        @media (max-width: 768px) {
            body { padding: 1rem; }
            .stats-grid { grid-template-columns: 1fr 1fr; }
            th:nth-child(4), td:nth-child(4),
            th:nth-child(5), td:nth-child(5),
            th:nth-child(6), td:nth-child(6) { display: none; }
        }
    </style>
</head>
<body>
    <div class="container">
        <header>
            <h1>Trade Logs</h1>
            <div style="display: flex; gap: 1rem;">
                <button class="refresh-btn" onclick="syncTrades()" id="sync-btn" title="Import all trades from CoinDCX exchange">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"></path><path d="M21 3v5h-5"></path><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"></path><path d="M3 21v-5h5"></path></svg>
                    Sync Trades
                </button>
                <button class="refresh-btn" onclick="analyzePerformance()" id="analyze-btn" title="Analyze last 7 days and update strategy">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.21 15.89A10 10 0 1 1 8 2.83"></path><path d="M22 12A10 10 0 0 0 12 2v10z"></path></svg>
                    Analyze & Improve
                </button>
                <button class="refresh-btn" onclick="checkStatus()" id="check-status-btn">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>
                    Check Status
                </button>
                <button class="refresh-btn" onclick="fetchLogs()">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"></path><path d="M21 3v5h-5"></path></svg>
                    Refresh
                </button>
            </div>
        </header>

        <div class="stats-grid">
            <div class="stat-card">
                <div class="stat-label">Total Logs</div>
                <div id="total-logs" class="stat-value">-</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">Buy Decisions</div>
                <div id="buy-count" class="stat-value">-</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">Sell Decisions</div>
                <div id="sell-count" class="stat-value">-</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">Last Update</div>
                <div id="last-update" class="stat-value" style="font-size: 1rem;">-</div>
            </div>
        </div>

        <div class="logs-table-container">
            <table>
                <thead>
                    <tr>
                        <th>Time</th>
                        <th>Decision</th>
                        <th>Asset</th>
                        <th>Entry</th>
                        <th>Exit</th>
                        <th>Qty</th>
                        <th>PnL</th>
                        <th>Order ID</th>
                        <th>Reason</th>
                        <th>Status</th>
                    </tr>
                </thead>
                <tbody id="logs-body">
                    <tr>
                        <td colspan="10" style="text-align: center; padding: 3rem; color: var(--text-secondary);">Loading logs...</td>
                    </tr>
                </tbody>
            </table>
        </div>
    </div>

    <script>
        async function syncTrades() {
            const btn = document.getElementById('sync-btn');
            const originalText = btn.innerHTML;
            btn.innerHTML = 'Syncing...';
            btn.disabled = true;
            try {
                const response = await fetch('/api/sync-trades');
                const data = await response.json();
                if (data.error) {
                    alert('Sync failed: ' + data.error);
                } else {
                    alert("Sync complete! " + data.newTradesAdded + " new trades imported from CoinDCX.");
                    fetchLogs(); // Refresh the logs
                }
            } catch (e) {
                console.error('Failed to sync trades:', e);
                alert('Failed to sync trades.');
            } finally {
                setTimeout(() => {
                    btn.innerHTML = originalText;
                    btn.disabled = false;
                }, 1000);
            }
        }
        
        async function analyzePerformance() {
            const btn = document.getElementById('analyze-btn');
            const originalText = btn.innerHTML;
            btn.innerHTML = 'Analyzing...';
            btn.disabled = true;
            try {
                const response = await fetch('/api/analyze-performance');
                const data = await response.json();
                alert('Analysis started in background. The strategy will be updated based on the last 7 days of performance.');
            } catch (e) {
                console.error('Failed to start analysis:', e);
                alert('Failed to start analysis.');
            } finally {
                setTimeout(() => {
                    btn.innerHTML = originalText;
                    btn.disabled = false;
                }, 5000);
            }
        }
        async function checkStatus() {
            const btn = document.getElementById('check-status-btn');
            const originalText = btn.innerHTML;
            btn.innerHTML = 'Checking...';
            btn.disabled = true;
            try {
                await fetch('/api/check-status');
                setTimeout(fetchLogs, 2000); // Wait a bit for DB update
            } catch (e) {
                console.error('Failed to check status:', e);
            } finally {
                setTimeout(() => {
                    btn.innerHTML = originalText;
                    btn.disabled = false;
                }, 2000);
            }
        }

        async function fetchLogs() {
            try {
                const response = await fetch('/api/logs');
                const logs = await response.json();
                renderLogs(logs);
            } catch (e) {
                console.error('Failed to fetch logs:', e);
            }
        }

        function renderLogs(logs) {
            const body = document.getElementById('logs-body');
            body.innerHTML = '';

            if (logs.length === 0) {
                body.innerHTML = '<tr><td colspan="10" style="text-align: center; padding: 3rem; color: var(--text-secondary);">No logs found</td></tr>';
                return;
            }

            let buys = 0;
            let sells = 0;

            logs.forEach(log => {
                // Skip exit-only records to collapse the view (they are linked to parents)
                if (log.parent_trade_id) return;

                if (log.decision === 'BUY') buys++;
                if (log.decision === 'SELL') sells++;

                const row = document.createElement('tr');
                const date = new Date(log.timestamp).toLocaleString();
                
                // PnL styling
                const pnl = log.pnl !== null && log.pnl !== undefined ? parseFloat(log.pnl) : null;
                const pnlColor = pnl === null ? 'var(--text-secondary)' : (pnl >= 0 ? '#4ade80' : '#f87171');
                const pnlText = pnl === null ? '-' : (pnl >= 0 ? '+' : '') + pnl.toFixed(2);
                
                row.innerHTML = '<td>' + date + '</td>' +
                    '<td><span class="badge badge-' + log.decision.toLowerCase() + '">' + log.decision + '</span></td>' +
                    '<td>' + (log.asset || '-') + '</td>' +
                    '<td>' + (log.price ? log.price.toFixed(4) : '-') + '</td>' +
                    '<td>' + (log.exit_price ? log.exit_price.toFixed(4) : '-') + '</td>' +
                    '<td>' + (log.quantity || '-') + '</td>' +
                    '<td style="font-weight: 600; color: ' + pnlColor + ';">' + pnlText + '</td>' +
                    '<td style="font-family: monospace; font-size: 0.75rem; color: var(--text-secondary);">' + (log.order_id || '-') + '</td>' +
                    '<td class="reason-cell" title="' + (log.reason || '') + '">' + (log.reason || '-') + '</td>' +
                    '<td><span class="badge ' + (log.status === 'OPEN' ? 'badge-open' : '') + '">' + log.status + '</span></td>';
                
                body.appendChild(row);
            });

            document.getElementById('total-logs').textContent = logs.length;
            document.getElementById('buy-count').textContent = buys;
            document.getElementById('sell-count').textContent = sells;
            document.getElementById('last-update').textContent = new Date().toLocaleTimeString();
        }

        fetchLogs();
        // Auto refresh every 30 seconds
        setInterval(fetchLogs, 30000);
    </script>
</body>
</html>
  `;
}
