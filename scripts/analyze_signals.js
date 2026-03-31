import fs from 'fs';

const data = JSON.parse(fs.readFileSync('signal_log.json'));
const signals = data[0].results;

console.log(`Total signals: ${signals.length}`);

const wins = signals.filter(s => s.outcome === 'WIN');
const losses = signals.filter(s => s.outcome === 'LOSS');
const blocked = signals.filter(s => s.filters_that_would_have_blocked !== 'NONE');

console.log(`Wins: ${wins.length}`);
console.log(`Losses: ${losses.length}`);
console.log(`Blocked: ${blocked.length}`);

// Analyze blocked wins
const blockedWins = wins.filter(s => s.filters_that_would_have_blocked !== 'NONE');
console.log(`Blocked Wins: ${blockedWins.length}`);

const blockReasons = {};
blockedWins.forEach(s => {
    const reasons = s.filters_that_would_have_blocked.split(',');
    reasons.forEach(r => {
        blockReasons[r] = (blockReasons[r] || 0) + 1;
    });
});

console.log('Block Reasons for Wins:', blockReasons);

// Average metrics for Wins vs Losses
const avg = (arr, key) => arr.length ? (arr.reduce((acc, s) => acc + (s[key] || 0), 0) / arr.length).toFixed(2) : 0;

console.log('\n--- Metrics Comparison ---');
console.log(`Metric | Wins (n=${wins.length}) | Losses (n=${losses.length})`);
console.log(`Acc Score | ${avg(wins, 'accumulation_score')} | ${avg(losses, 'accumulation_score')}`);
console.log(`Acc Duration | ${avg(wins, 'minutes_accumulating')} | ${avg(losses, 'minutes_accumulating')}`);
