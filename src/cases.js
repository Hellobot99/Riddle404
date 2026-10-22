import { readFileSync } from 'node:fs';
import { makeStructure, validate, SUSPECTS, LEVELS } from './puzzle.js';
import { writeCase, mockMode } from './ai.js';
import { loadMaps, loadParts, composeMap } from './maps.js';
import { ITEMS, MOTIVES, itemEvidence, motiveNote } from './fallback.js';

// 무대와 이름은 서버가 미리 준비한 데이터에서 무작위로 뽑고, AI는 거기에 이야기와 문장만 입힌다.
//  - 무대: data/layouts.json × data/themes.json 조합, 또는 maps/*.json의 직접 그린 지도
//  - 이름: data/names.json의 성과 이름 조합 (사건 안에서 성이 겹치지 않게, 최근 이름은 피해서)
const FIXED = loadMaps();
const { layouts: LAYOUTS, themes: THEMES } = loadParts();
const NAMES = JSON.parse(readFileSync(new URL('../data/names.json', import.meta.url), 'utf8'));
console.log(`무대: 방 구조 ${LAYOUTS.length}개 × 테마 ${THEMES.length}개${FIXED.length ? ` + 직접 그린 지도 ${FIXED.length}개` : ''}, 이름: 성 ${NAMES.surnames.length}개 × 이름 ${NAMES.given.length}개`);

const POOL_SIZE = Number(process.env.CASE_POOL) || 3;

// AI를 못 쓸 때 쓰는 기본 인물 설정. 이름은 따로 뽑아서 붙인다.
const FALLBACK_ROLES = [
  { role: '동업자', profile: '사업 지분을 두고 피해자와 몇 달째 다투고 있었다.' },
  { role: '직원', profile: '사건 직전 해고 통보를 받았다.' },
  { role: '조카', profile: '유산 이야기가 나올 때마다 표정이 굳었다.' },
  { role: '오랜 친구', profile: '피해자에게 큰돈을 빌리고 갚지 못했다.' },
  { role: '사진작가', profile: '초대받지 않았는데 그날 밤 나타났다.' },
  { role: '비서', profile: '피해자의 일정과 비밀번호를 모두 알고 있다.' },
  { role: '경쟁자', profile: '피해자 때문에 큰 계약을 놓쳤다.' },
  { role: '경비원', profile: '근무 시간에 자리를 비운 적이 많다.' },
  { role: '전 연인', profile: '헤어진 뒤에도 피해자 주변을 맴돌았다.' },
  { role: '전 직원', profile: '그만둔 뒤에도 출입증을 반납하지 않았다.' },
];
// 현장 쪽 소리. 진짜 범행 시각과 가짜 소리에 똑같이 쓰여서 문장만으로는 구별되지 않는다
const SOUNDS = [
  (scene) => `${scene} 쪽에서 둔탁한 소리와 짧은 비명이 들렸다.`,
  (scene) => `${scene} 쪽에서 무언가 무겁게 쓰러지는 소리가 났다.`,
  (scene) => `${scene} 쪽에서 유리가 깨지는 소리가 울렸다.`,
];
const FLAVOR = ['전등이 잠깐 깜빡였다.', '창밖으로 차 한 대가 지나갔다.', '어디선가 시계 종이 울렸다.', '빈 잔 하나가 테이블에 남아 있었다.', '바닥이 젖어 있었다.', '라디오에서 일기 예보가 흘러나왔다.'];

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const shuffled = (arr) => [...arr].sort(() => Math.random() - 0.5);

// 최근 사건에 나온 이름은 다시 뽑지 않는다
const recentNames = [];
const RECENT_NAMES = 60;

/** 피해자 1명 + 용의자 5명의 이름. 성이 서로 겹치지 않는다. */
function pickNames() {
  const surnames = shuffled(NAMES.surnames).slice(0, SUSPECTS + 1);
  const names = surnames.map((sur) => {
    let full;
    for (let i = 0; i < 20; i++) {
      full = sur + pick(NAMES.given);
      if (!recentNames.includes(full)) break;
    }
    return full;
  });
  recentNames.push(...names);
  recentNames.splice(0, Math.max(0, recentNames.length - RECENT_NAMES));
  return { victim: names[0], suspects: names.slice(1) };
}

function fallbackFlavor(s, map, names) {
  const scene = map.rooms[0].name;
  const suspects = shuffled(FALLBACK_ROLES).slice(0, SUSPECTS).map((r, i) => ({ name: names.suspects[i], ...r }));
  const victim = names.victim;
  const motives = shuffled(MOTIVES).slice(0, 4);
  const items = shuffled(ITEMS);
  const fl = shuffled(FLAVOR);
  const sounds = shuffled(SOUNDS); // 진짜와 가짜 소리가 같은 문장으로 겹치지 않게
  const eventItems = s.events.map((e) => (e.kind === 'suspicious' ? items.pop() : ''));
  const method = eventItems[s.events.findIndex((e) => e.kind === 'suspicious' && e.who === s.culprit)];
  return {
    title: `${scene}의 404`,
    intro: `${map.theme}. 밤이 끝나 갈 무렵 ${victim}이(가) ${scene}에서 쓰러진 채 발견됐다. 그날 밤 ${scene}의 기록만 통째로 지워져 있다.`,
    victim: `${victim} (이곳의 주인)`,
    suspects,
    motive: `${motives[0].text}.`,
    method: `${scene}에서 ${method}을(를) 써서 피해자를 쓰러뜨렸다.`,
    motives,
    eventItems,
    eventTexts: s.events.map((e, i) => {
      if (e.kind === 'time' || e.kind === 'decoy') return (sounds.pop() ?? SOUNDS[0])(scene);
      if (e.kind === 'suspicious') return itemEvidence(suspects[e.who].name, eventItems[i]);
      if (e.kind === 'motive') return motiveNote(motives[0].key);
      return fl.pop() ?? FLAVOR[0];
    }),
  };
}

/** 고발할 때 고르는 수단·동기 선택지와 정답. 순서는 섞어서 정답 위치가 드러나지 않게 한다 */
function choicesFor(s, flavor) {
  const evidence = s.events.map((e, i) => ({ e, item: flavor.eventItems[i] })).filter(({ e }) => e.kind === 'suspicious');
  const method = evidence.find(({ e }) => e.who === s.culprit).item;
  // 동기 선택지에는 핵심어를 앞에 붙인다. 동기 단서 기록에 나온 낱말과 바로 이어 볼 수 있게
  const label = (m) => `${String(m.key).trim()} — ${String(m.text).trim()}`;
  const motive = label(flavor.motives[0]);
  return {
    options: { methods: shuffled(evidence.map((x) => x.item)), motives: shuffled(flavor.motives.map(label)) },
    answer: { method, motive },
  };
}

let nextId = 1;
let lastStage = null;

// 무대 고르기: 직접 그린 지도와 조합 지도를 섞는다. 바로 앞 사건과 같은 테마는 피한다.
function pickStage() {
  const fixedShare = FIXED.length / (FIXED.length + LAYOUTS.length);
  if (FIXED.length && Math.random() < fixedShare) {
    const options = FIXED.length > 1 ? FIXED.filter((m) => m.name !== lastStage) : FIXED;
    const map = pick(options);
    lastStage = map.name;
    return map;
  }
  const themes = THEMES.length > 1 ? THEMES.filter((t) => t.name !== lastStage) : THEMES;
  const theme = pick(themes);
  lastStage = theme.name;
  return composeMap(pick(LAYOUTS), theme);
}

async function makeCase(level) {
  // 드물게 어떤 무대(구조 × 현장 위치)에서 난이도 규칙을 맞추지 못하면 다른 무대로 다시 뽑는다
  let map;
  let structure;
  for (let i = 0; ; i++) {
    map = pickStage();
    try {
      structure = makeStructure(map.adj, level);
      break;
    } catch (err) {
      if (i >= 20) throw err;
    }
  }
  const places = map.rooms.map((r) => r.name);
  const names = pickNames();
  let flavor = null;
  if (!mockMode) {
    try {
      flavor = await writeCase(structure, map.theme, places, names);
      if (!flavor) console.warn('AI 사건 문장이 형식에 맞지 않아 기본 문장으로 대체');
    } catch (err) {
      console.error('사건 문장 생성 실패, 기본 문장으로 대체:', err.message ?? err);
    }
  }
  const finalFlavor = { ...(flavor ?? fallbackFlavor(structure, map, names)), places };
  return {
    id: nextId++,
    structure,
    map,
    flavor: finalFlavor,
    ...choicesFor(structure, finalFlavor),
    aiWritten: !!flavor,
    minCells: validate(structure).minCells,
  };
}

// 난이도마다 따로 쌓아 둔다. 1단계는 POOL_SIZE개, 나머지는 하나씩 (AI 호출을 아끼려고)
const pools = new Map(LEVELS.map(({ level }) => [level, []]));
const want = (level) => (level === 1 ? POOL_SIZE : 1);
let refilling = null;

function refill() {
  if (refilling) return refilling;
  refilling = (async () => {
    try {
      for (const { level } of LEVELS) {
        while (pools.get(level).length < want(level)) pools.get(level).push(await makeCase(level));
      }
    } finally {
      refilling = null;
    }
  })();
  return refilling;
}

/** 그 난이도의 사건을 하나 꺼낸다. 풀이 비었으면 바로 만들고, 꺼낸 뒤엔 뒤에서 다시 채운다. */
export async function takeCase(level = 1) {
  const pool = pools.get(level) ?? pools.get(1);
  const c = pool.shift() ?? (await makeCase(level));
  refill().catch((err) => console.error('사건 풀 채우기 실패:', err));
  return c;
}

/** 서버 시작 시 미리 채워 둔다 */
export function warmUp() {
  return refill().catch((err) => console.error('사건 풀 채우기 실패:', err));
}
