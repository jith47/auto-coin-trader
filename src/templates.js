export function getLogsHTML() {
    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Logs Dashboard</title>
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

        /* Time stats styles */
        .time-stats-container {
            background-color: var(--card-bg);
            border-radius: 1rem;
            border: 1px solid var(--border-color);
            padding: 1.5rem;
            margin-bottom: 2rem;
        }
        
        .time-stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
            gap: 1rem;
            margin-top: 1rem;
        }
        
        .time-slot-card {
            background: rgba(255, 255, 255, 0.03);
            border: 1px solid var(--border-color);
            border-radius: 0.75rem;
            padding: 1rem;
            text-align: center;
        }
        
        .time-slot-hour {
            font-size: 0.875rem;
            font-weight: 700;
            color: var(--accent-blue);
            margin-bottom: 0.5rem;
        }
        
        .time-slot-winrate {
            font-size: 1.25rem;
            font-weight: 700;
            margin-bottom: 0.25rem;
        }
        
        .time-slot-trades {
            font-size: 0.75rem;
            color: var(--text-secondary);
        }

        th.sortable {
            cursor: pointer;
            user-select: none;
        }

        th.sortable:hover {
            color: var(--text-primary);
            background-color: rgba(255, 255, 255, 0.05);
        }

        th.sortable::after {
            content: ' ↕';
            opacity: 0.3;
            font-size: 0.8em;
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
            <h1>Logs</h1>
            <div style="display: flex; gap: 1rem;">
                <button class="refresh-btn" onclick="syncTrades()" id="sync-btn" title="Import all trades from CoinDCX exchange">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"></path><path d="M21 3v5h-5"></path><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"></path><path d="M3 21v-5h5"></path></svg>
                    Sync
                </button>
                <button class="refresh-btn" onclick="forceCheck()" id="force-btn" title="Forcefully trigger the trade status check scheduler">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"></path></svg>
                    Force Check
                </button>
                <button class="refresh-btn" onclick="openStrategyModal()" id="strategy-btn" title="View and edit current trading strategy">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line></svg>
                    Strategy
                </button>
                <button class="refresh-btn" onclick="openAnalyzeModal()" id="analyze-btn" title="Analyze performance and improve strategy">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.21 15.89A10 10 0 1 1 8 2.83"></path><path d="M22 12A10 10 0 0 0 12 2v10z"></path></svg>
                    Analyze & Improve
                </button>
                <div style="width: 1px; background-color: var(--border-color); margin: 0 0.5rem;"></div>
                <button class="refresh-btn" onclick="clearLogs()" id="clear-btn" title="Delete all trade logs" style="color: #f87171; border-color: rgba(248, 113, 113, 0.3);">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                    Clear
                </button>
                <button class="refresh-btn" onclick="backupLogs()" id="backup-btn" title="Download backup of all logs">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
                    Backup
                </button>
                <button class="refresh-btn" onclick="document.getElementById('restore-input').click()" id="restore-btn" title="Restore logs from backup file">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg>
                    Restore
                </button>
                <input type="file" id="restore-input" style="display: none;" accept=".json" onchange="restoreLogs(this)">
                <button class="refresh-btn" onclick="fetchLogs()">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"></path><path d="M21 3v5h-5"></path></svg>
                    Refresh
                </button>
            </div>
        </header>

        <!-- Strategy Modal -->
        <div id="strategy-modal" style="display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.8); z-index: 1000; padding: 2rem;">
            <div style="max-width: 900px; margin: 0 auto; background: var(--card-bg); border-radius: 1rem; border: 1px solid var(--border-color); max-height: 90vh; display: flex; flex-direction: column;">
                <div style="padding: 1rem 1.5rem; border-bottom: 1px solid var(--border-color); display: flex; justify-content: space-between; align-items: center;">
                    <h2 style="font-size: 1.25rem;">Trading Strategy</h2>
                    <button onclick="closeStrategyModal()" style="background: none; border: none; color: var(--text-secondary); cursor: pointer; font-size: 1.5rem;">&times;</button>
                </div>
                <textarea id="strategy-editor" style="flex: 1; padding: 1rem; background: var(--bg-color); border: none; color: var(--text-primary); font-family: monospace; font-size: 0.875rem; resize: none; min-height: 400px;"></textarea>
                <div style="padding: 1rem 1.5rem; border-top: 1px solid var(--border-color); display: flex; gap: 1rem; justify-content: flex-end;">
                    <button onclick="restoreStrategy()" style="padding: 0.5rem 1rem; background: var(--accent-yellow); border: none; border-radius: 0.375rem; color: black; cursor: pointer; margin-right: auto;">Restore Previous</button>
                    <button onclick="closeStrategyModal()" style="padding: 0.5rem 1rem; background: var(--border-color); border: none; border-radius: 0.375rem; color: var(--text-primary); cursor: pointer;">Cancel</button>
                    <button onclick="saveStrategy()" style="padding: 0.5rem 1rem; background: var(--accent-blue); border: none; border-radius: 0.375rem; color: white; cursor: pointer;">Save Strategy</button>
                </div>
            </div>
        </div>

        <!-- Analyze Modal -->
        <div id="analyze-modal" style="display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.8); z-index: 1000; padding: 2rem;">
            <div style="max-width: 700px; margin: 0 auto; background: var(--card-bg); border-radius: 1rem; border: 1px solid var(--border-color);">
                <div style="padding: 1rem 1.5rem; border-bottom: 1px solid var(--border-color); display: flex; justify-content: space-between; align-items: center;">
                    <h2 style="font-size: 1.25rem;">Analyze & Improve Strategy</h2>
                    <button onclick="closeAnalyzeModal()" style="background: none; border: none; color: var(--text-secondary); cursor: pointer; font-size: 1.5rem;">&times;</button>
                </div>
                <div style="padding: 1.5rem;">
                    <label style="display: block; margin-bottom: 0.5rem; color: var(--text-secondary); font-size: 0.875rem;">Additional context or instructions for analysis (optional):</label>
                    <textarea id="analyze-input" placeholder="e.g., Focus on reducing stop loss hits, improve entry timing during London session..." style="width: 100%; height: 120px; padding: 0.75rem; background: var(--bg-color); border: 1px solid var(--border-color); border-radius: 0.5rem; color: var(--text-primary); font-size: 0.875rem; resize: vertical;"></textarea>
                </div>
                <div style="padding: 1rem 1.5rem; border-top: 1px solid var(--border-color); display: flex; gap: 1rem; justify-content: flex-end;">
                    <button onclick="closeAnalyzeModal()" style="padding: 0.5rem 1rem; background: var(--border-color); border: none; border-radius: 0.375rem; color: var(--text-primary); cursor: pointer;">Cancel</button>
                    <button onclick="runAnalyze()" id="run-analyze-btn" style="padding: 0.5rem 1rem; background: var(--accent-purple); border: none; border-radius: 0.375rem; color: white; cursor: pointer;">Run Analysis</button>
                </div>
            </div>
        </div>

        <div class="stats-grid">
            <div class="stat-card">
                <div class="stat-label">Win Rate</div>
                <div id="win-rate" class="stat-value" style="color: var(--accent-green);">-</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">Total PnL</div>
                <div id="total-pnl" class="stat-value">-</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">Closed</div>
                <div id="closed-trades" class="stat-value">-</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">Avg PnL</div>
                <div id="avg-pnl" class="stat-value">-</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">Buy/Sell</div>
                <div id="buy-sell-ratio" class="stat-value" style="font-size: 1.25rem;">-</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">Last Update</div>
                <div id="last-update" class="stat-value" style="font-size: 1rem;">-</div>
            </div>
        </div>

        <div class="time-stats-container">
            <div style="display: flex; justify-content: space-between; align-items: center; cursor: pointer; padding: 0.5rem 0;" onclick="toggleTimeStats()">
                <h2 style="font-size: 1.25rem; font-weight: 600;">Performance by Hour (IST)</h2>
                <div id="time-stats-toggle-icon" style="transition: transform 0.3s ease;">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
                </div>
            </div>
            <div id="time-stats-collapsible" style="display: none; margin-top: 1rem;">
                <p style="font-size: 0.875rem; color: var(--text-secondary); margin-bottom: 1rem;">Most profitable hours of the day (Indian Standard Time) based on closed trades.</p>
                <div id="time-stats-body" class="time-stats-grid">
                    <div style="grid-column: 1/-1; text-align: center; padding: 2rem; color: var(--text-secondary);">Loading time analysis...</div>
                </div>
            </div>
        </div>

        <div class="logs-table-container">
            <table>
                <thead>
                    <tr>
                        <th class="sortable" onclick="handleSort('timestamp')">Time</th>
                        <th>Decision</th>
                        <th class="sortable" onclick="handleSort('asset')">Asset</th>
                        <th class="sortable" onclick="handleSort('price')">Entry</th>
                        <th class="sortable" onclick="handleSort('exit_price')">Exit</th>
                        <th>Qty</th>
                        <th class="sortable" onclick="handleSort('pnl')">PnL</th>
                        <th>Order ID</th>
                        <th>Reason</th>
                        <th>Close Reason</th>
                        <th class="sortable" onclick="handleSort('status')">Status</th>
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
        
        // Strategy Modal Functions
        async function forceCheck() {
            const btn = document.getElementById('force-btn');
            const originalText = btn.innerHTML;
            btn.innerHTML = 'Triggering...';
            btn.disabled = true;
            try {
                const response = await fetch('/api/force-scheduler');
                const data = await response.json();
                if (data.success) {
                    console.log('Scheduler signal sent');
                }
            } catch (e) {
                console.error('Failed to force check:', e);
            } finally {
                setTimeout(() => {
                    btn.innerHTML = originalText;
                    btn.disabled = false;
                }, 1000);
            }
        }

        async function openStrategyModal() {
            document.getElementById('strategy-modal').style.display = 'block';
            document.getElementById('strategy-editor').value = 'Loading...';
            try {
                const response = await fetch('/api/download-strategy');
                const strategy = await response.text();
                document.getElementById('strategy-editor').value = strategy;
            } catch (e) {
                document.getElementById('strategy-editor').value = 'Failed to load strategy.';
            }
        }

        function closeStrategyModal() {
            document.getElementById('strategy-modal').style.display = 'none';
        }

        async function saveStrategy() {
            const strategy = document.getElementById('strategy-editor').value;
            try {
                const response = await fetch('/api/save-strategy', {
                    method: 'POST',
                    headers: { 'Content-Type': 'text/plain' },
                    body: strategy
                });
                const data = await response.json();
                if (data.success) {
                    alert('Strategy saved successfully!');
                    closeStrategyModal();
                } else {
                    alert('Failed to save: ' + data.error);
                }
            } catch (e) {
                alert('Failed to save strategy.');
            }
        }

        async function restoreStrategy() {
            if (!confirm("Are you sure you want to restore the previous strategy? This will create a new version based on the previous one.")) return;
            
            try {
                const response = await fetch('/api/restore-strategy', { method: 'POST' });
                const data = await response.json();
                if (data.success) {
                    alert(data.message);
                    openStrategyModal(); // Reload to show restored strategy
                } else {
                    alert('Failed to restore: ' + data.error);
                }
            } catch (e) {
                alert('Failed to restore strategy.');
            }
        }

        // Analyze Modal Functions
        function openAnalyzeModal() {
            document.getElementById('analyze-modal').style.display = 'block';
            document.getElementById('analyze-input').value = '';
        }

        function closeAnalyzeModal() {
            document.getElementById('analyze-modal').style.display = 'none';
        }

        async function runAnalyze() {
            const btn = document.getElementById('run-analyze-btn');
            const customInput = document.getElementById('analyze-input').value;
            btn.innerHTML = 'Analyzing...';
            btn.disabled = true;
            try {
                const response = await fetch('/api/analyze-performance', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ customInput })
                });
                const data = await response.json();
                alert('Analysis started in background. The strategy will be updated.');
                closeAnalyzeModal();
            } catch (e) {
                console.error('Failed to start analysis:', e);
                alert('Failed to start analysis.');
            } finally {
                btn.innerHTML = 'Run Analysis';
                btn.disabled = false;
            }
        }

        async function clearLogs() {
            if (!confirm("Are you sure you want to DELETE ALL logs? This cannot be undone.")) return;
            
            const btn = document.getElementById('clear-btn');
            const originalText = btn.innerHTML;
            btn.innerHTML = 'Clearing...';
            btn.disabled = true;
            try {
                const response = await fetch('/api/clear-logs');
                const data = await response.json();
                if (data.error) {
                    alert('Clear failed: ' + data.error);
                } else {
                    alert("All logs cleared!");
                    fetchLogs();
                }
            } catch (e) {
                console.error('Failed to clear logs:', e);
                alert('Failed to clear logs.');
            } finally {
                setTimeout(() => {
                    btn.innerHTML = originalText;
                    btn.disabled = false;
                }, 1000);
            }
        }

        async function backupLogs() {
            window.location.href = '/api/backup-logs';
        }

        async function restoreLogs(input) {
            const file = input.files[0];
            if (!file) return;

            if (!confirm('Restoring will APPEND logs from the backup to the existing logs. Continue?')) {
                input.value = '';
                return;
            }

            const reader = new FileReader();
            reader.onload = async function(e) {
                try {
                    const json = JSON.parse(e.target.result);
                    const response = await fetch('/api/restore-logs', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(json)
                    });
                    const data = await response.json();
                    
                    if (data.success) {
                        alert(data.message);
                        fetchLogs();
                    } else {
                        alert('Restore failed: ' + data.error);
                    }
                } catch (err) {
                    console.error('Error parsing backup file:', err);
                    alert('Invalid backup file.');
                }
                input.value = '';
            };
            reader.readAsText(file);
        }

        function toggleTimeStats() {
            const content = document.getElementById('time-stats-collapsible');
            const icon = document.getElementById('time-stats-toggle-icon');
            if (content.style.display === 'none') {
                content.style.display = 'block';
                icon.style.transform = 'rotate(180deg)';
                fetchTimeStatsOnly();
            } else {
                content.style.display = 'none';
                icon.style.transform = 'rotate(0deg)';
            }
        }

        async function fetchTimeStatsOnly() {
            try {
                const response = await fetch('/api/time-stats');
                const timeStats = await response.json();
                renderTimeStats(timeStats);
            } catch (e) {
                console.error('Failed to fetch time stats:', e);
            }
        }

        let currentLogs = [];
        let sortConfig = { key: 'timestamp', direction: 'desc' };

        async function fetchLogs() {
            try {
                // Fetch all data in parallel
                const [logsResponse, statsResponse] = await Promise.all([
                    fetch('/api/logs'),
                    fetch('/api/stats')
                ]);
                
                currentLogs = await logsResponse.json();
                const stats = await statsResponse.json();
                
                applySortAndRender();
                renderStats(stats);

                // Load time stats if the section is already expanded (not typical for page load, but good for refresh)
                if (document.getElementById('time-stats-collapsible').style.display === 'block') {
                    fetchTimeStatsOnly();
                }
            } catch (e) {
                console.error('Failed to fetch data:', e);
            }
        }

        function handleSort(key) {
            if (sortConfig.key === key) {
                sortConfig.direction = sortConfig.direction === 'asc' ? 'desc' : 'asc';
            } else {
                sortConfig.key = key;
                sortConfig.direction = 'desc';
            }
            applySortAndRender();
        }

        function applySortAndRender() {
            const sorted = [...currentLogs].sort((a, b) => {
                let valA = a[sortConfig.key];
                let valB = b[sortConfig.key];
                
                if (valA === null || valA === undefined) valA = '';
                if (valB === null || valB === undefined) valB = '';
                
                if (typeof valA === 'string') valA = valA.toLowerCase();
                if (typeof valB === 'string') valB = valB.toLowerCase();
                
                if (valA < valB) return sortConfig.direction === 'asc' ? -1 : 1;
                if (valA > valB) return sortConfig.direction === 'asc' ? 1 : -1;
                return 0;
            });
            renderLogs(sorted);
        }

        function renderTimeStats(stats) {
            const container = document.getElementById('time-stats-body');
            if (!stats || stats.length === 0) {
                container.innerHTML = '<div style="grid-column: 1/-1; text-align: center; padding: 2rem; color: var(--text-secondary);">No closure data available for analysis.</div>';
                return;
            }
            
            container.innerHTML = '';
            
            // Ensure all 24 hours are represented
            const hourMap = {};
            stats.forEach(s => hourMap[parseInt(s.hour)] = s);
            
            for (let i = 0; i < 24; i++) {
                const s = hourMap[i];
                if (!s) continue; // Only show hours with at least one trade
                
                const winRate = ((s.wins / s.total_trades) * 100).toFixed(0);
                const pnl = parseFloat(s.total_pnl);
                const color = pnl >= 0 ? 'var(--accent-green)' : 'var(--accent-red)';
                
                const card = document.createElement('div');
                card.className = 'time-slot-card';
                card.style.borderColor = pnl >= 0 ? 'rgba(34, 197, 94, 0.3)' : 'rgba(239, 68, 68, 0.3)';
                card.style.background = pnl >= 0 ? 'rgba(34, 197, 94, 0.05)' : 'rgba(239, 68, 68, 0.05)';
                
                card.innerHTML = \`
                    <div class="time-slot-hour">\${i.toString().padStart(2, '0')}:00</div>
                    <div class="time-slot-winrate" style="color: \${color}">\${winRate}%</div>
                    <div class="time-slot-trades">\${s.total_trades} trades</div>
                    <div style="font-size: 0.7rem; margin-top: 0.25rem; font-weight: 600; color: \${color}">\${pnl >= 0 ? '+' : ''}\${pnl.toFixed(2)}</div>
                \`;
                container.appendChild(card);
            }
        }

        function renderStats(stats) {
            if (!stats) return;
            
            document.getElementById('win-rate').textContent = stats.win_rate + '%';
            
            const totalPnL = parseFloat(stats.total_pnl);
            const totalROI = parseFloat(stats.total_roi);
            const roiColor = totalROI >= 0 ? 'var(--accent-green)' : 'var(--accent-red)';
            
            document.getElementById('total-pnl').innerHTML = 
                (totalPnL >= 0 ? '+' : '') + stats.total_pnl + 
                '<span style="font-size: 0.8em; color: ' + roiColor + '; margin-left: 0.5rem;">(' + (totalROI >= 0 ? '+' : '') + stats.total_roi + '%)</span>';
            
            document.getElementById('total-pnl').style.color = totalPnL >= 0 ? 'var(--accent-green)' : 'var(--accent-red)';
            
            document.getElementById('closed-trades').textContent = stats.closed_trades;
            
            const avgPnL = parseFloat(stats.avg_pnl);
            document.getElementById('avg-pnl').textContent = stats.avg_pnl;
            document.getElementById('avg-pnl').style.color = avgPnL >= 0 ? 'var(--accent-green)' : 'var(--accent-red)';
            
            document.getElementById('buy-sell-ratio').textContent = (stats.buys || 0) + 'B / ' + (stats.sells || 0) + 'S';
            document.getElementById('last-update').textContent = new Date().toLocaleTimeString();
        }

        function renderLogs(logs) {
            const body = document.getElementById('logs-body');
            body.innerHTML = '';

            if (logs.length === 0) {
                body.innerHTML = '<tr><td colspan="11" style="text-align: center; padding: 3rem; color: var(--text-secondary);">No logs found</td></tr>';
                return;
            }

            logs.forEach(log => {
                const row = document.createElement('tr');
                const date = new Date(log.timestamp).toLocaleString();
                
                // PnL styling
                const pnl = log.pnl !== null && log.pnl !== undefined ? parseFloat(log.pnl) : null;
                const pnlColor = pnl === null ? 'var(--text-secondary)' : (pnl >= 0 ? '#4ade80' : '#f87171');
                const pnlText = pnl === null ? '-' : (pnl >= 0 ? '+' : '') + pnl.toFixed(2);
                
                // PnL % Calculation
                let pnlPercentText = '-';
                if (pnl !== null && log.price && log.quantity && log.leverage) {
                    const margin = (log.price * log.quantity) / log.leverage;
                    const pnlPercent = (pnl / margin) * 100;
                    pnlPercentText = (pnlPercent >= 0 ? '+' : '') + pnlPercent.toFixed(2) + '%';
                }
                
                row.innerHTML = '<td>' + date + '</td>' +
                    '<td><span class="badge badge-' + log.decision.toLowerCase() + '">' + log.decision + '</span></td>' +
                    '<td>' + (log.asset || '-') + '</td>' +
                    '<td>' + (log.price ? log.price.toFixed(4) : '-') + '</td>' +
                    '<td>' + (log.exit_price ? log.exit_price.toFixed(4) : '-') + '</td>' +
                    '<td>' + (log.quantity || '-') + '</td>' +
                    '<td style="font-weight: 600; color: ' + pnlColor + ';">' + pnlText + ' <span style="font-size: 0.8em; opacity: 0.8;">' + (pnlPercentText !== '-' ? '(' + pnlPercentText + ')' : '') + '</span></td>' +
                    '<td style="font-family: monospace; font-size: 0.75rem; color: var(--text-secondary);">' + (log.order_id || '-') + '</td>' +
                    '<td class="reason-cell" title="' + (log.reason || '') + '">' + (log.reason || '-') + '</td>' +
                    '<td class="reason-cell" title="' + (log.close_reason || '') + '">' + (log.close_reason || '-') + '</td>' +
                    '<td><span class="badge ' + (log.status === 'OPEN' ? 'badge-open' : (log.status === 'CLOSED' ? 'badge-buy' : '')) + '">' + log.status + '</span></td>';
                
                // Add summary row if it exists
                if (log.summary) {
                    const summaryRow = document.createElement('tr');
                    summaryRow.innerHTML = '<td colspan="11" style="padding: 0.5rem 1rem 1rem 1rem; background-color: rgba(56, 189, 248, 0.03); border-bottom: 1px solid var(--border-color);">' +
                        '<div style="font-size: 0.75rem; color: var(--accent-blue); font-weight: 600; margin-bottom: 0.25rem;">AI ANALYSIS:</div>' +
                        '<div style="font-size: 0.875rem; color: var(--text-secondary); line-height: 1.4;">' + log.summary + '</div>' +
                    '</td>';
                    body.appendChild(row);
                    body.appendChild(summaryRow);
                } else {
                    body.appendChild(row);
                }
            });
        }

        fetchLogs();
    </script>
</body>
</html>
    `;
}
