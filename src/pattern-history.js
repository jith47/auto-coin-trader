import { writeFileSync, readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PATTERNS_FILE = join(__dirname, '..', 'patterns.json');

export class PatternHistory {
    constructor(maxSize = 100) {
        this.maxSize = maxSize;
        this.patterns = [];
        this._load();
    }

    add(pattern) {
        // Ensure properties exist
        if (!pattern.time) pattern.time = Date.now();
        if (!pattern.timeStr) pattern.timeStr = new Date(pattern.time).toISOString();

        this.patterns.push(pattern);

        // Keep it to maxSize
        if (this.patterns.length > this.maxSize) {
            this.patterns.shift();
        }

        this._save();
    }

    addAll(patterns) {
        if (!Array.isArray(patterns)) return;
        patterns.forEach(p => this.add(p));
    }

    getRecent() {
        return [...this.patterns];
    }

    _save() {
        try {
            writeFileSync(PATTERNS_FILE, JSON.stringify(this.patterns, null, 2));
        } catch (err) {
            console.error(`[PatternHistory] Save error:`, err.message);
        }
    }

    _load() {
        try {
            if (existsSync(PATTERNS_FILE)) {
                const data = readFileSync(PATTERNS_FILE, 'utf-8');
                const loaded = JSON.parse(data);
                if (Array.isArray(loaded)) {
                    this.patterns = loaded;
                    console.log(`[PatternHistory] Loaded ${this.patterns.length} historical patterns`);
                }
            }
        } catch (err) {
            console.error(`[PatternHistory] Load error:`, err.message);
        }
    }
}
