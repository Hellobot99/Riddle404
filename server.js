import 'dotenv/config';
import express from 'express';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { mockMode } from './src/ai.js';
import { takeCase, warmUp } from './src/cases.js';
import { timeLabel, TIMES, LEVELS } from './src/puzzle.js';
import {
  LOOPS, MAX_PLAYERS, setupFor, createGame, quota, placedBy, place, unplace, setForge, setNoise,
  revealLoop, finished, openVote, castVote, closeVote, outcome, isProfessor,
} from './src/game.js';
import { buildReport } from './src/report.js';

const env = (name, fallback) => Number(process.env[name]) || fallback;

const PORT = env('PORT', 3000);
const BRIEF_SECONDS = env('BRIEF_SECONDS', 60);
const PLAN_SECONDS = env('PLAN_SECONDS', 90);
const VOTE_SECONDS = env('VOTE_SECONDS', 30);
const REVIEW_SECONDS = env('REVIEW_SECONDS', 60); // 마지막 재생 뒤, 최종 고발 전에 기록을 정리하는 시간
const ROOM_TTL_MS = 10 * 60 * 1000;
const MAX_CHAT = 200;
const CHAT_COOLDOWN_MS = 1200;

const MAX_ROOMS = env('MAX_ROOMS', 200);
const CREATE_LIMIT = env('CREATE_LIMIT', 5);
const CREATE_WINDOW_MS = 10 * 60 * 1000;
const TRUST_PROXY = process.env.TRUST_PROXY === '1';

const app = express();
app.use(express.static('public'));
app.get('/healthz', (_req, res) => res.json({ ok: true, rooms: rooms.size }));
const httpServer = createServer(app);
const io = new Server(httpServer, { maxHttpBufferSize: 16 * 1024 });

/** @type {Map<string, any>} */
const rooms = new Map();
/** @type {Map<string, number[]>} IP별 최근 방 생성 시각 */
const createLog = new Map();

function allowCreate(ip) {
  const now = Date.now();
  const recent = (createLog.get(ip) ?? []).filter((t) => now - t < CREATE_WINDOW_MS);
  if (recent.length >= CREATE_LIMIT) {
    createLog.set(ip, recent);
    return false;
  }
  recent.push(now);
  createLog.set(ip, recent);
  return true;
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, times] of createLog) {
    if (times.every((t) => now - t >= CREATE_WINDOW_MS)) createLog.delete(ip);
  }
}, CREATE_WINDOW_MS).unref();

function clientIp(socket) {
  const forwarded = socket.handshake.headers['x-forwarded-for'];
  if (TRUST_PROXY && forwarded) return String(forwarded).split(',')[0].trim();
  return socket.handshake.address;
}

function newCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function newRoom(code) {
  return { code, players: [], hostKey: null, phase: 'waiting', game: null, chat: [], error: null, report: null, deadline: null, matchId: 0, level: 1 };
}

function deleteRoom(room) {
  clearTimeout(room.timer);
  clearTimeout(room.cleanup);
  rooms.delete(room.code);
}

// 방장이 나가 있으면 접속해 있는 첫 번째 사람이 방장 역할을 한다
function hostOf(room) {
  const host = room.players.find((p) => p.key === room.hostKey && p.socketId);
  return host ?? room.players.find((p) => p.socketId) ?? null;
}

const connected = (room) => room.players.filter((p) => p.socketId && room.game?.roster.some((r) => r.key === p.key));

// ---------- 화면 상태 ----------

function viewFor(room, player) {
  const g = room.game;
  const prof = !!g && isProfessor(g, player.key);
  const host = hostOf(room);
  const view = {
    code: room.code,
    phase: room.phase,
    serverNow: Date.now(),
    deadline: room.deadline,
    mockMode,
    error: room.error,
    loops: LOOPS,
    maxPlayers: MAX_PLAYERS,
    setup: setupFor(room.players.length),
    level: room.level,
    levels: LEVELS,
    me: { name: player.name, isHost: host === player, role: g ? (prof ? 'professor' : 'detective') : null, ready: player.ready },
    players: room.players.map((p) => ({
      name: p.name,
      connected: !!p.socketId,
      ready: p.ready,
      isHost: host === p,
      isMe: p === player,
      quota: g ? quota(g, p.key) : 0,
      placed: g ? placedBy(g, p.key).length : 0,
    })),
    chat: room.chat.slice(-100),
  };
  if (!g) return view;

  const s = g.case.structure;
  const f = g.case.flavor;
  const nameOf = (key) => g.roster.find((p) => p.key === key)?.name ?? '(나간 플레이어)';
  const ended = room.phase === 'result';

  Object.assign(view, {
    case: {
      title: f.title,
      intro: f.intro,
      victim: f.victim,
      places: f.places,
      suspects: f.suspects,
      times: Array.from({ length: TIMES }, (_, t) => timeLabel(t)),
      window: s.window,
      aiWritten: g.case.aiWritten,
      options: g.case.options, // 고발할 때 고르는 수단·동기 선택지 (정답은 결과 화면에서만)
      // 난이도 규칙 중 공개되는 것: 잠긴 문과 정전 시각 (공범과 위조 칸은 결과 화면에서만)
      level: s.level,
      locks: s.locks,
      blackout: s.blackout,
      // 방 순서는 places와 같다 (0번이 사건 현장)
      map: { name: g.case.map.name, image: g.case.map.image, aspect: g.case.map.aspect, rooms: g.case.map.rooms.map(({ x, y, w, h, icon }) => ({ x, y, w, h, icon })), adj: g.case.map.adj },
    },
    loop: Math.min(g.loop, LOOPS),
    hasProfessor: !!g.professorKey,
    roster: g.roster.map((p) => p.name),
    placements: [...g.placements.values()].map((p) => ({
      place: p.place,
      time: p.time,
      name: nameOf(p.key),
      isMe: p.key === player.key,
      ...(prof && p.key === player.key && { forge: p.forge }),
    })),
    observations: g.observations.map((o) => ({
      loop: o.loop,
      place: o.place,
      time: o.time,
      by: nameOf(o.by),
      noise: o.noise,
      present: o.present,
      ...(o.blackout && { blackout: true, count: o.count }),
      // clue: 현장 쪽 소리 기록인지. 진짜(time)와 가짜(decoy)를 구별하지 않고 똑같이 보낸다
      // tag: 물건 증거(item)와 동기 단서(motive)는 기록 패널에서 표시해 준다
      events: o.events.map((i) => ({
        text: f.eventTexts[i],
        clue: s.events[i].kind === 'time' || s.events[i].kind === 'decoy',
        tag: { suspicious: 'item', motive: 'motive' }[s.events[i].kind] ?? null,
      })),
      ...((prof || ended) && { forged: o.forged }),
    })),
    votes: g.log.votes.map((v) => ({ kind: v.kind, loop: v.loop, decided: v.kind === 'unmask' ? null : v.decided })),
    accusation: g.accusation,
    vote: g.vote && {
      kind: g.vote.kind,
      proposer: g.vote.proposer ? nameOf(g.vote.proposer) : null,
      voted: [...g.vote.choices.keys()].map(nameOf),
      mine: g.vote.kind === 'unmask'
        ? g.roster.findIndex((p) => p.key === g.vote.choices.get(player.key))
        : g.vote.choices.get(player.key) ?? null,
    },
    canPropose: room.phase === 'plan' && g.proposedLoop !== g.loop,
  });

  if (prof) {
    view.secret = {
      culprit: s.culprit,
      crimeTime: s.crimeTime,
      presence: s.presence,
      fake: s.fake, // 범인의 가짜 알리바이 (기록상으로는 이 방에 찍힌다)
      charges: g.charges,
      noiseCell: g.noiseCell,
    };
  }

  if (ended) {
    view.result = {
      outcome: room.phase === 'result' ? outcome(g) : null,
      culprit: s.culprit,
      crimeTime: s.crimeTime,
      presence: s.presence,
      fake: s.fake,
      fakes: s.fakes,
      accomplice: s.accomplice,
      decoyTime: s.decoyTime,
      answer: g.case.answer,
      motive: f.motive,
      method: f.method,
      professor: g.professorKey ? nameOf(g.professorKey) : null,
      unmask: g.unmask && { target: g.unmask.target ? nameOf(g.unmask.target) : null, caught: g.unmask.caught },
      report: room.report,
    };
  }
  return view;
}

function broadcast(room) {
  for (const p of room.players) {
    if (p.socketId) io.to(p.socketId).emit('state', viewFor(room, p));
  }
}

function system(room, text) {
  room.chat.push({ system: true, text, at: Date.now() });
  if (room.chat.length > 200) room.chat.shift();
}

// ---------- 진행 ----------

function armTimer(room, ms, fn) {
  clearTimeout(room.timer);
  room.deadline = Date.now() + ms;
  const matchId = room.matchId;
  room.timer = setTimeout(() => {
    if (rooms.has(room.code) && room.matchId === matchId) fn();
  }, ms + 300);
}

function resetReady(room) {
  for (const p of room.players) p.ready = false;
}

async function startGame(room) {
  // 접속이 끊긴 채 남아 있는 사람은 빼고 시작한다
  room.players = room.players.filter((p) => p.socketId);
  room.matchId += 1;
  const matchId = room.matchId;
  room.phase = 'preparing';
  room.error = null;
  room.report = null;
  room.game = null;
  room.deadline = null;
  resetReady(room);
  broadcast(room);
  try {
    const c = await takeCase(room.level);
    if (!rooms.has(room.code) || room.matchId !== matchId) return;
    room.game = createGame(c, room.players);
    room.phase = 'briefing';
    system(room, `사건 파일 "${c.flavor.title}"이(가) 도착했다.`);
    armTimer(room, BRIEF_SECONDS * 1000, () => beginPlan(room));
  } catch (err) {
    if (room.matchId !== matchId) return;
    console.error('사건 준비 실패:', err);
    room.phase = 'waiting';
    room.error = '사건을 준비하지 못했어요. 다시 시작해 주세요.';
  }
  broadcast(room);
}

function beginPlan(room, ms = PLAN_SECONDS * 1000) {
  room.phase = 'plan';
  resetReady(room);
  armTimer(room, ms, () => endPlan(room));
  broadcast(room);
}

function endPlan(room) {
  const g = room.game;
  const loop = g.loop;
  revealLoop(g);
  system(room, `${loop}번째 재생 결과가 공개됐다.`);
  if (finished(g)) {
    beginReview(room);
  } else {
    beginPlan(room);
  }
}

// 최종 검토: 마지막 재생 결과를 보고 회의할 시간. 관측자는 못 놓고, 모두 준비되면 바로 최종 고발로
function beginReview(room) {
  room.phase = 'review';
  resetReady(room);
  system(room, '모든 재생이 끝났다. 기록을 정리하고 고발을 준비하라.');
  armTimer(room, REVIEW_SECONDS * 1000, () => startVote(room, 'final', null));
  broadcast(room);
}

function startVote(room, kind, proposer) {
  const g = room.game;
  if (kind === 'accuse') room.planLeft = Math.max(5000, room.deadline - Date.now());
  room.phase = 'vote';
  openVote(g, kind, proposer?.key ?? null, null);
  if (kind === 'accuse') system(room, `${proposer.name}님이 고발 투표를 열었다.`);
  if (kind === 'final') system(room, '최종 고발 투표가 시작됐다.');
  if (kind === 'unmask') system(room, '범인을 맞혔다. 이제 교수를 찾아라.');
  armTimer(room, VOTE_SECONDS * 1000, () => finishVote(room));
  broadcast(room);
}

function finishVote(room) {
  const g = room.game;
  if (!g?.vote) return;
  const { kind, decided } = closeVote(g, Math.max(1, connected(room).length));
  const sus = (i) => g.case.flavor.suspects[i].name;

  if (kind === 'unmask') return judge(room);
  if (decided === null) {
    if (kind === 'final') {
      system(room, '의견이 갈려 고발하지 못했다.');
      return judge(room);
    }
    system(room, '고발 투표가 부결됐다. 수사를 이어 간다.');
    return beginPlan(room, room.planLeft);
  }
  system(room, `${sus(decided)}을(를) 범인으로 고발했다.`);
  if (g.accusation.correct && g.professorKey) return startVote(room, 'unmask', null);
  judge(room);
}

// 결과 리포트는 AI 없이 서버가 바로 만든다 (사건의 전말은 사건을 만들 때 이미 써 두었다)
function judge(room) {
  clearTimeout(room.timer);
  room.deadline = null;
  room.report = buildReport(room.game);
  room.phase = 'result';
  broadcast(room);
}

function backToWaiting(room) {
  clearTimeout(room.timer);
  room.matchId += 1;
  room.phase = 'waiting';
  room.game = null;
  room.report = null;
  room.deadline = null;
  room.error = null;
  room.players = room.players.filter((p) => p.socketId);
  resetReady(room);
  broadcast(room);
}

// 모두 준비되면 남은 시간을 기다리지 않고 넘어간다
function checkAllReady(room) {
  const people = connected(room);
  if (!people.length || !people.every((p) => p.ready)) return false;
  if (room.phase === 'briefing') beginPlan(room);
  else if (room.phase === 'plan') endPlan(room);
  else if (room.phase === 'review') startVote(room, 'final', null);
  return true;
}

function cleanName(name) {
  return String(name ?? '').normalize('NFC').trim().replace(/\s+/g, ' ').slice(0, 12);
}

const RESERVED = new Set(['교수', '시스템', '관리자', '운영자', 'admin', 'system']);
const nameId = (n) => n.toLowerCase().replace(/\s/g, '');

function checkName(room, name, key) {
  if (!name) return '이름을 정해 주세요.';
  if (RESERVED.has(nameId(name))) return '쓸 수 없는 이름이에요.';
  if (room?.players.some((p) => p.key !== key && nameId(p.name) === nameId(name))) return '방에 같은 이름이 있어요.';
  return null;
}

// ---------- 소켓 ----------

io.on('connection', (socket) => {
  let room = null;
  let player = null;

  const fail = (msg) => socket.emit('fail', msg);

  function bind(r, p) {
    room = r;
    player = p;
    p.socketId = socket.id;
    clearTimeout(r.cleanup);
    socket.emit('joined', { code: r.code });
  }

  function enter(r, name, key) {
    const display = cleanName(name);
    const err = checkName(r, display, key);
    if (err) return fail(err);
    const p = { key, name: display, socketId: null, ready: false, lastChatAt: 0 };
    r.players.push(p);
    if (!r.hostKey) r.hostKey = key;
    bind(r, p);
    system(r, `${display}님이 들어왔다.`);
    broadcast(r);
  }

  function removeFromRoom() {
    const r = room;
    r.players = r.players.filter((p) => p !== player);
    if (r.hostKey === player.key) r.hostKey = r.players[0]?.key ?? null;
    system(r, `${player.name}님이 나갔다.`);
    room = null;
    player = null;
    if (!r.players.length) deleteRoom(r);
    else broadcast(r);
  }

  socket.on('create', ({ name, key } = {}) => {
    if (room || typeof key !== 'string') return;
    if (rooms.size >= MAX_ROOMS) return fail('지금은 방이 너무 많아요. 잠시 후 다시 시도해 주세요.');
    const err = checkName(null, cleanName(name), key);
    if (err) return fail(err);
    if (!allowCreate(clientIp(socket))) return fail('방을 너무 자주 만들었어요. 잠시 후 다시 시도해 주세요.');
    const r = newRoom(newCode());
    rooms.set(r.code, r);
    enter(r, name, key);
  });

  socket.on('join', ({ code, name, key } = {}) => {
    if (typeof key !== 'string') return;
    const r = rooms.get(String(code ?? '').trim().toUpperCase());
    if (!r) return fail('방을 찾을 수 없어요. 이미 끝났거나 코드가 틀렸어요.');
    const existing = r.players.find((p) => p.key === key);
    if (existing) {
      bind(r, existing); // 새로고침, 재접속
      broadcast(r);
      return;
    }
    if (room) return;
    if (r.phase !== 'waiting') return fail('이미 수사가 진행 중인 방이에요.');
    if (r.players.length >= MAX_PLAYERS) return fail(`방이 가득 찼어요. (최대 ${MAX_PLAYERS}명)`);
    enter(r, name, key);
  });

  socket.on('leave', () => {
    if (!room || (room.phase !== 'waiting' && room.phase !== 'result')) return;
    removeFromRoom();
    socket.emit('left');
  });

  socket.on('level', (level) => {
    if (!room || room.phase !== 'waiting' || hostOf(room) !== player) return;
    if (!LEVELS.some((l) => l.level === level)) return;
    room.level = level;
    broadcast(room);
  });

  socket.on('start', () => {
    if (!room || room.phase !== 'waiting' || hostOf(room) !== player) return;
    startGame(room);
  });

  socket.on('again', () => {
    if (!room || room.phase !== 'result' || hostOf(room) !== player) return;
    backToWaiting(room);
  });

  socket.on('ready', (value) => {
    if (!room || !['briefing', 'plan', 'review'].includes(room.phase)) return;
    player.ready = value !== false;
    if (!checkAllReady(room)) broadcast(room);
  });

  socket.on('place', ({ place: p, time } = {}) => {
    if (!room || room.phase !== 'plan') return;
    const err = place(room.game, player.key, p, time);
    if (err) return fail(err);
    player.ready = false;
    broadcast(room);
  });

  socket.on('unplace', ({ place: p, time } = {}) => {
    if (!room || room.phase !== 'plan') return;
    unplace(room.game, player.key, p, time);
    player.ready = false;
    broadcast(room);
  });

  socket.on('forge', ({ place: p, time, forge } = {}) => {
    if (!room || room.phase !== 'plan') return;
    const err = setForge(room.game, player.key, p, time, forge ?? null);
    if (err) return fail(err);
    broadcast(room);
  });

  socket.on('noise', ({ place: p = null, time = null } = {}) => {
    if (!room || room.phase !== 'plan') return;
    const err = setNoise(room.game, player.key, p, time);
    if (err) return fail(err);
    broadcast(room);
  });

  socket.on('propose', () => {
    if (!room || room.phase !== 'plan' || room.game.proposedLoop === room.game.loop) return;
    startVote(room, 'accuse', player);
  });

  socket.on('vote', (choice) => {
    const g = room?.game;
    if (!g?.vote || room.phase !== 'vote') return;
    // 교수 지목은 플레이어 키 대신 명단 순서로 받는다 (키는 재접속용 비밀값이라 화면에 보내지 않는다)
    const value = g.vote.kind === 'unmask' ? g.roster[choice]?.key : choice;
    if (value === undefined) return;
    castVote(g, player.key, value);
    if (connected(room).every((p) => g.vote.choices.has(p.key))) finishVote(room);
    else broadcast(room);
  });

  socket.on('chat', (text) => {
    if (!room) return;
    const now = Date.now();
    const msg = String(text ?? '').trim().slice(0, MAX_CHAT);
    if (!msg || now - player.lastChatAt < CHAT_COOLDOWN_MS) return;
    player.lastChatAt = now;
    room.chat.push({ name: player.name, text: msg, at: now });
    if (room.chat.length > 200) room.chat.shift();
    broadcast(room);
  });

  socket.on('disconnect', () => {
    if (!room || player.socketId !== socket.id) return;
    player.socketId = null;
    const r = room;
    if (r.phase === 'waiting') {
      // 대기실에서 나간 사람은 잠깐 기다렸다가 자리를 비운다 (새로고침이면 그새 돌아온다)
      const p = player;
      setTimeout(() => {
        if (!p.socketId && r.phase === 'waiting' && r.players.includes(p)) {
          r.players = r.players.filter((x) => x !== p);
          if (r.hostKey === p.key) r.hostKey = r.players[0]?.key ?? null;
          if (!r.players.length) deleteRoom(r);
          else broadcast(r);
        }
      }, 15000);
    } else if (['plan', 'briefing', 'review'].includes(r.phase)) {
      checkAllReady(r);
    } else if (r.phase === 'vote' && r.game?.vote && connected(r).length && connected(r).every((p) => r.game.vote.choices.has(p.key))) {
      finishVote(r);
    }
    broadcast(r);
    if (r.players.every((p) => !p.socketId)) {
      r.cleanup = setTimeout(() => deleteRoom(r), ROOM_TTL_MS);
    }
  });
});

// Render 무료 플랜은 15분 동안 들어오는 요청이 없으면 잠든다.
// KEEP_AWAKE=1이면 10분마다 자기 공개 주소(Render가 RENDER_EXTERNAL_URL로 알려 준다)의 /healthz를 불러 깨어 있게 한다.
// 한 번 잠들면 스스로는 못 깨어나므로, 외부 모니터링(cron-job.org 등)으로도 두드리는 걸 권한다.
const KEEP_AWAKE_URL = process.env.KEEP_AWAKE === '1' ? process.env.RENDER_EXTERNAL_URL : null;
const KEEP_AWAKE_MS = 10 * 60 * 1000;

httpServer.listen(PORT, () => {
  console.log(`Riddle404: http://localhost:${PORT}`);
  if (mockMode) console.log('GEMINI_API_KEY가 없어 테스트 모드(기본 사건 문장)로 실행합니다.');
  warmUp();
  if (KEEP_AWAKE_URL) {
    console.log(`잠들지 않게 ${KEEP_AWAKE_MS / 60000}분마다 ${KEEP_AWAKE_URL}/healthz를 부릅니다.`);
    setInterval(() => {
      fetch(`${KEEP_AWAKE_URL}/healthz`).catch((err) => console.warn('깨우기 요청 실패:', err.message));
    }, KEEP_AWAKE_MS).unref();
  }
});

