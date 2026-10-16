// 방 구조를 자동으로 만들어 data/layouts.json에 채운다: node scripts/gen-layouts.js [목표 개수]
// 큰 사각형을 가로나 세로로 반복해서 잘라 방 6개를 만든다. 일부는 맞닿아 있어도 문이 없는 벽을 둔다.
// 서버와 같은 검사(통로 연결)를 거치고, 어느 방이 현장이 되어도 사건을 만들 수 있는 구조만 남긴다.
// 손으로 만든 구조(auto 표시가 없는 것)는 그대로 두고, 예전에 자동으로 만든 구조만 새로 바꾼다.
import { readFileSync, writeFileSync } from 'node:fs';
import { checkMap } from '../src/maps.js';
import { makeStructure, PLACES } from '../src/puzzle.js';

const FILE = new URL('../data/layouts.json', import.meta.url);
const TARGET = Number(process.argv[2]) || 100;
const GAP = 3; // 방 사이 벽 두께 (퍼센트). maps.js의 맞닿음 기준(4 이하)보다 작아야 한다
const MIN_W = 14;
const MIN_H = 18;
const ASPECTS = [[16, 10], [16, 10], [16, 10], [16, 9], [3, 2], [4, 3], [16, 8]];

const rand = Math.random;
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const round = (n) => Math.round(n * 2) / 2;

/** 사각형 하나를 방 6개로 자른다. 실패하면 null */
function partition() {
  let rects = [{ x: 2, y: 3, w: 96, h: 94 }];
  while (rects.length < PLACES) {
    // 큰 방일수록 먼저 자른다
    const sorted = [...rects].sort((a, b) => b.w * b.h - a.w * a.h);
    const target = rand() < 0.7 ? sorted[0] : pick(sorted.slice(0, 2));
    const vertical = target.w > target.h * 1.3 ? rand() < 0.8 : target.h > target.w * 1.3 ? rand() < 0.2 : rand() < 0.5;
    const r = 0.3 + rand() * 0.4;
    let a, b;
    if (vertical) {
      const cut = target.w * r;
      a = { x: target.x, y: target.y, w: cut - GAP / 2, h: target.h };
      b = { x: target.x + cut + GAP / 2, y: target.y, w: target.w - cut - GAP / 2, h: target.h };
    } else {
      const cut = target.h * r;
      a = { x: target.x, y: target.y, w: target.w, h: cut - GAP / 2 };
      b = { x: target.x, y: target.y + cut + GAP / 2, w: target.w, h: target.h - cut - GAP / 2 };
    }
    if ([a, b].some((q) => q.w < MIN_W || q.h < MIN_H)) return null;
    rects = rects.filter((q) => q !== target).concat(a, b);
  }
  return rects.map((q) => ({ x: round(q.x), y: round(q.y), w: round(q.w), h: round(q.h) }));
}

const dummyNames = ['가', '나', '다', '라', '마', '바'];

/** 현장을 slot에 둔 지도 (검사 통과 못 하면 예외) */
function asMap(layout, slot) {
  return checkMap({
    name: 'test',
    theme: 'test',
    aspect: layout.aspect,
    rooms: layout.rooms.map((r, i) => ({ ...r, name: dummyNames[i], scene: i === slot })),
    ...(layout.doors && { doors: layout.doors.map(([a, b]) => [dummyNames[a], dummyNames[b]]) }),
  }, 'gen');
}

/** 맞닿은 방 쌍 중 일부만 문으로 남긴다: 무작위 신장 트리 + 몇 개 더 */
function someDoors(layout) {
  const m = asMap(layout, 0);
  // asMap은 현장을 0번으로 옮기므로 원래 순서로 되돌린다
  const order = [0, ...layout.rooms.map((_, i) => i).filter((i) => i !== 0)];
  const pairs = [];
  m.adj.forEach((list, a) => list.forEach((b) => a < b && pairs.push([order[a], order[b]])));
  const shuffled = [...pairs].sort(() => rand() - 0.5);
  const parent = layout.rooms.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const doors = [];
  const extra = [];
  for (const [a, b] of shuffled) {
    if (find(a) !== find(b)) {
      parent[find(a)] = find(b);
      doors.push([a, b]);
    } else {
      extra.push([a, b]);
    }
  }
  for (const e of extra) if (rand() < 0.4) doors.push(e);
  return doors.length < pairs.length ? doors : null; // 막힌 벽이 하나도 없으면 문 지정이 의미 없다
}

/** 어느 방이 현장이 되어도 사건을 만들 수 있는지 */
function playable(layout) {
  for (let slot = 0; slot < PLACES; slot++) {
    try {
      makeStructure(asMap(layout, slot).adj);
    } catch {
      return false;
    }
  }
  return true;
}

const signature = (l) => JSON.stringify(l.rooms.map((r) => [r.x, r.y, r.w, r.h].map((n) => Math.round(n / 5))).sort()) + JSON.stringify(l.doors ?? []);

const all = JSON.parse(readFileSync(FILE, 'utf8'));
const handmade = all.filter((l) => !l.auto);
const seen = new Set(handmade.map(signature));
const made = [];
let tries = 0;
while (handmade.length + made.length < TARGET && tries < 20000) {
  tries++;
  const rooms = partition();
  if (!rooms) continue;
  const layout = { name: '', auto: true, aspect: pick(ASPECTS), rooms };
  try {
    asMap(layout, 0);
  } catch {
    continue;
  }
  if (rand() < 0.4) {
    const doors = someDoors(layout);
    if (doors) layout.doors = doors;
  }
  if (seen.has(signature(layout)) || !playable(layout)) continue;
  seen.add(signature(layout));
  layout.name = `자동 ${String(made.length + 1).padStart(2, '0')}${layout.doors ? ' (막힌 벽 있음)' : ''}`;
  made.push(layout);
}

writeFileSync(FILE, JSON.stringify([...handmade, ...made], null, 2) + '\n');
console.log(`손으로 만든 구조 ${handmade.length}개 + 자동 구조 ${made.length}개 = ${handmade.length + made.length}개 (시도 ${tries}번)`);
console.log(`막힌 벽 있는 구조: ${made.filter((l) => l.doors).length}개`);
