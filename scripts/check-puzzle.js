// 사건 생성기와 게임 규칙을 서버 없이 점검한다: npm run check
import assert from 'node:assert/strict';
import { makeStructure, validate, observe, canMove, LEVELS, SCENE, SUSPECTS, TIMES, PLACES } from '../src/puzzle.js';
import { createGame, place, setForge, setNoise, revealLoop, openVote, castVote, closeVote, outcome, quota, LOOPS } from '../src/game.js';
import { buildReport } from '../src/report.js';
import { takeCase } from '../src/cases.js';
import { loadParts, composeMap } from '../src/maps.js';

const { layouts, themes } = loadParts();

// 1. 난이도마다 구조를 만들어 모두 규칙대로 풀리는지
const minCells = [];
for (const { level, mods } of LEVELS) {
  for (let i = 0; i < 400; i++) {
    const map = composeMap(layouts[i % layouts.length], themes[i % themes.length]);
    const s = makeStructure(map.adj, level);
    const v = validate(s);
    assert.ok(v.ok, v.reason);
    // 풀이 경로를 직접 따라가 본다: 모든 칸을 봤을 때 30분 만에 갈 수 없는 이동이 찍힌 사람은 범인뿐
    const where = (who, t) => { for (let p = 1; p < PLACES; p++) if (observe(s, p, t).present.includes(who)) return p; return SCENE; };
    const visible = (t) => t !== s.blackout; // 정전 시각은 누가 있었는지 모른다
    const liars = new Set();
    for (let who = 0; who < SUSPECTS; who++) {
      for (let t = 1; t < TIMES; t++) {
        if (!visible(t - 1) || !visible(t)) continue;
        const a = where(who, t - 1);
        const b = where(who, t);
        if (a !== SCENE && b !== SCENE && !canMove(s, a, b, t)) liars.add(who);
      }
    }
    assert.deepEqual([...liars], [s.culprit], `난이도 ${level}: 동선이 끊기는 사람은 범인뿐`);
    const ct = s.events.find((e) => e.kind === 'time').time;
    const seenAt = (t) => new Set([...Array(PLACES - 1).keys()].flatMap((k) => observe(s, k + 1, t).present));
    assert.equal(seenAt(ct).size, SUSPECTS, '범행 시각에도 다섯 명이 모두 찍혀야 함');
    // 공범 단계면 범행 시각 위조 방에 범인과 공범 둘, 아니면 범인 혼자
    assert.equal(observe(s, s.fake.place, ct).present.length, mods.includes('accomplice') ? 2 : 1);
    if (mods.includes('lock')) assert.equal(s.locks.length, 1);
    if (mods.includes('doubleFake')) assert.equal(s.fakes.length, 2);
    if (mods.includes('blackout')) assert.ok(s.blackout !== null && s.blackout !== ct);
    minCells.push(v.minCells);
  }
  console.log(`난이도 ${level} [${mods.join(', ') || '기본'}]: 구조 400개 검증 통과`);
}

// 2. 인원별 관측 수 분배
const fakePlayers = (n) => Array.from({ length: n }, (_, i) => ({ key: `k${i}`, name: `P${i}` }));
const c = await takeCase();
for (let n = 1; n <= 6; n++) {
  const g = createGame(c, fakePlayers(n));
  const per = [];
  for (let loop = 1; loop <= LOOPS; loop++) {
    g.loop = loop;
    const det = g.roster.filter((p) => p.key !== g.professorKey).reduce((sum, p) => sum + quota(g, p.key), 0);
    per.push(det);
  }
  console.log(`${n}명: 교수 ${g.professorKey ? '있음' : '없음'}, 탐정 팀 루프당 관측 ${[...new Set(per)].join('/')}개`);
}

// 3. 4인 판 한 판 진행: 교수 변조·노이즈, 고발, 교수 지목, 리포트
const g = createGame(c, fakePlayers(4));
const s = c.structure;
const prof = g.professorKey;
const dets = g.roster.filter((p) => p.key !== prof);
const ct = s.crimeTime;
// 교수: 범행 시각 알리바이 칸 하나를 차지하고 변조, 노이즈 한 칸
const someAlibi = s.presence.findIndex((row, i) => i !== s.culprit);
const alibiPlace = s.presence[someAlibi][ct];
assert.equal(place(g, prof, alibiPlace, ct), null);
assert.equal(setForge(g, prof, alibiPlace, ct, { present: [], hideEvents: true }), null);
assert.equal(setNoise(g, prof, 1, 0), null);
assert.ok(place(g, prof, 2, 0), '교수는 관측자 1개만');
assert.ok(place(g, dets[0].key, SCENE, ct), '현장은 관측 불가');
assert.ok(place(g, dets[0].key, alibiPlace, ct), '같은 칸 중복 불가');
let placed = 0;
for (let p = 1; p < PLACES && placed < 2; p++) if (!place(g, dets[0].key, p, Math.min(ct + 1, TIMES - 1))) placed++;
revealLoop(g);
const forged = g.observations.find((o) => o.forged);
assert.deepEqual(forged.present, []);
assert.equal(g.charges.forge, 0);
// 탐정이 다음 루프에 같은 칸을 다시 보면 진짜가 나온다
assert.equal(place(g, dets[1].key, alibiPlace, ct), null);
revealLoop(g);
const recheck = g.observations.at(-1);
assert.ok(recheck.present.includes(someAlibi));

openVote(g, 'accuse', dets[0].key, null);
for (const p of g.roster) {
  const choice = p.key === prof
    ? { suspect: (s.culprit + 1) % SUSPECTS }
    : { suspect: s.culprit, method: c.answer.method, motive: c.answer.motive };
  castVote(g, p.key, choice);
}
closeVote(g, 4);
assert.equal(g.accusation.correct, true);
assert.equal(g.accusation.methodCorrect, true);
assert.equal(g.accusation.motiveCorrect, true);
// 수단 선택지에는 진짜 수단과 헛증거 물건이, 동기 선택지에는 4개가 들어 있다
assert.ok(c.options.methods.includes(c.answer.method) && c.options.methods.length >= 3);
assert.ok(c.options.motives.includes(c.answer.motive) && c.options.motives.length === 4);
openVote(g, 'unmask', null, null);
for (const p of dets) castVote(g, p.key, prof);
castVote(g, prof, dets[0].key);
closeVote(g, 4);
assert.equal(g.unmask.caught, true);
const o = outcome(g);
assert.equal(o.result, 'perfect');
const rep = buildReport(g);
console.log(`4인 판 진행 통과: ${o.title}, 점수 ${o.score}`);
console.log('--- 결과 리포트 ---');
for (const k of ['headline', 'story', 'route', 'investigation', 'professor']) console.log(`${k}: ${rep[k]}`);
for (const n of rep.playerNotes) console.log(`  ${n.name}: ${n.note}`);
