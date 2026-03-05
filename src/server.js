/**
 * Server — Express + WebSocket hub for the micro-scalper.
 * Serves the UI and broadcasts real-time data to connected clients.
 */
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function createAppServer(port = 3456, onConnect = null) {
    const app = express();
    const server = createServer(app);
    const wss = new WebSocketServer({ server });

    // Serve static UI files
    app.use(express.static(join(__dirname, '..', 'public')));

    const clients = new Set();

    wss.on('connection', (ws) => {
        clients.add(ws);
        console.log(`[Server] UI client connected (${clients.size} total)`);

        // If a new client connects, allow the caller to send initial state
        if (onConnect) {
            onConnect((type, data) => {
                const message = JSON.stringify({ type, data, timestamp: Date.now() });
                if (ws.readyState === 1) ws.send(message);
            });
        }

        ws.on('close', () => {
            clients.delete(ws);
            console.log(`[Server] UI client disconnected (${clients.size} total)`);
        });

        ws.on('error', (err) => {
            console.error(`[Server] Client error:`, err.message);
            clients.delete(ws);
        });
    });

    /**
     * Broadcast a message to all connected UI clients.
     */
    function broadcast(type, data) {
        const message = JSON.stringify({ type, data, timestamp: Date.now() });
        for (const client of clients) {
            if (client.readyState === 1) { // OPEN
                client.send(message);
            }
        }
    }

    /**
     * Start the server.
     */
    function start() {
        return new Promise((resolve) => {
            server.listen(port, () => {
                console.log(`[Server] Dashboard running at http://localhost:${port}`);
                resolve();
            });
        });
    }

    /**
     * Stop the server.
     */
    function stop() {
        return new Promise((resolve) => {
            wss.close();
            server.close(resolve);
        });
    }

    return { app, server, wss, broadcast, start, stop };
}
