// roblox-up-and-coming-forecast-01: a momentum-adjusted rank forecast of the
// Up-and-Coming chart's top 10, written from scratch.
//
// The chart moves several times a day as new games climb it and older ones age
// out, so a forecast that freezes the chart as it stood (the house baseline)
// loses the places that move. This entry instead estimates each candidate's
// recent rank velocity (momentum) from the whole history, extrapolates it over
// the scored window's midpoint, bends it with player-count growth, and turns
// the resulting adjusted ranks into a place-by-game probability matrix with a
// Gaussian kernel around each place. A reserve is left unnamed at every place
// for games the history never named.
//
// Node 22+ standard library only, no network. Reads $MAKEFUN_INPUT_DIR (or
// /input), writes $MAKEFUN_OUTPUT_DIR (or /output)/forecast.json:
//   {"probabilities": [{"universe_id", "place", "p"}...], "top10": [10 ids]}

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const IDIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const ODIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const DAY_MS = 86_400_000;
/** Time constant (days) of the exponential recency weight on rank deltas. */
const MOMENTUM_DECAY_DAYS = 3.5;
/** Std-dev (chart places) of the Gaussian place kernel at zero horizon. */
const SIGMA_FLOOR = 2.0;
/** How fast the kernel widens per day of extrapolation. */
const SIGMA_PER_DAY = 1.5;
/** Share of each place left unnamed, for games the history never named. */
const NEWCOMER_RESERVE = 0.2;
/** Rows below this probability are dropped from the output. */
const MIN_P = 0.0005;
/** Most candidate games considered, and most rows a single place may hold. */
const CANDIDATES = 100;
const MAX_ROWS_PER_PLACE = 100;

interface Row {
  rank: number;
  universe_id: number;
  name?: string | null;
  playing?: number | null;
}
interface Snapshot {
  ok: boolean;
  at: string;
  up_and_coming: Row[];
}
interface Task {
  places: number;
  output: string;
  window: { from: string; until: string };
}
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
  adjRank: number;
}

const task = JSON.parse(readFileSync(join(IDIR, 'task.json'), 'utf8')) as Task;
const places = task.places;
const outName = task.output;

// Valid reads only, oldest first, so momentum has a stable sign.
const snaps = readFileSync(join(IDIR, 'history.ndjson'), 'utf8')
  .split('\n')
  .filter((l) => l.length > 0)
  .map((l) => JSON.parse(l) as Snapshot)
  .filter((s) => s.ok === true && Array.isArray(s.up_and_coming) && s.up_and_coming.length > 0)
  .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

const gameMap = new Map<number, Game>();
for (const snap of snaps) {
  const t = Date.parse(snap.at);
  for (const row of snap.up_and_coming) {
    let g = gameMap.get(row.universe_id);
    if (g === undefined) {
      g = {
        uid: row.universe_id,
        name: row.name ?? '',
        times: [],
        ranks: [],
        playing: [],
        lastRank: 9999,
        lastPlaying: 0,
        momentum: 0,
        playGrowth: 0,
        adjRank: 9999,
      };
      gameMap.set(row.universe_id, g);
    }
    const p = row.playing ?? 0;
    g.times.push(t);
    g.ranks.push(row.rank);
    g.playing.push(p);
    g.lastRank = row.rank;
    g.lastPlaying = p;
  }
}

// Recency-weighted mean rank velocity (places per day). A negative delta is a
// climb, so a climbing game has negative momentum.
for (const g of gameMap.values()) {
  const n = g.ranks.length;
  if (n >= 2) {
    let sw = 0;
    let sd = 0;
    const tEnd = g.times[n - 1];
    for (let i = 1; i < n; i++) {
      const dt = (g.times[i] - g.times[i - 1]) / DAY_MS;
      if (dt <= 0) continue;
      const dr = g.ranks[i] - g.ranks[i - 1];
      const w = Math.exp(-(tEnd - g.times[i]) / DAY_MS / MOMENTUM_DECAY_DAYS);
      sw += w;
      sd += (w * dr) / dt;
    }
    g.momentum = sw > 0 ? sd / sw : 0;
    if (g.playing[0] > 0 && g.playing[n - 1] > 0) {
      g.playGrowth = g.playing[n - 1] / g.playing[0] - 1;
    }
  }
}

const winFrom = Date.parse(task.window.from);
const winUntil = Date.parse(task.window.until);
const winMid = (winFrom + winUntil) / 2;
const tLast = snaps.length > 0 ? Date.parse(snaps[snaps.length - 1].at) : winFrom;
const horizonDays = (winMid - tLast) / DAY_MS;

// Candidates: the games nearest the top of the last chart, by last rank.
const top = [...gameMap.values()]
  .sort((a, b) => a.lastRank - b.lastRank)
  .slice(0, Math.min(CANDIDATES, gameMap.size));

/** Hard clamp (chart places) on an extrapolated shift, so one noisy read mid-history
 *  cannot fling a game across the chart. */
const MAX_RANK_SHIFT = 25;

for (const g of top) {
  const rawShift = g.momentum * horizonDays;
  const rankShift = Number.isFinite(rawShift)
    ? Math.max(-MAX_RANK_SHIFT, Math.min(MAX_RANK_SHIFT, rawShift))
    : 0;
  const playBonus = Math.min(3, Math.max(-3, -g.playGrowth * 2));
  // Trust the extrapolation only as far as the history supports it: a game seen
  // in few reads keeps more of its last known rank instead of a noisy velocity.
  const trust = Math.min(1, g.ranks.length / 8);
  const adj = g.lastRank + trust * (rankShift + playBonus * 0.5);
  // Guard the final rank: never non-finite, never above place 1.
  g.adjRank = Number.isFinite(adj) ? Math.max(1, adj) : g.lastRank;
}

const sigma = Math.max(SIGMA_FLOOR, horizonDays * SIGMA_PER_DAY);
const namedBudget = 1 - NEWCOMER_RESERVE;

const probabilities: Array<{ universe_id: number; place: number; p: number }> = [];
for (let place = 1; place <= places; place++) {
  const ws = top.map((g) => Math.exp(-((g.adjRank - place) ** 2) / (2 * sigma * sigma)));
  const wSum = ws.reduce((a, b) => a + b, 0);
  let rows = 0;
  for (let i = 0; i < top.length && rows < MAX_ROWS_PER_PLACE; i++) {
    const p = wSum > 0 ? (namedBudget * ws[i]) / wSum : 0;
    if (p < MIN_P) continue;
    probabilities.push({ universe_id: top[i].uid, place, p: Math.floor(p * 1e6) / 1e6 });
    rows++;
  }
}

const top10 = [...top]
  .sort((a, b) => a.adjRank - b.adjRank)
  .slice(0, 10)
  .map((g) => g.uid);

mkdirSync(ODIR, { recursive: true });
writeFileSync(join(ODIR, outName), JSON.stringify({ probabilities, top10 }) + '\n');
process.stderr.write(
  `forecast: rows=${probabilities.length} places=${places} top10=${top10.length} ` +
    `sigma=${sigma.toFixed(2)} horizonDays=${horizonDays.toFixed(2)} candidates=${top.length}\n`,
);
