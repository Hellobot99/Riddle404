// 사건의 논리 구조. AI가 아니라 서버가 무작위로 만들고 검증한다.
// AI는 여기에 이름과 문장만 입히므로, 어떤 문장이 나와도 사건은 항상 풀 수 있다.
//
// 추리 규칙 (플레이어에게도 그대로 알려 준다)
//   - 사건 현장(0번 장소)의 기록은 완전히 지워져서 관측할 수 없다(404).
//   - 범행 시각에 현장에 있던 사람은 범인 한 명뿐이다.
//   - 범인은 범행 시각의 자기 기록을 위조해, 다른 방에 있었던 것처럼 꾸몄다(fakes).
//     그래서 범행 시각에도 다섯 명이 모두 어딘가에 찍힌다.
//   - 30분 동안은 제자리에 있거나 통로로 이어진 이웃 방으로만 움직인다 (지도의 adj, 잠긴 문 locks).
//     범인의 위조 기록은 진짜 동선과 이어지지 않아 허점이 정확히 한 군데 생긴다.
//   - 현장 쪽에서 소리가 난 기록이 추정 시간대 안에 두 시각 남아 있다. 하나는 진짜 범행 시각(time),
//     하나는 범행과 무관한 소리(decoy)다. 가짜 소리 시각에는 현장이 비어 있었다.
//   → 30분 만에 갈 수 없는 이동이 찍힌 사람이 기록을 위조한 범인이다.
//
// 난이도가 오르면 변형 규칙이 하나씩 쌓인다 (LEVELS).
//   accomplice  공범: 범행 시각 위조 기록에 공범이 함께 찍혀 거짓 증언을 한다 (함께 찍혀도 증인이 아닐 수 있다)
//   blackout    정전: 한 시각 동안 기록에 사람 수만 남는다 (허점이 보이는 시각은 피한다)
//   lock        잠긴 문: 한 통로가 몇 시간 잠긴다. 범인의 허점이 바로 그 잠긴 문이다
//   doubleFake  이중 위조: 범인이 범행 시각과 바로 옆 시각까지 두 칸을 위조해 허점이 한 칸 바깥으로 밀린다

export const PLACES = 6; // 0번이 사건 현장
export const TIMES = 8; // 19:00부터 30분 간격
export const SUSPECTS = 5;
export const SCENE = 0;
const START_MINUTES = 19 * 60;
const WINDOW = 4; // 브리핑에서 알려 주는 범행 추정 시간대 칸 수
const LOCK_SPAN = 3; // 문이 잠겨 있는 시간 (칸 수)

/** 난이도별 변형 규칙. 1단계는 기본, 단계가 오를 때마다 하나씩 더해진다 */
export const LEVELS = [
  { level: 1, mods: [] },
  { level: 2, mods: ['accomplice'] },
  { level: 3, mods: ['accomplice', 'blackout'] },
  { level: 4, mods: ['accomplice', 'blackout', 'lock'] },
  { level: 5, mods: ['accomplice', 'blackout', 'lock', 'doubleFake'] },
];
export const modsFor = (level) => new Set(LEVELS.find((l) => l.level === level)?.mods ?? []);

export function timeLabel(t) {
  const m = START_MINUTES + t * 30;
  return `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

const randInt = (rand, lo, hi) => lo + Math.floor(rand() * (hi - lo + 1)); // lo~hi 포함
const pick = (rand, arr) => arr[Math.floor(rand() * arr.length)];
const observable = Array.from({ length: PLACES - 1 }, (_, i) => i + 1);

/**
 * @typedef {{kind: 'time' | 'decoy' | 'suspicious' | 'motive' | 'flavor', place: number, time: number, who: number | null}} PuzzleEvent
 * @typedef {{a: number, b: number, from: number, to: number}} Lock 방 a와 b 사이 문이 from~to 시각에 도착하는 이동을 막는다
 * @typedef {{place: number, time: number}} Fake
 * @typedef {{
 *   level: number, culprit: number, crimeTime: number, decoyTime: number, window: [number, number],
 *   presence: number[][], fake: Fake, fakes: Fake[], accomplice: number | null, blackout: number | null,
 *   locks: Lock[], events: PuzzleEvent[], adj: number[][],
 * }} Structure
 */

/** t-1 시각 x에서 t 시각 y로 갈 수 있는지 (제자리, 또는 잠기지 않은 통로로 이어진 옆방) */
export function canMove(s, x, y, t) {
  if (x === y) return true;
  if (!s.adj[x].includes(y)) return false;
  return !s.locks.some((l) => ((l.a === x && l.b === y) || (l.a === y && l.b === x)) && t >= l.from && t <= l.to);
}

/**
 * @param {number[][]} adj 지도의 이웃 방 목록 (adj[p] = p와 이어진 방들)
 * @param {number} level 난이도 (1~5)
 * @returns {Structure}
 */
export function makeStructure(adj, level = 1, rand = Math.random) {
  for (let attempt = 0; attempt < 5000; attempt++) {
    const s = tryMake(adj, level, rand);
    if (validate(s).ok) return s;
  }
  throw new Error(`사건 구조를 만들지 못했습니다 (난이도 ${level})`);
}

function tryMake(adj, level, rand) {
  const mods = modsFor(level);
  const culprit = randInt(rand, 0, SUSPECTS - 1);
  const crimeTime = randInt(rand, 2, TIMES - 3);
  const winStart = randInt(rand, Math.max(0, crimeTime - WINDOW + 1), Math.min(crimeTime, TIMES - WINDOW));
  const window = [winStart, winStart + WINDOW - 1];
  // 가짜 소리 시각은 먼저 정해 두고, 그 시각엔 아무도 현장에 못 들어가게 동선을 만든다
  const decoyTime = pick(rand, [...Array(WINDOW).keys()].map((i) => winStart + i).filter((t) => t !== crimeTime));

  const banned = (s, t, p) => p === SCENE && (t === decoyTime || (s !== culprit && t === crimeTime));
  // 30분 뒤(또는 앞) 위치: 대체로 머물고, 가끔 이웃 방으로 옮긴다
  const step = (s, t, from) => {
    const stay = banned(s, t, from) ? [] : [from];
    const moves = adj[from].filter((p) => !banned(s, t, p));
    if (stay.length && (rand() < 0.55 || !moves.length)) return from;
    return moves.length ? pick(rand, moves) : null;
  };

  const presence = [];
  for (let s = 0; s < SUSPECTS; s++) {
    const row = Array(TIMES).fill(null);
    if (s === culprit) {
      // 범인은 범행 시각에 현장에 있고, 거기서부터 앞뒤로 동선을 잇는다
      row[crimeTime] = SCENE;
      for (let t = crimeTime - 1; t >= 0; t--) row[t] = step(s, t, row[t + 1]);
      for (let t = crimeTime + 1; t < TIMES; t++) row[t] = step(s, t, row[t - 1]);
    } else {
      row[0] = pick(rand, observable);
      for (let t = 1; t < TIMES; t++) row[t] = step(s, t, row[t - 1]);
    }
    if (row.includes(null)) return null;
    presence.push(row);
  }
  const others = (t, p) => presence.map((row, i) => (i !== culprit && row[t] === p ? i : -1)).filter((i) => i >= 0);

  // ---- 위조 기록 ----
  // 위조 칸들(fakes)을 고르고, 위조된 동선의 마지막 이음매(flaw)가 30분 만에 갈 수 없는 이동이 되게 한다.
  // 잠긴 문 규칙이면 그 이음매는 "보통은 옆방이지만 그 시간에 문이 잠겨 있던" 이동이다.
  const fakes = [];
  let accomplice = null;
  const locks = [];
  const fakeRoomOk = (t, f, allowAccomplice) => {
    const o = others(t, f);
    if (allowAccomplice && mods.has('accomplice')) {
      if (o.length !== 1) return false;
      return true;
    }
    return o.length === 0;
  };
  // 이음매 x(시각 tx) ↔ f(시각 tf)가 허점이 되게 만든다. 잠긴 문이면 잠금을 정해 돌려준다.
  const makeFlaw = (x, f, arriveTime) => {
    if (x === SCENE || x === f) return null;
    if (!mods.has('lock')) return adj[x].includes(f) ? null : {};
    if (!adj[x].includes(f)) return null;
    const from = Math.max(1, randInt(rand, arriveTime - LOCK_SPAN + 1, arriveTime));
    return { lock: { a: x, b: f, from, to: Math.min(TIMES - 1, from + LOCK_SPAN - 1) } };
  };

  if (!mods.has('doubleFake')) {
    const sides = [{ x: presence[culprit][crimeTime - 1], arrive: crimeTime }, { x: presence[culprit][crimeTime + 1], arrive: crimeTime + 1 }];
    const options = [];
    for (const f of observable) {
      if (!fakeRoomOk(crimeTime, f, true)) continue;
      for (const side of sides) {
        const flaw = makeFlaw(side.x, f, side.arrive);
        if (flaw) options.push({ f, flaw });
      }
    }
    if (!options.length) return null;
    const { f, flaw } = pick(rand, options);
    fakes.push({ place: f, time: crimeTime });
    if (flaw.lock) locks.push(flaw.lock);
  } else {
    // 이중 위조: 범행 시각(f1)과 바로 옆 시각(f2)을 위조한다. 진짜 → f1 → f2 는 자연스럽고, f2 → 진짜 에서 끊긴다.
    const d = rand() < 0.5 ? 1 : -1;
    const t2 = crimeTime + d;
    const t3 = crimeTime + 2 * d;
    if (t3 < 0 || t3 >= TIMES) return null;
    const x = presence[culprit][crimeTime - d]; // 위조 반대편 진짜 위치
    const y = presence[culprit][t3]; // 허점이 생기는 진짜 위치
    if (y === SCENE) return null;
    const options = [];
    for (const f1 of observable) {
      if (!fakeRoomOk(crimeTime, f1, true)) continue;
      if (x !== SCENE && !(x === f1 || adj[x].includes(f1))) continue;
      for (const f2 of [f1, ...adj[f1]]) {
        if (f2 === SCENE || !fakeRoomOk(t2, f2, false)) continue;
        const flaw = makeFlaw(y, f2, d > 0 ? t3 : t2);
        if (flaw) options.push({ f1, f2, flaw });
      }
    }
    if (!options.length) return null;
    const { f1, f2, flaw } = pick(rand, options);
    fakes.push({ place: f1, time: crimeTime }, { place: f2, time: t2 });
    if (flaw.lock) locks.push(flaw.lock);
  }
  if (mods.has('accomplice')) accomplice = others(crimeTime, fakes[0].place)[0];
  const forged = new Set(fakes.map((f) => f.time));

  // ---- 정전 ----
  // 사람 수만 남는 시각. 범행 시각과 허점이 보여야 하는 시각, 위조된 시각은 피한다.
  let blackout = null;
  if (mods.has('blackout')) {
    const protect = new Set([crimeTime, ...forged, ...flawTimes({ culprit, presence, fakes, adj, locks })]);
    const options = [];
    for (let t = window[0] - 1; t <= window[1] + 1; t++) if (t >= 0 && t < TIMES && !protect.has(t)) options.push(t);
    if (!options.length) return null;
    blackout = pick(rand, options);
  }

  const events = [];
  const used = new Set();
  const cellKey = (p, t) => `${p}:${t}`;
  const addEvent = (e) => {
    used.add(cellKey(e.place, e.time));
    events.push(e);
  };

  // 현장 쪽 소리: 진짜(범행 시각)와 가짜(현장이 비어 있던 시각)를 한 곳씩 둔다.
  addEvent({ kind: 'time', place: pick(rand, observable), time: crimeTime, who: null });
  addEvent({ kind: 'decoy', place: pick(rand, observable), time: decoyTime, who: null });

  // 수상한 행동 = 물건이 걸린 증거 기록. 범인 것(진짜 범행 수단)은 범행 30분 전후의 위조되지 않은 위치에 두고,
  // 범인이 아닌 2~3명의 것(헛증거)은 아무 시각에나 둔다. 고발할 때 이 물건들이 수단 선택지가 된다.
  const innocents = shuffle(rand, [...Array(SUSPECTS).keys()].filter((s) => s !== culprit)).slice(0, randInt(rand, 2, 3));
  for (const who of [culprit, ...innocents]) {
    const near = who === culprit ? [crimeTime - 1, crimeTime + 1].filter((t) => !forged.has(t)) : [...Array(TIMES).keys()];
    const options = near
      .filter((t) => t >= 0 && t < TIMES && t !== blackout && presence[who][t] !== SCENE && !used.has(cellKey(presence[who][t], t)));
    if (!options.length) {
      if (who === culprit) return null;
      continue;
    }
    const time = pick(rand, options);
    addEvent({ kind: 'suspicious', place: presence[who][time], time, who });
  }

  // 동기 단서: 진짜 동기의 핵심어가 담긴 기록(쪽지, 통화 등). 범인이 범행 전후가 아닌 다른 시각에 있던 방에 둔다.
  const motiveOptions = [...Array(TIMES).keys()]
    .filter((t) => Math.abs(t - crimeTime) > 1 && !forged.has(t) && presence[culprit][t] !== SCENE && !used.has(cellKey(presence[culprit][t], t)));
  if (!motiveOptions.length) return null;
  const motiveTime = pick(rand, motiveOptions);
  addEvent({ kind: 'motive', place: presence[culprit][motiveTime], time: motiveTime, who: null });

  // 분위기용 기록: 추리와 상관없는 잡음
  for (let i = 0; i < 4; i++) {
    const place = pick(rand, observable);
    const time = randInt(rand, 0, TIMES - 1);
    if (used.has(cellKey(place, time)) || time === crimeTime || time === decoyTime) continue;
    addEvent({ kind: 'flavor', place, time, who: null });
  }

  return { level, culprit, crimeTime, decoyTime, window, presence, fake: fakes[0], fakes, accomplice, blackout, locks, events, adj };
}

/** 기록상 위치: 범인의 위조된 시각만 가짜 방으로 바뀌어 있다 */
export function shownAt(s, who, time) {
  if (who !== s.culprit) return s.presence[who][time];
  return s.fakes.find((f) => f.time === time)?.place ?? s.presence[who][time];
}

/** 기록상 동선에서 30분 만에 갈 수 없는 이음매가 있는 시각들 (허점이 보이는 시각) */
function flawTimes(s) {
  const lockless = { ...s, locks: s.locks ?? [] };
  const view = (t) => (s.fakes.find((f) => f.time === t)?.place ?? s.presence[s.culprit][t]);
  const out = [];
  for (let t = 1; t < TIMES; t++) {
    const a = view(t - 1);
    const b = view(t);
    if (a !== SCENE && b !== SCENE && !canMove(lockless, a, b, t)) out.push(t - 1, t);
  }
  return out;
}

/** 구조가 규칙대로 풀리는지 검사한다. */
export function validate(s) {
  const fail = (reason) => ({ ok: false, reason });
  if (!s) return fail('구조 없음');
  const mods = modsFor(s.level);
  if (s.presence.length !== SUSPECTS || s.presence.some((row) => row.length !== TIMES)) return fail('크기가 맞지 않음');
  // 진짜 동선은 모두 제자리 또는 (잠기지 않은) 이웃 방으로만 움직인다
  const legal = s.presence.every((row) => row.every((p, t) => t === 0 || canMove(s, row[t - 1], p, t)));
  if (!legal) return fail('갈 수 없는 방으로 이동함');
  const atScene = s.presence.map((row, i) => (row[s.crimeTime] === SCENE ? i : -1)).filter((i) => i >= 0);
  if (atScene.length !== 1 || atScene[0] !== s.culprit) return fail('범행 시각에 현장에 범인 혼자 있지 않음');
  if (s.crimeTime < s.window[0] || s.crimeTime > s.window[1]) return fail('범행 시각이 추정 시간대 밖');
  const timeClues = s.events.filter((e) => e.kind === 'time');
  if (timeClues.length !== 1 || timeClues[0].time !== s.crimeTime) return fail('범행 시각 단서가 하나가 아님');
  const decoys = s.events.filter((e) => e.kind === 'decoy');
  if (decoys.length !== 1 || decoys[0].time !== s.decoyTime) return fail('가짜 소리가 하나가 아님');
  if (s.decoyTime === s.crimeTime || s.decoyTime < s.window[0] || s.decoyTime > s.window[1]) return fail('가짜 소리 시각이 맞지 않음');
  if (s.presence.some((row) => row[s.decoyTime] === SCENE)) return fail('가짜 소리 시각에 현장에 누가 있음');
  if (s.events.some((e) => e.place === SCENE)) return fail('현장에 기록이 있음');
  const culpritEvidence = s.events.filter((e) => e.kind === 'suspicious' && e.who === s.culprit);
  if (culpritEvidence.length !== 1 || Math.abs(culpritEvidence[0].time - s.crimeTime) !== 1) return fail('범행 수단 증거가 없음');
  if (s.events.filter((e) => e.kind === 'motive').length !== 1) return fail('동기 단서가 없음');

  // 범행 시각에 범인이 아닌 사람들이 너무 한곳에 몰리면 관측 한두 번에 끝나므로 흩어 놓는다
  const alibiPlaces = new Set(s.presence.filter((_, i) => i !== s.culprit).map((row) => row[s.crimeTime]));
  if (alibiPlaces.size < 3) return fail('알리바이 장소가 너무 적음');

  // ---- 위조 기록과 허점 ----
  const want = mods.has('doubleFake') ? 2 : 1;
  if (s.fakes.length !== want || s.fakes[0].time !== s.crimeTime || s.fakes.some((f) => f.place === SCENE)) return fail('위조 기록 개수가 맞지 않음');
  const occupants = (f) => s.presence.filter((row, i) => i !== s.culprit && row[f.time] === f.place).length;
  if (occupants(s.fakes[0]) !== (mods.has('accomplice') ? 1 : 0)) return fail('범행 시각 위조 방의 동석자가 맞지 않음');
  if (s.fakes.slice(1).some((f) => occupants(f) !== 0)) return fail('옆 시각 위조 방에 다른 사람이 있음');
  if (mods.has('accomplice') !== (s.accomplice !== null)) return fail('공범 설정이 맞지 않음');
  // 기록상 동선에서 끊기는 이음매가 정확히 하나, 범인에게만 있어야 한다 (모두 관측했다고 가정)
  const breaks = [];
  for (let who = 0; who < SUSPECTS; who++) {
    for (let t = 1; t < TIMES; t++) {
      const a = shownAt(s, who, t - 1);
      const b = shownAt(s, who, t);
      if (a !== SCENE && b !== SCENE && !canMove(s, a, b, t)) breaks.push({ who, t });
    }
  }
  if (!breaks.length || breaks.some((b) => b.who !== s.culprit)) return fail('허점이 범인에게만 있지 않음');
  // 이중 위조면 범행 시각 주변(진짜 → 위조1 → 위조2)은 자연스럽고, 허점은 위조2와 그 바깥 진짜 위치 사이에만 있어야 한다
  if (mods.has('doubleFake') && breaks.some(({ t }) => t - 1 === s.crimeTime || t === s.crimeTime)) return fail('이중 위조인데 범행 시각 바로 옆에서 허점이 보임');
  if (mods.has('lock')) {
    if (s.locks.length !== 1) return fail('잠긴 문이 하나가 아님');
    // 모든 허점이 "보통은 이어진 옆방이지만 그때 문이 잠겨 있던" 이동이어야 한다
    const viaLock = breaks.every(({ t }) => s.adj[shownAt(s, s.culprit, t - 1)].includes(shownAt(s, s.culprit, t)));
    if (!viaLock) return fail('잠긴 문 규칙인데 허점이 잠긴 문이 아님');
  } else if (s.locks.length) {
    return fail('잠긴 문이 있으면 안 됨');
  }
  if (mods.has('blackout')) {
    if (s.blackout === null) return fail('정전 시각이 없음');
    if ([s.crimeTime, ...s.fakes.map((f) => f.time)].includes(s.blackout)) return fail('정전이 위조 시각을 가림');
    // 허점 하나는 양쪽 시각이 모두 보여야 한다
    if (!breaks.some(({ t }) => t - 1 !== s.blackout && t !== s.blackout)) return fail('정전이 허점을 모두 가림');
  } else if (s.blackout !== null) {
    return fail('정전이 있으면 안 됨');
  }

  const decoyPlaces = new Set(s.presence.map((row) => row[s.decoyTime]));
  return { ok: true, minCells: 1 + alibiPlaces.size, decoyCells: 1 + decoyPlaces.size };
}

/** 한 칸을 관측한 결과 (기록 그대로라서 범인의 위조 기록이 포함된다. 정전 시각의 가림은 game.js가 한다) */
export function observe(s, place, time) {
  return {
    present: s.presence.map((_, i) => (shownAt(s, i, time) === place ? i : -1)).filter((i) => i >= 0),
    events: s.events.map((e, i) => (e.place === place && e.time === time ? i : -1)).filter((i) => i >= 0),
  };
}

function shuffle(rand, arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
