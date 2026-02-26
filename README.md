# Grok Strategy Engine v4.0

This project implements the Grok Trading Strategy using a Cloudflare Worker (recommended) or a standalone Node.js process.

## 🚀 Quick Start (Cloudflare Worker)

This is the modern, recommended way to run the strategy.

### 1. Install Dependencies
```bash
npm install
```

### 2. Run Locally
Start the local development server (mimics Cloudflare Worker environment):
```bash
npx wrangler dev
```
- The API will be available at `http://localhost:8787`.
- The strategy engine starts automatically when the worker receives a request (e.g., `curl http://localhost:8787/api/status`).

### 3. Deploy
Deploy to Cloudflare global network:
```bash
npx wrangler deploy
```

---

## 🐢 Legacy Mode (Node.js)

You can still run the strategy as a standalone Node.js process (uses local SQLite file).

### Run in Monitor Mode (No Trading)
```bash
npm run monitor
```

### Run in Live Mode (Trading Enabled)
```bash
npm run start
```
*Note: Requires `.dev.vars` or environment variables for API keys.*

---

## 🛠 Configuration

Strategy parameters are defined in `api/grok_strategy_engine.js` under `STRATEGY_CONFIG`.

### Key Features
- **Phase 1**: Core Trading Logic (Lag Score, Correlation, Liquidity Sweeps, FVG)
- **Phase 2**: Risk Management (Session Filters, Daily Limits, Dynamic Sizing)

### Environment Variables
Create a `.dev.vars` file for local development:
```ini
COINDCX_API_KEY=your_key
COINDCX_SECRET_KEY=your_secret
GEMINI_API_KEY=your_gemini_key
```
npx wrangler tail --format pretty 2>&1