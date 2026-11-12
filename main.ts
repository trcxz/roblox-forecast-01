// roblox-up-and-coming-forecast-01: momentum-adjusted rank forecast
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const IDIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const ODIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const task = JSON.parse(readFileSync(join(IDIR, 'task.json'), 'utf8'));
const places = task.places; // 10
const outName = task.output; // "forecast.json"

const lines = readFileSync(join(IDIR, 'history.ndjson'), 'utf8').split('\n').filter(l => l);
const reads = lines.map(l => JSON.parse(l)).filter((m: any) => m.ok && Array.isArray(m.up_and_coming) && m.up_and_coming.length > 0);

interface Game { 
  uid: number; 
  name: string; 
  times: number[]; 
  ranks: number[]; 
  playing: number[]; 
  lastRank: number; 
  lastPlaying: number; 
  momentum: number; 
  playGrowth: number; 
}

const gameMap = new Map<number, Game>();

for (const snap of reads) {
  const t = new Date(snap.at).getTime();
  for (const row of snap.up_and_coming) {
    let g = gameMap.get(row.universe_id);
    if (!g) { 
      g = { 
        uid: row.universe_id, 
        name: row.name || '', 
        times: [], 
        ranks: [], 
        playing: [], 
        lastRank: 999, 
        lastPlaying: 0, 
        momentum: 0, 
        playGrowth: 0 
      }; 
      gameMap.set(row.universe_id, g); 
    }
    g.times.push(t); 
    g.ranks.push(row.rank); 
    g.playing.push(row.playing || 0);
    g.lastRank = row.rank; 
    g.lastPlaying = row.playing || 0;
  }
}

// Compute momentum: weighted rank change rate (per day)
// Negative momentum = rising (rank decreasing = good)
for (const [, g] of gameMap) {
  const n = g.ranks.length;
  if (n >= 2) {
    let sw = 0, sd = 0;
    for (let i = 1; i < n; i++) {
      const dt = (g.times[i] - g.times[i - 1]) / 8.64e7; // days
      if (dt <= 0) continue;
      const dr = g.ranks[i] - g.ranks[i - 1]; // positive = falling
      const w = Math.exp(-(g.times[n - 1] - g.times[i]) / 8.64e7 / 5); // recent weighted
      sw += w; 
      sd += w * dr / dt;
    }
    g.momentum = sw > 0 ? sd / sw : 0; // positive = falling, negative = rising
    // player growth rate
    if (g.playing[n - 1] > 0 && g.playing[0] > 0) {
      g.playGrowth = (g.playing[n - 1] / g.playing[0] - 1);
    }
  }
}

// Extrapolate to window midpoint
const winFrom = new Date(task.window.from).getTime();
const winUntil = new Date(task.window.until).getTime();
const winMid = (winFrom + winUntil) / 2;
const tLast = reads[reads.length - 1] ? new Date(reads[reads.length - 1].at).getTime() : winFrom;
const extrapDays = (winMid - tLast) / 8.64e7;

// Build sorted list by last rank
const games = [...gameMap.values()].sort((a, b) => a.lastRank - b.lastRank);
const chartSize = 100;

// Adjusted rank: shift by momentum (rising games get lower adjRank)
for (const g of games) {
  const rankShift = g.momentum * extrapDays; // positive momentum (falling) → higher adjRank
  // also factor in player growth: games with growing players tend to rise
  const playBonus = Math.min(3, Math.max(-3, -g.playGrowth * 2)); // growing → lower adjRank
  (g as any).adjRank = g.lastRank + rankShift + playBonus * 0.5;
}

const top = games.slice(0, Math.min(chartSize, games.length));

// Gaussian rank probabilities
const sigma = Math.max(2.0, extrapDays * 1.5); // uncertainty grows with extrapolation
const NEWCOMER_RESERVE = 0.20; // leave 20% unnamed per place

const probabilities: Array<{ universe_id: number; place: number; p: number }> = [];

for (let place = 1; place <= places; place++) {
  const namedBudget = 1 - NEWCOMER_RESERVE;
  const ws = top.map(g => Math.exp(-(((g as any).adjRank - place) ** 2) / (2 * sigma * sigma)));
  const wSum = ws.reduce((a: number, b: number) => a + b, 0);
  let count = 0;
  for (let i = 0; i < top.length && count < 100; i++) {
    const p = namedBudget * ws[i] / wSum;
    if (p < 0.0005) continue;
    probabilities.push({ universe_id: top[i].uid, place, p: Math.floor(p * 1e6) / 1e6 });
    count++;
  }
}

// Top 10: by adjusted rank
const top10 = [...top].sort((a, b) => (a as any).adjRank - (b as any).adjRank).slice(0, 10).map(g => g.uid);

mkdirSync(ODIR, { recursive: true });
writeFileSync(join(ODIR, outName), JSON.stringify({ probabilities, top10 }) + '\n');
process.stderr.write(`forecast: ${probabilities.length} prob rows, top10=${top10.length}, sigma=${sigma.toFixed(2)}, extrapDays=${extrapDays.toFixed(1)}\n`);