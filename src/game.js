// 게임 규칙. 소켓과 타이머는 server.js가 맡고, 여기는 상태를 바꾸는 규칙만 둔다.
import { observe, PLACES, TIMES, SUSPECTS, SCENE } from './puzzle.js';

export const LOOPS = Number(process.env.LOOPS) || 7;
export const MAX_PLAYERS = 6;

/**
 * 인원별 구성. 탐정 팀 전체 관측 수를 고정해서 사람이 적어도 불리하지 않게 한다.
 * 4명 이상이면 교수(방해자) 한 명이 섞이고, 그만큼 탐정 팀 관측을 늘린다.
 */
export function setupFor(n) {
  const hasProfessor = n >= 4;
  return {
    hasProfessor,
    teamTotal: n >= 5 ? 5 : 4,
    forge: n >= 5 ? 2 : 1,
    noise: hasProfessor ? 1 : 0,
  };
}

export const cellKey = (place, time) => `${place}:${time}`;

export function createGame(caseData, players) {
  const setup = setupFor(players.length);
  const professor = setup.hasProfessor ? players[Math.floor(Math.random() * players.length)] : null;
  return {
    case: caseData,
    roster: players.map((p) => ({ key: p.key, name: p.name })), // 시작할 때 인원으로 고정
    professorKey: professor?.key ?? null,
    teamTotal: setup.teamTotal,
    charges: { forge: setup.forge, noise: setup.noise },
    loop: 1,
    /** @type {Map<string, {key: string, place: number, time: number, forge: null | {present: number[], hideEvents: boolean}}>} */
    placements: new Map(),
    noiseCell: null,
    observations: [],
    proposedLoop: 0, // 이 루프에 이미 고발 투표를 열었는지 (루프당 한 번)
    vote: null,
    accusation: null,
    unmask: null,
    log: { forges: [], noise: [], votes: [] },
  };
}

export const isProfessor = (game, key) => game.professorKey === key;
const detectives = (game) => game.roster.filter((p) => p.key !== game.professorKey);

/** 이번 루프에 이 플레이어가 놓을 수 있는 관측자 수. 남는 몫은 루프마다 돌아가며 받는다. */
export function quota(game, key) {
  if (isProfessor(game, key)) return 1;
  const dets = detectives(game);
  const i = dets.findIndex((p) => p.key === key);
  if (i < 0) return 0;
  const base = Math.floor(game.teamTotal / dets.length);
  const extra = game.teamTotal % dets.length;
  const turn = (((i - (game.loop - 1)) % dets.length) + dets.length) % dets.length;
  return base + (turn < extra ? 1 : 0);
}

export const placedBy = (game, key) => [...game.placements.values()].filter((p) => p.key === key);

const validCell = (place, time) =>
  Number.isInteger(place) && Number.isInteger(time) && place > SCENE && place < PLACES && time >= 0 && time < TIMES;

/** 관측자를 놓는다. 안 되면 이유를 돌려준다. */
export function place(game, key, placeIdx, time) {
  if (!validCell(placeIdx, time)) return '그 칸은 관측할 수 없어요.';
  const k = cellKey(placeIdx, time);
  if (game.placements.has(k)) return '이미 다른 관측자가 있는 칸이에요.';
  if (placedBy(game, key).length >= quota(game, key)) return '이번 루프에 놓을 관측자를 다 썼어요.';
  game.placements.set(k, { key, place: placeIdx, time, forge: null });
  return null;
}

export function unplace(game, key, placeIdx, time) {
  const k = cellKey(placeIdx, time);
  if (game.placements.get(k)?.key === key) game.placements.delete(k);
}

/** 교수 전용: 자기 관측자가 놓인 칸의 결과를 가짜로 바꾼다 (forge가 null이면 취소) */
export function setForge(game, key, placeIdx, time, forge) {
  if (!isProfessor(game, key)) return '권한이 없어요.';
  const p = game.placements.get(cellKey(placeIdx, time));
  if (!p || p.key !== key) return '내 관측자가 놓인 칸만 변조할 수 있어요.';
  if (!forge) {
    p.forge = null;
    return null;
  }
  const planned = placedBy(game, key).filter((x) => x.forge && x !== p).length;
  if (planned >= game.charges.forge) return '변조 기회를 다 썼어요.';
  const present = [...new Set((forge.present ?? []).map(Number))].filter((s) => Number.isInteger(s) && s >= 0 && s < SUSPECTS);
  p.forge = { present, hideEvents: !!forge.hideEvents };
  return null;
}

/** 교수 전용: 이번 루프 동안 한 칸을 관측 불가로 만든다 (place가 null이면 취소) */
export function setNoise(game, key, placeIdx, time) {
  if (!isProfessor(game, key)) return '권한이 없어요.';
  if (placeIdx === null) {
    game.noiseCell = null;
    return null;
  }
  if (game.charges.noise <= 0) return '노이즈 기회를 다 썼어요.';
  if (!validCell(placeIdx, time)) return '그 칸에는 노이즈를 걸 수 없어요.';
  game.noiseCell = cellKey(placeIdx, time);
  return null;
}

/** 배치를 확정하고 결과를 공개한다. 다음 루프로 넘어간다. */
export function revealLoop(game) {
  const s = game.case.structure;
  for (const p of game.placements.values()) {
    const k = cellKey(p.place, p.time);
    const base = { loop: game.loop, place: p.place, time: p.time, by: p.key };
    if (game.noiseCell === k) {
      game.observations.push({ ...base, noise: true, present: [], events: [], forged: false });
      continue;
    }
    const truth = observe(s, p.place, p.time);
    // 정전 시각에는 누가 있었는지 대신 사람 수만 남는다
    const dark = s.blackout === p.time;
    const shown = (present) => (dark ? { present: [], count: present.length, blackout: true } : { present });
    if (p.forge) {
      game.observations.push({ ...base, noise: false, ...shown(p.forge.present), events: p.forge.hideEvents ? [] : truth.events, forged: true });
      game.charges.forge -= 1;
      game.log.forges.push({ loop: game.loop, place: p.place, time: p.time, truePresent: truth.present, shownPresent: p.forge.present, hidEvents: p.forge.hideEvents && truth.events.length > 0 });
    } else {
      game.observations.push({ ...base, noise: false, ...shown(truth.present), events: truth.events, forged: false });
    }
  }
  if (game.noiseCell) {
    const [place, time] = game.noiseCell.split(':').map(Number);
    const victim = game.placements.get(game.noiseCell);
    game.log.noise.push({ loop: game.loop, place, time, blocked: victim && !isProfessor(game, victim.key) ? victim.key : null });
    game.charges.noise -= 1;
  }
  game.placements.clear();
  game.noiseCell = null;
  game.loop += 1;
}

export const loopsDone = (game) => game.loop - 1;
export const finished = (game) => game.loop > LOOPS;

// ---------- 투표 ----------

/**
 * kind: 'accuse' 루프 중 고발 투표 (과반이 같은 용의자를 골라야 고발, 보류 가능)
 *       'final'  마지막 재생 뒤 의무 고발 (최다 득표, 동률이면 고발 실패)
 *       'unmask' 범인을 맞힌 뒤 교수 지목 (최다 득표, 동률이면 놓침)
 */
export function openVote(game, kind, proposer, deadline) {
  game.vote = { kind, proposer, deadline, choices: new Map() };
  if (kind === 'accuse') game.proposedLoop = game.loop;
}

/**
 * 표를 넣는다. 교수 지목은 플레이어 키,
 * 고발은 {suspect, method, motive}: suspect는 용의자 번호(고발 투표에서는 'pass'도 가능),
 * method와 motive는 선택지 문자열이나 null(고르지 않음)
 */
export function castVote(game, key, choice) {
  const v = game.vote;
  if (!v || !game.roster.some((p) => p.key === key)) return;
  if (v.kind === 'unmask') {
    if (!game.roster.some((p) => p.key === choice) || choice === key) return;
    v.choices.set(key, choice);
    return;
  }
  const { suspect, method = null, motive = null } = choice ?? {};
  const validSuspect = suspect === 'pass' ? v.kind === 'accuse' : Number.isInteger(suspect) && suspect >= 0 && suspect < SUSPECTS;
  if (!validSuspect) return;
  const { methods, motives } = game.case.options;
  v.choices.set(key, {
    suspect,
    method: methods.includes(method) ? method : null,
    motive: motives.includes(motive) ? motive : null,
  });
}

// 가장 많이 나온 값. 고르지 않은 표(null, 'pass')는 세지 않는다
function tally(values) {
  const counts = new Map();
  for (const c of values) if (c !== null && c !== 'pass') counts.set(c, (counts.get(c) ?? 0) + 1);
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return { top: sorted[0] ?? null, tied: sorted.length > 1 && sorted[0][1] === sorted[1][1] };
}

const plurality = (values) => {
  const { top, tied } = tally(values);
  return top && !tied ? top[0] : null;
};

/**
 * 투표를 마감한다. voters: 지금 접속해 있는 플레이어 수 (과반 기준)
 * @returns {{kind: string, decided: any}} decided: 고발할 용의자 / 지목한 플레이어 키 / null
 */
export function closeVote(game, voters) {
  const v = game.vote;
  game.vote = null;
  const votes = [...v.choices.values()];
  const suspects = v.kind === 'unmask' ? votes : votes.map((c) => c.suspect);
  const { top, tied } = tally(suspects);
  let decided = null;
  if (v.kind === 'accuse') {
    if (top && top[1] > voters / 2) decided = top[0];
  } else if (top && !tied) {
    decided = top[0];
  }
  game.log.votes.push({ kind: v.kind, loop: game.loop, choices: Object.fromEntries(v.choices), decided });
  if (v.kind === 'unmask') {
    game.unmask = { target: decided, caught: decided !== null && decided === game.professorKey };
  } else if (decided !== null) {
    // 수단과 동기는 그 용의자를 고른 표들 중에서 가장 많이 나온 것 (동률이면 고르지 않은 것으로)
    const backers = votes.filter((c) => c.suspect === decided);
    const method = plurality(backers.map((c) => c.method));
    const motive = plurality(backers.map((c) => c.motive));
    const { answer } = game.case;
    game.accusation = {
      suspect: decided,
      correct: decided === game.case.structure.culprit,
      loopsDone: loopsDone(game),
      method,
      motive,
      methodCorrect: method === answer.method,
      motiveCorrect: motive === answer.motive,
    };
  }
  return { kind: v.kind, decided };
}

/** 결과 판정 */
export function outcome(game) {
  const a = game.accusation;
  const hasProf = !!game.professorKey;
  if (!a) return { result: 'timeout', title: '시간 초과', detectivesWin: false, score: 0 };
  if (!a.correct) return { result: 'wrong', title: '오인 고발', detectivesWin: false, score: 0 };
  const caught = hasProf && game.unmask?.caught;
  // 범인을 맞혔을 때만 수단·동기 보너스를 준다
  const levelBonus = ((game.case.structure.level ?? 1) - 1) * 40;
  const score = 100 + (LOOPS - a.loopsDone) * 20 + (caught ? 50 : 0) + (a.methodCorrect ? 30 : 0) + (a.motiveCorrect ? 30 : 0) + levelBonus;
  if (!hasProf) return { result: 'solved', title: '사건 해결', detectivesWin: true, score };
  return caught
    ? { result: 'perfect', title: '완전 해결', detectivesWin: true, score }
    : { result: 'escaped', title: '해결, 그러나 교수는 도주', detectivesWin: true, score };
}
