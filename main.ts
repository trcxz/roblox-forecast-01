// roblox-up-and-coming-forecast-01 — momentum-adjusted rank forecast.
//
// Rewritten from scratch. Read the snapshot history, estimate each candidate
// game's recency-weighted rank velocity (momentum), extrapolate it to the
// scored window's midpoint, blend in player-count growth, then turn the
// adjusted ranks into a per-place probability matrix over the chart's top
// places. A fixed share of every place is reserved for games the history
// never named. Node standard library only, no network, fully deterministic.
//
// Reads $MAKEFUN_INPUT_DIR (default /input), writes $MAKEFUN_OUTPUT_DIR
// (default /output)/<task.output>:
//   {"probabilities":[{"universe_id","place","p"}], "top10":[10 ids]}

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const IDIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const ODIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const DAY_MS = 86_400_000;

// ---- model constants ----
/** Recency time-constant (days) on rank deltas used to weight momentum. */
const MOMENTUM_DECAY_DAYS = 2.0;
/** Std-dev (chart places) of the place kernel at zero horizon. */
const SIGMA_FLOOR = 2.0;
/** How fast the place kernel widens per day of extrapolation. */
const SIGMA_PER_DAY = 1.5;
/** Share of each place left unnamed, for games the history never named. */
const NEWCOMER_RESERVE = 0.2;
/** Rows below this probability are dropped from the output. */
const MIN_P = 0.0005;
/** Most candidate games considered, and most rows a single place may hold. */
const CANDIDATES = 100;
const MAX_ROWS_PER_PLACE = 100;
/** Hard clamp (chart places) on an extrapolated rank shift. */
const MAX_RANK_SHIFT = 25;
/** Observations needed before a game's extrapolation is fully trusted. */
const TRUST_OBS = 8;

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
  momentum: number;
  playGrowth: number;
  adjRank: number;
}

const task = JSON.parse(readFileSync(join(IDIR, 'task.json'), 'utf8')) as Task;
const places = task.places;
const outName = task.output;

// Valid reads only, oldest first, so momentum has a stable sign.
const snaps: Snapshot[] = readFileSync(join(IDIR, 'history.ndjson'), 'utf8')
  .split('\n')
  .filter((line) => line.trim().length > 0)
  .map((line) => JSON.parse(line) as Snapshot)
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
        momentum: 0,
        playGrowth: 0,
        adjRank: 9999,
      };
      gameMap.set(row.universe_id, g);
    }
    g.times.push(t);
    g.ranks.push(row.rank);
    g.playing.push(row.playing ?? 0);
    g.lastRank = row.rank;
    if (row.name) g.name = row.name;
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
const top: Game[] = [...gameMap.values()]
  .sort((a, b) => a.lastRank - b.lastRank || a.uid - b.uid)
  .slice(0, Math.min(CANDIDATES, gameMap.size));

for (const g of top) {
  const rawShift = g.momentum * horizonDays;
  const rankShift = Number.isFinite(rawShift)
    ? Math.max(-MAX_RANK_SHIFT, Math.min(MAX_RANK_SHIFT, rawShift))
    : 0;
  const playBonus = Math.min(3, Math.max(-3, -g.playGrowth * 2));
  // Trust the extrapolation only as far as the history supports it: a game seen
  // in few reads keeps more of its last known rank instead of a noisy velocity.
  const trust = Math.min(1, g.ranks.length / TRUST_OBS);
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
    let p = wSum > 0 ? (namedBudget * ws[i]) / wSum : 0;
    // Confidence scaling: a game the history barely observed gets a damped share.
    const conf = Math.min(1, top[i].ranks.length / TRUST_OBS);
    p *= conf;
    // Guard: emit only finite, strictly positive rows.
    if (!Number.isFinite(p) || p <= 0 || p < MIN_P) continue;
    probabilities.push({ universe_id: top[i].uid, place, p: Math.floor(p * 1e6) / 1e6 });
    rows++;
  }
}

const top10 = [...top]
  .sort((a, b) => a.adjRank - b.adjRank || a.uid - b.uid)
  .slice(0, 10)
  .map((g) => g.uid);

mkdirSync(ODIR, { recursive: true });
writeFileSync(join(ODIR, outName), JSON.stringify({ probabilities, top10 }) + '\n');
process.stderr.write(
  `forecast: rows=${probabilities.length} places=${places} top10=${top10.length} ` +
    `sigma=${sigma.toFixed(2)} horizonDays=${horizonDays.toFixed(2)} candidates=${top.length}\n`,
);
