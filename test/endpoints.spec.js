import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import worker from '../src/screenshot.js';
import * as coindcx from '../src/coindcx.js';

// Mock CoinDCX module
vi.mock('../src/coindcx.js', () => ({
    placeOrder: vi.fn(),
    cancelOrder: vi.fn(),
    cancelAllOrders: vi.fn(),
    getOpenPositions: vi.fn(),
    getAccountBalance: vi.fn(),
}));

// Mock Playwright
vi.mock('@cloudflare/playwright', () => ({
    launch: vi.fn(() => ({
        newPage: vi.fn(() => ({
            setViewportSize: vi.fn(),
            goto: vi.fn(),
            evaluate: vi.fn(),
            waitForTimeout: vi.fn(),
            screenshot: vi.fn(() => new Uint8Array([])),
            close: vi.fn(),
            $: vi.fn(() => ({
                contentFrame: vi.fn(() => ({
                    $: vi.fn(() => ({ click: vi.fn() }))
                }))
            }))
        })),
        close: vi.fn(),
    })),
}));

// Mock GoogleGenerativeAI
vi.mock('@google/generative-ai', () => ({
    GoogleGenerativeAI: vi.fn(() => ({
        getGenerativeModel: vi.fn(() => ({
            generateContent: vi.fn(() => ({
                response: {
                    text: vi.fn(() => JSON.stringify({
                        decision: "BUY",
                        reason: "Test reason",
                        stopLoss: 98000,
                        takeProfit: 100000,
                        orderType: "LIMIT",
                        entry: 99000
                    }))
                }
            }))
        }))
    }))
}));

describe('Worker Endpoints', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('handles analyze request', async () => {
        const request = new Request('http://example.com/?analyze=true');
        const ctx = createExecutionContext();

        const response = await worker.fetch(request, { ...env, GEMINI_API_KEY: 'test', MYBROWSER: {} }, ctx);
        await waitOnExecutionContext(ctx);

        const data = await response.json();
        expect(data).toHaveProperty('decision', 'BUY');
        expect(data).toHaveProperty('stopLoss', 98000);
        expect(data).toHaveProperty('takeProfit', 100000);
        expect(data).toHaveProperty('orderType', 'LIMIT');
        expect(data).toHaveProperty('entry', 99000);
    });

    it('skips trade if active position exists', async () => {
        const request = new Request('http://example.com/?analyze=true&trade=true');
        const ctx = createExecutionContext();

        // Mock active position
        coindcx.getOpenPositions.mockResolvedValue([
            { pair: "B-BTC_USDT", active_pos: "0.001" }
        ]);

        const response = await worker.fetch(request, {
            ...env,
            GEMINI_API_KEY: 'test',
            COINDCX_API_KEY: 'test',
            COINDCX_SECRET_KEY: 'test',
            MYBROWSER: {}
        }, ctx);
        await waitOnExecutionContext(ctx);

        const data = await response.json();
        expect(coindcx.placeOrder).not.toHaveBeenCalled();
        expect(data.order).toHaveProperty('status', 'skipped');
    });

    it('calculates quantity and places trade if no active position', async () => {
        const request = new Request('http://example.com/?analyze=true&trade=true');
        const ctx = createExecutionContext();

        // Mock no active position
        coindcx.getOpenPositions.mockResolvedValue([]);
        // Mock balance
        coindcx.getAccountBalance.mockResolvedValue({ available_wallet_balance: "100" });
        // Mock placeOrder
        coindcx.placeOrder.mockResolvedValue({ id: 'order_123' });

        const response = await worker.fetch(request, {
            ...env,
            GEMINI_API_KEY: 'test',
            COINDCX_API_KEY: 'test',
            COINDCX_SECRET_KEY: 'test',
            MYBROWSER: {}
        }, ctx);
        await waitOnExecutionContext(ctx);

        const data = await response.json();

        // Expect cancelAllOrders to be called
        expect(coindcx.cancelAllOrders).toHaveBeenCalled();

        // Expect placeOrder with calculated quantity
        // 100 USDT * 5% = 5 USDT. Price ~100k. Qty ~ 0.00005. Min 0.001.
        expect(coindcx.placeOrder).toHaveBeenCalledWith(
            expect.anything(),
            'BUY',
            0.001, // Min quantity
            expect.anything(),
            98000,
            100000,
            'LIMIT',
            99000
        );
        expect(data.order).toEqual({ id: 'order_123' });
    });
});
