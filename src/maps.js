// 사건의 무대(지도). 두 가지 출처가 있다.
//  1. 조합 지도: data/layouts.json(방 구조) × data/themes.json(테마와 방 이름)을 무작위로 짝짓는다.
//     어느 방이 현장인지도 무작위라 같은 구조·테마여도 매번 다르다.
//  2. 직접 그린 지도: maps/*.json. 배경 이미지처럼 방 이름이 고정돼야 할 때 쓴다 (형식은 maps/README.md).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PLACES } from './puzzle.js';

const DIR = new URL('../maps/', import.meta.url).pathname;
const DATA = new URL('../data/', import.meta.url).pathname;

// 방에 icon을 안 적으면 이름에 들어 있는 낱말로 고른다. 앞에 있는 것이 먼저 맞는다.
const ICONS = [
  ['서버', '🖥️'], ['연구', '🧪'], ['실험', '🧪'], ['회의', '👥'], ['휴게', '☕'], ['카페', '☕'],
  ['서재', '📚'], ['도서', '📚'], ['서점', '📖'], ['거실', '🛋️'], ['주방', '🍳'], ['부엌', '🍳'], ['식당칸', '🍽️'], ['식당', '🍽️'],
  ['현관', '🚪'], ['로비', '🛎️'], ['계단', '🪜'], ['복도', '🚶'], ['온실', '🌿'], ['정원', '🌳'], ['마당', '🌳'],
  ['침실', '🛏️'], ['객실', '🛏️'], ['욕실', '🛁'], ['화장실', '🚻'], ['옥상', '🌙'], ['테라스', '🌙'], ['발코니', '🌙'],
  ['전시', '🖼️'], ['갤러리', '🖼️'], ['수장고', '📦'], ['창고', '📦'], ['다락', '📦'], ['사무', '💼'], ['금고', '🔐'],
  ['차고', '🚗'], ['주차', '🚗'], ['지하', '🕯️'], ['와인', '🍷'], ['라운지', '🍸'], ['무대', '🎭'], ['극장', '🎭'], ['분장', '💄'],
  ['갑판', '⚓'], ['선실', '🛏️'], ['기관', '⚙️'], ['조종', '🧭'], ['교실', '🏫'], ['강당', '🎤'], ['체육', '🏀'],
  ['매점', '🍙'], ['음악', '🎵'], ['방송', '📻'], ['스튜디오', '🎙️'], ['경비', '🔦'], ['보안', '🔦'], ['병실', '🏥'],
  ['의무', '🏥'], ['수영', '🏊'], ['헬스', '🏋️'], ['세탁', '🧺'], ['예배', '⛪'], ['기차', '🚂'],
  ['벽난로', '🔥'], ['손님', '🛏️'], ['소장', '💼'], ['관장', '💼'], ['지배인', '🗝️'], ['자료', '🗄️'], ['탕비', '☕'],
  ['복원', '🖌️'], ['기념품', '🎁'], ['하역', '🚚'], ['선장', '🧭'], ['조타', '🧭'], ['대기', '🛋️'], ['편집', '🎞️'],
  ['음향', '🎚️'], ['동아리', '🎸'], ['스위트', '🛏️'], ['금고', '🔐'], ['창고', '📦'],
  ['행랑', '🏠'], ['게스트', '🛏️'], ['안방', '🛏️'], ['뒤뜰', '🌳'], ['임원', '💼'], ['대표', '💼'], ['사장', '💼'], ['원장', '💼'],
  ['흡연', '🚬'], ['소품', '🎩'], ['간호', '🩺'], ['탈의', '👕'], ['전산', '🖥️'], ['상담', '🗣️'], ['샤워', '🚿'], ['브리핑', '📋'],
  ['통신', '📡'], ['체력', '🏋️'], ['운동', '🏋️'], ['비상구', '🚪'], ['에어록', '🚪'], ['의상', '👗'], ['매표', '🎟️'], ['마구', '🐴'],
  ['연회', '🎉'], ['조명', '💡'], ['케이터링', '🍱'], ['관객', '💺'], ['부조정', '🎛️'], ['작업', '🛠️'], ['보일러', '🔥'], ['주인', '🗝️'],
  ['사우나', '🧖'], ['레스토랑', '🍽️'], ['클럽하우스', '🏠'], ['수의', '🩺'], ['응접', '🛋️'], ['연습', '🪞'], ['녹음', '🎙️'], ['전망', '🔭'],
  ['산책', '🚶'], ['포장', '🎁'], ['선착', '⚓'], ['관제', '🗼'], ['강의', '🏫'], ['기자', '📰'], ['텐트', '⛺'], ['기계', '⚙️'],
  ['코치', '📋'], ['고해', '🕯️'],
];

// 다른 이름에 잘못 걸리기 쉬운 짧은 이름은 정확히 같을 때만 쓴다
const EXACT = { 바: '🍸', 숙소: '🛏️', 통로: '🚶', 입구: '🚪', 매장: '🛍️', 성당: '⛪', 객석: '💺', 회랑: '🏛️', 게이트: '🛫' };

export function guessIcon(name) {
  return EXACT[name] ?? ICONS.find(([word]) => name.includes(word))?.[1] ?? '🚪';
}

/** 지도 하나를 검사하고 게임에서 쓰는 형태로 바꾼다 (현장을 0번으로, 이웃 방 계산) */
export function checkMap(m, file) {
  const fail = (msg) => {
    throw new Error(`${file}: ${msg}`);
  };
  if (!m || typeof m !== 'object') fail('JSON 객체가 아님');
  if (!String(m.name ?? '').trim()) fail('name이 없음');
  if (!String(m.theme ?? '').trim()) fail('theme이 없음');
  if (!Array.isArray(m.rooms) || m.rooms.length !== PLACES) fail(`rooms는 정확히 ${PLACES}개여야 함`);
  const scenes = m.rooms.filter((r) => r.scene);
  if (scenes.length !== 1) fail('scene: true인 방(사건 현장)이 정확히 하나여야 함');
  const names = new Set();
  for (const r of m.rooms) {
    const name = String(r.name ?? '').trim();
    if (!name || name.length > 8) fail(`방 이름은 1~8자: "${name}"`);
    if (names.has(name)) fail(`방 이름이 겹침: "${name}"`);
    names.add(name);
    for (const k of ['x', 'y', 'w', 'h']) {
      if (typeof r[k] !== 'number' || r[k] < 0 || r[k] > 100) fail(`"${name}"의 ${k}는 0~100 사이 숫자여야 함`);
    }
    if (r.x + r.w > 100.5 || r.y + r.h > 100.5) fail(`"${name}"이(가) 지도 밖으로 나감`);
  }
  if (m.image !== undefined && m.image !== null && !/^\/?maps\/[\w.-]+\.(png|jpe?g|webp|svg)$/i.test(m.image)) {
    fail('image는 public/maps/ 안의 이미지 파일 경로여야 함 (예: "/maps/mansion.png")');
  }
  const aspect = Array.isArray(m.aspect) && m.aspect.length === 2 && m.aspect.every((n) => n > 0) ? m.aspect : [16, 10];
  for (const r of m.rooms) {
    if (r.icon !== undefined && (typeof r.icon !== 'string' || !r.icon.trim() || r.icon.length > 8)) fail(`"${r.name}"의 icon은 이모지 하나여야 함`);
  }
  // 게임 안에서는 0번 장소가 사건 현장이므로 현장을 맨 앞으로 옮긴다
  const rooms = [...scenes, ...m.rooms.filter((r) => !r.scene)].map((r) => ({
    name: String(r.name).trim(), x: r.x, y: r.y, w: r.w, h: r.h,
    icon: r.icon?.trim() || guessIcon(String(r.name).trim()),
  }));
  const adj = neighbors(m, rooms, fail);
  return {
    id: file.replace(/\.json$/, ''),
    name: String(m.name).trim(),
    theme: String(m.theme).trim(),
    image: m.image ? `/${m.image.replace(/^\//, '')}` : null,
    aspect,
    rooms,
    adj, // adj[p] = p번 방과 통로로 이어진 방 번호들 (30분 동안 이 방들로만 이동할 수 있다)
  };
}

// 방끼리 이웃인지: 지도 파일에 doors가 있으면 그대로 쓰고, 없으면 사각형이 맞닿은 방끼리 잇는다.
// 맞닿음은 사이 간격이 GAP 이하이고, 맞닿은 변이 OVERLAP 이상 겹치는 경우다 (퍼센트 좌표).
const GAP = 4;
const OVERLAP = 3;

function touching(a, b) {
  const xOverlap = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const yOverlap = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  const xGap = Math.max(a.x, b.x) - Math.min(a.x + a.w, b.x + b.w);
  const yGap = Math.max(a.y, b.y) - Math.min(a.y + a.h, b.y + b.h);
  return (yOverlap >= OVERLAP && xGap <= GAP) || (xOverlap >= OVERLAP && yGap <= GAP);
}

function neighbors(m, rooms, fail) {
  const adj = rooms.map(() => new Set());
  const index = new Map(rooms.map((r, i) => [r.name, i]));
  if (m.doors !== undefined) {
    if (!Array.isArray(m.doors)) fail('doors는 [["방1", "방2"], ...] 형태여야 함');
    for (const d of m.doors) {
      const [a, b] = Array.isArray(d) ? d.map((n) => index.get(String(n).trim())) : [];
      if (a === undefined || b === undefined || a === b) fail(`doors의 방 이름을 찾을 수 없음: ${JSON.stringify(d)}`);
      adj[a].add(b);
      adj[b].add(a);
    }
  } else {
    for (let a = 0; a < rooms.length; a++) {
      for (let b = a + 1; b < rooms.length; b++) {
        if (touching(rooms[a], rooms[b])) {
          adj[a].add(b);
          adj[b].add(a);
        }
      }
    }
  }
  // 모든 방이 이어져 있어야 하고, 현장 말고도 지나갈 길이 있어야 한다
  const seen = new Set([0]);
  const queue = [0];
  while (queue.length) for (const n of adj[queue.shift()]) if (!seen.has(n)) seen.add(n), queue.push(n);
  if (seen.size !== rooms.length) fail('통로로 이어지지 않은 방이 있음 (방을 맞닿게 놓거나 doors를 적으세요)');
  if (!adj[0].size) fail('사건 현장과 이어진 방이 없음');
  return adj.map((set) => [...set].sort((x, y) => x - y));
}

export function loadMaps() {
  const maps = [];
  for (const file of readdirSync(DIR).filter((f) => f.endsWith('.json')).sort()) {
    try {
      maps.push(checkMap(JSON.parse(readFileSync(join(DIR, file), 'utf8')), file));
    } catch (err) {
      console.error(`지도를 건너뜀 - ${err.message}`);
    }
  }
  return maps;
}

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const shuffled = (arr) => [...arr].sort(() => Math.random() - 0.5);

/** data/layouts.json, data/themes.json을 읽는다. 조합해서 쓸 수 없는 항목은 이유와 함께 건너뛴다. */
export function loadParts() {
  const read = (f) => JSON.parse(readFileSync(join(DATA, f), 'utf8'));
  const layouts = read('layouts.json').filter((l, i) => {
    const ok = Array.isArray(l.rooms) && l.rooms.length === PLACES;
    if (!ok) console.error(`방 구조를 건너뜀 - layouts.json ${i + 1}번째(${l.name ?? ''}): rooms는 정확히 ${PLACES}개여야 함`);
    return ok;
  });
  const themes = read('themes.json').filter((t, i) => {
    const ok = t.name && t.theme && t.scenes?.length && t.rooms?.length >= PLACES - 1;
    if (!ok) console.error(`테마를 건너뜀 - themes.json ${i + 1}번째(${t.name ?? ''}): name, theme, scenes 1개 이상, rooms ${PLACES - 1}개 이상이 필요함`);
    return ok;
  });
  // 모든 구조가 조합 검사를 통과하는지 미리 한 번씩 확인한다
  for (const l of layouts) composeMap(l, themes[0]);
  return { layouts, themes };
}

/** 방 구조와 테마를 짝지어 지도 하나를 만든다. 현장 위치와 방 이름 배치는 무작위다. */
export function composeMap(layout, theme) {
  const sceneSlot = Math.floor(Math.random() * layout.rooms.length);
  const others = shuffled(theme.rooms.filter((n) => !theme.scenes.includes(n))).slice(0, PLACES - 1);
  const names = [];
  let k = 0;
  for (let i = 0; i < layout.rooms.length; i++) names.push(i === sceneSlot ? pick(theme.scenes) : others[k++]);
  return checkMap({
    name: theme.name,
    theme: theme.theme,
    aspect: layout.aspect,
    rooms: layout.rooms.map((r, i) => ({ ...r, name: names[i], scene: i === sceneSlot, icon: theme.icons?.[names[i]] })),
    ...(layout.doors && { doors: layout.doors.map(([a, b]) => [names[a], names[b]]) }),
  }, `${theme.name} × ${layout.name}`);
}
