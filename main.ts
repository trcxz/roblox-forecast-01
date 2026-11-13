import * as fs from 'fs';
import * as path from 'path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR!;
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR!;

interface Snapshot {
  at: string;
  up_and_coming: Array<{ universe_id: number; root_place_id: number; name: string; playing: number; rank: number }>;
}

interface Task {
  window: { from: string; until: string; slot_minutes: number; slots: number };
  places: number;
  output: string;
}

const task: Task = JSON.parse(fs.readFileSync(path.join(INPUT_DIR, 'task.json'), 'utf-8'));
const historyLines = fs.readFileSync(path.join(INPUT_DIR, 'history.ndjson'), 'utf-8').trim().split('\n');
const snapshots: Snapshot[] = historyLines.map(l => JSON.parse(l));

const WINDOW_START = new Date(task.window.from).getTime();
const WINDOW_END = new Date(task.window.until).getTime();
const MOMENTUM_DECAY_DAYS = 2.5;

function momentumScore(snapshots: Snapshot[], universeId: number, refTime: number): number {
  let score = 0;
  for (const snap of snapshots) {
    const t = new Date(snap.at).getTime();
    if (t > refTime) continue;
    const entry = snap.up_and_coming.find(e => e.universe_id === universeId);
    if (!entry) continue;
    const daysAgo = (refTime - t) / (1000 * 60 * 60 * 24);
    const weight = Math.exp(-daysAgo / MOMENTUM_DECAY_DAYS);
    score += entry.playing * weight;
  }
  return score;
}

const universeIds = new Set<number>();
for (const snap of snapshots) {
  for (const e of snap.up_and_coming) universeIds.add(e.universe_id);
}

const refTime = WINDOW_END;
const scored = Array.from(universeIds).map(id => ({
  universe_id: id,
  place: snapshots[snapshots.length - 1]?.up_and_coming.find(e => e.universe_id === id)?.root_place_id ?? 0,
  score: momentumScore(snapshots, id, refTime)
})).filter(s => s.score > 0 && Number.isFinite(s.score));

const total = scored.reduce((a, b) => a + b.score, 0);
const probabilities = scored.map(s => ({
  universe_id: s.universe_id,
  place: s.place,
  p: total > 0 ? s.score / total : 0
})).filter(p => Number.isFinite(p.p) && p.p > 0).sort((a, b) => b.p - a.p);

const top10 = probabilities.slice(0, task.places).map(p => p.universe_id);

fs.mkdirSync(OUTPUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUTPUT_DIR, task.output), JSON.stringify({ probabilities, top10 }, null, 2));