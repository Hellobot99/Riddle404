const socket = io();
const $ = (sel) => document.querySelector(sel);
const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// 이름은 브라우저 전체(localStorage)에, 플레이어 키와 방 코드는 탭마다(sessionStorage) 둔다.
// 그래야 같은 브라우저의 탭 여러 개가 서로 다른 요원으로 들어갈 수 있고, 새로고침하면 같은 자리로 돌아온다.
const makeStore = (getStorage) => ({
  get(k) { try { return getStorage().getItem(k); } catch { return null; } },
  set(k, v) { try { getStorage().setItem(k, v); } catch {} },
  del(k) { try { getStorage().removeItem(k); } catch {} },
});
const store = makeStore(() => localStorage);
const tabStore = makeStore(() => sessionStorage);
let playerKey = tabStore.get('r404-key');
if (!playerKey) {
  playerKey = crypto.randomUUID?.() ?? String(Math.random()).slice(2);
  tabStore.set('r404-key', playerKey);
}

let state = null;
let clockOffset = 0;
let selected = null; // 선택한 칸 {place, time}
let showTruth = false; // 교수 전용: 진실 겹쳐 보기
let autoJoining = false;
let viewTime = null; // 지도에 보여 줄 시각
let pane = 'note'; // 오른쪽 패널: note | record | routes | chat
let seenChat = 0; // 회의 탭에서 마지막으로 본 채팅 수 (안 읽은 표시용)
let secretOpen = false; // 교수 기밀 패널 펼침

// 난이도 규칙 설명. 단계가 오를 때마다 하나씩 더해진다 (서버의 LEVELS와 같은 이름)
const MOD_TEXT = {
  accomplice: ['공범', '범인의 위조 기록에 공범이 함께 찍혀 거짓 증언을 한다. 함께 찍혔다고 증인이 되는 건 아니다.'],
  blackout: ['정전', '한 시각 동안 기록에 사람 수만 남는다.'],
  lock: ['잠긴 문', '한 통로가 몇 시간 잠겨 있었다. 그동안 그 문으로는 지나갈 수 없다.'],
  doubleFake: ['이중 위조', '범인이 범행 시각과 바로 옆 시각까지 두 칸을 위조했다. 허점은 한 칸 더 바깥에 있다.'],
};
const LEVEL_NAME = { 1: '기본', 2: '공범', 3: '정전', 4: '잠긴 문', 5: '이중 위조' };

const SCREENS = ['lobby', 'room', 'loading', 'briefing', 'game', 'result'];
const PHASE_SCREEN = { waiting: 'room', preparing: 'loading', briefing: 'briefing', plan: 'game', vote: 'game', result: 'result' };

// ---------- 로비 ----------

const nameInput = $('#name');
nameInput.value = store.get('r404-name') ?? '';
const inviteCode = new URLSearchParams(location.search).get('room')?.toUpperCase();
if (inviteCode) {
  $('#join-invite').hidden = false;
  $('#invite-code').textContent = inviteCode;
}

function requireName() {
  const n = nameInput.value.trim();
  if (!n) {
    lobbyError('요원 이름을 먼저 정해 주세요.');
    nameInput.focus();
    return null;
  }
  store.set('r404-name', n);
  return n;
}

function lobbyError(msg) {
  $('#lobby-error').textContent = msg;
  $('#lobby-error').hidden = !msg;
}

$('#btn-create').onclick = () => {
  const name = requireName();
  if (name) socket.emit('create', { name, key: playerKey });
};
$('#btn-join').onclick = () => {
  const name = requireName();
  const code = $('#code').value.trim().toUpperCase();
  if (!code) return lobbyError('초대 코드를 입력해 주세요.');
  if (name) socket.emit('join', { code, name, key: playerKey });
};
$('#btn-join-invite').onclick = () => {
  const name = requireName();
  if (name) socket.emit('join', { code: inviteCode, name, key: playerKey });
};
nameInput.addEventListener('input', () => lobbyError(''));

$('#btn-copy').onclick = async () => {
  const url = `${location.origin}/?room=${state.code}`;
  try {
    await navigator.clipboard.writeText(url);
    $('#btn-copy').textContent = '복사했어요!';
  } catch {
    prompt('이 링크를 동료에게 보내세요', url);
  }
  setTimeout(() => ($('#btn-copy').textContent = '초대 링크 복사'), 1500);
};
$('#btn-start').onclick = () => socket.emit('start');
$('#room-level').addEventListener('click', (e) => {
  const b = e.target.closest('[data-level]');
  if (b && !b.disabled) socket.emit('level', Number(b.dataset.level));
});
$('#btn-leave').onclick = () => socket.emit('leave');
$('#btn-result-leave').onclick = () => socket.emit('leave');
$('#btn-again').onclick = () => socket.emit('again');
$('#btn-brief-ready').onclick = () => socket.emit('ready', !state.me.ready);
$('#btn-plan-ready').onclick = () => socket.emit('ready', !state.me.ready);
$('#btn-propose').onclick = () => {
  if (confirm('고발 투표를 열까요? 과반이 같은 용의자를 고르면 바로 고발되고, 고발은 한 번뿐이에요.')) socket.emit('propose');
};

$('#chat-form').onsubmit = (e) => {
  e.preventDefault();
  const text = $('#chat-input').value.trim();
  if (!text) return;
  socket.emit('chat', text);
  $('#chat-input').value = '';
};

// ---------- 소켓 ----------

socket.on('connect', () => {
  const code = tabStore.get('r404-room');
  if (code) {
    autoJoining = true;
    socket.emit('join', { code, name: nameInput.value.trim(), key: playerKey });
  }
});

socket.on('joined', ({ code }) => {
  autoJoining = false;
  tabStore.set('r404-room', code);
  history.replaceState(null, '', `/?room=${code}`);
  lobbyError('');
});

socket.on('left', () => {
  window.Music?.setScene('lobby');
  tabStore.del('r404-room');
  state = null;
  selected = null;
  history.replaceState(null, '', '/');
  $('#join-invite').hidden = true;
  render();
});

socket.on('fail', (msg) => {
  if (autoJoining) {
    // 새로고침했는데 방이 이미 사라진 경우: 조용히 로비로
    autoJoining = false;
    tabStore.del('r404-room');
    return;
  }
  if (!state) lobbyError(msg);
  else toast(msg);
});

// 진행 단계 → 배경음악 장면. 수사는 남은 재생이 3번 이하면 긴박한 곡으로
function musicScene(s) {
  if (!s) return 'lobby';
  if (s.phase === 'briefing') return 'briefing';
  if (s.phase === 'plan') return s.loop > s.loops - 3 ? 'investigate-late' : 'investigate';
  if (s.phase === 'vote') return 'vote';
  if (s.phase === 'result') return s.result?.outcome?.detectivesWin ? 'reveal' : 'fail';
  return 'lobby';
}

// 효과음: 재생 결과가 공개될 때(정전 기록이 섞였으면 정전 소리도), 결과 화면에 들어설 때
function playMusicFor(prev, s) {
  if (!window.Music) return;
  if (s.phase === 'result' && prev?.phase !== 'result') return window.Music.reveal(musicScene(s));
  window.Music.setScene(musicScene(s));
  const before = prev?.observations?.length ?? 0;
  const fresh = (s.observations ?? []).slice(before);
  if (prev?.observations && fresh.length) {
    window.Music.sfx('replay');
    if (fresh.some((o) => o.blackout)) setTimeout(() => window.Music.sfx('powerDown'), 900);
  }
}

socket.on('state', (s) => {
  const prev = state;
  if (state && state.loop !== s.loop) selected = null;
  if (s.phase === 'briefing') {
    selected = null;
    viewTime = null;
    pane = 'note';
    seenChat = s.chat.filter((m) => !m.system).length;
  }
  state = s;
  clockOffset = s.serverNow - Date.now();
  render();
  playMusicFor(prev, s);
});

// ---------- 공용 ----------

let toastTimer = null;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 2500);
}

function remaining() {
  if (!state?.deadline) return null;
  return Math.max(0, Math.ceil((state.deadline - (Date.now() + clockOffset)) / 1000));
}

function tickTimers() {
  const left = remaining();
  const text = left === null ? '' : `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
  for (const id of ['#brief-timer', '#hud-timer', '#vote-timer']) {
    const el = $(id);
    el.textContent = text;
    el.classList.toggle('urgent', left !== null && left <= 10);
  }
}
setInterval(tickTimers, 250);

const susName = (i) => state.case.suspects[i]?.name ?? '?';
const initial = (name) => String(name).trim()[0] ?? '?';
const ck = (p, t) => `${p}:${t}`;
const inWindow = (t) => t >= state.case.window[0] && t <= state.case.window[1];
const myPlayer = () => state.players.find((p) => p.isMe);

function chip(i, extra = '') {
  return `<span class="chip s${i} ${extra}" title="${esc(susName(i))}">${esc(initial(susName(i)))}</span>`;
}

// ---------- 렌더 ----------

function render() {
  const screen = state ? PHASE_SCREEN[state.phase] : 'lobby';
  for (const s of SCREENS) $(`#screen-${s}`).hidden = s !== screen;
  // 수사 화면은 상단 바가 머리와 테스트 모드 표시를 대신한다
  document.body.classList.toggle('in-game', screen === 'game');
  $('#brand').hidden = screen === 'game';
  $('#mock-banner').hidden = !state?.mockMode || screen === 'game';

  const slot = $(`#screen-${screen} .chat-slot`);
  $('#chat').hidden = !slot;
  if (slot && $('#chat').parentElement !== slot) slot.appendChild($('#chat'));

  if (!state) return;
  renderChat();
  if (screen === 'room') renderRoom();
  if (screen === 'briefing') renderBriefing();
  if (screen === 'game') renderGame();
  if (screen === 'result') renderResult();
  else if (replay.playing) stopReplay();
  renderVote();
  tickTimers();
}

function renderChat() {
  const log = $('#chat-log');
  const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  log.innerHTML = state.chat
    .map((m) => (m.system ? `<li class="sys">${esc(m.text)}</li>` : `<li><b>${esc(m.name)}</b> ${esc(m.text)}</li>`))
    .join('');
  if (nearBottom) log.scrollTop = log.scrollHeight;
}

function renderRoom() {
  $('#room-code').textContent = state.code;
  $('#room-players').innerHTML = state.players
    .map((p) => `<li class="${p.connected ? '' : 'off'}">${p.isHost ? '<span class="badge">방장</span>' : ''}${esc(p.name)}${p.isMe ? ' <span class="muted">(나)</span>' : ''}</li>`)
    .join('');
  const n = state.players.length;
  const s = state.setup;
  $('#room-setup').innerHTML = `${n}명 / 최대 ${state.maxPlayers}명 · 교수 <b class="${s.hasProfessor ? 'red' : ''}">${s.hasProfessor ? '있음' : '없음'}</b> · 탐정 팀 루프당 관측 ${s.teamTotal}개 · 재생 ${state.loops}번`
    + (s.hasProfessor ? '' : '<br><span class="muted">4명부터 교수(방해자)가 섞여요.</span>');
  $('#room-error').textContent = state.error ?? '';
  $('#room-error').hidden = !state.error;
  $('#room-level').innerHTML = state.levels.map(({ level, mods }) => {
    const on = level === state.level;
    const added = mods.at(-1);
    const desc = on && added ? `<span class="level-desc">${esc(MOD_TEXT[added][1])}${mods.length > 1 ? ` (앞 단계 규칙 ${mods.length - 1}개 포함)` : ''}</span>` : '';
    return `<button class="level${on ? ' on' : ''}" data-level="${level}" ${state.me.isHost ? '' : 'disabled'}><span class="level-head"><b>${level}</b>${esc(LEVEL_NAME[level])}${level > 1 ? `<span class="level-bonus">+${(level - 1) * 40}점</span>` : ''}</span>${desc}</button>`;
  }).join('');
  $('#btn-start').hidden = !state.me.isHost;
  $('#room-wait').hidden = state.me.isHost;
}

function roleCard() {
  if (state.me.role === 'professor') {
    const sec = state.secret;
    return `<p class="kicker red">// 기밀: 당신은 교수다</p>
      <p>진범 ${chip(sec.culprit)} <b>${esc(susName(sec.culprit))}</b> · 범행 시각 <b>${state.case.times[sec.crimeTime]}</b></p>
      <p class="small muted">탐정들이 틀린 사람을 고발하게 만들어라. 변조 ${sec.charges.forge}회 · 노이즈 ${sec.charges.noise}회. 범인이 잡혀도 교수 지목 투표가 있으니 정체를 숨겨라.</p>`;
  }
  return `<p class="kicker">// 당신은 복원 요원</p>
    <p class="small">${state.hasProfessor ? '요원 중 <b class="red">한 명은 교수</b>다. 앞뒤가 안 맞는 기록은 같은 방을 다시 관측해 확인하라.' : '모두 같은 편이다. 회의로 관측할 방을 나누면 빨라진다.'}</p>`;
}

// 이번 사건에 걸린 난이도 규칙과, 공개되는 사실(잠긴 문, 정전 시각)
function ruleNotes(withTitle) {
  const c = state.case;
  const mods = state.levels.find((l) => l.level === c.level)?.mods ?? [];
  if (!mods.length) return '';
  const facts = [];
  for (const l of c.locks) facts.push(`🔒 ${esc(c.places[l.a])} ↔ ${esc(c.places[l.b])} 문: ${c.times[l.from]}~${c.times[l.to]} 잠김 (그 시각에 이 문을 지나 도착할 수 없다)`);
  if (c.blackout !== null) facts.push(`⚡ ${c.times[c.blackout]} 정전: 이 시각 기록엔 사람 수만 남는다`);
  return `${withTitle ? `<p class="label">난이도 ${c.level} · ${esc(LEVEL_NAME[c.level])}</p>` : ''}
    <ul class="rule-list">${mods.map((m) => `<li><b>${MOD_TEXT[m][0]}</b> · ${esc(MOD_TEXT[m][1])}</li>`).join('')}</ul>
    ${facts.length ? `<ul class="rule-list facts">${facts.map((f) => `<li>${f}</li>`).join('')}</ul>` : ''}`;
}

function renderBriefing() {
  const c = state.case;
  $('#role-card').innerHTML = roleCard();
  $('#role-card').className = `role${state.me.role === 'professor' ? ' secret' : ''}`;
  $('#brief-title').textContent = c.title;
  $('#brief-intro').textContent = c.intro;
  $('#brief-victim').textContent = `피해자: ${c.victim}`;
  $('#brief-suspects').innerHTML = c.suspects
    .map((s, i) => `<li>${chip(i)} <b>${esc(s.name)}</b> <span class="muted">${esc(s.role)}</span><br><span class="small">${esc(s.profile)}</span></li>`)
    .join('');
  $('#brief-map-name').textContent = c.map.name;
  renderMap($('#brief-map'), null, null);
  $('#brief-window').textContent = `${c.times[c.window[0]]} ~ ${c.times[c.window[1]]} 사이`;
  $('#brief-rules').innerHTML = ruleNotes(true);
  $('#btn-brief-ready').textContent = state.me.ready ? '준비 취소' : '준비 완료';
  const ready = state.players.filter((p) => p.ready && p.connected).length;
  $('#brief-ready-count').textContent = `준비 ${ready}/${state.players.filter((p) => p.connected).length} · 모두 준비하면 바로 시작`;
}

// 같은 칸 결과가 서로 다르거나, 한 사람이 같은 시각 두 곳에서 보이면 모순
function conflicts() {
  const byCell = new Map();
  const seenAt = new Map(); // "용의자:시각" → 장소 집합
  for (const o of state.observations) {
    if (o.noise) continue;
    const k = ck(o.place, o.time);
    if (!byCell.has(k)) byCell.set(k, new Set());
    byCell.get(k).add([...o.present].sort().join(','));
    for (const s of o.present) {
      const sk = `${s}:${o.time}`;
      if (!seenAt.has(sk)) seenAt.set(sk, new Set());
      seenAt.get(sk).add(o.place);
    }
  }
  const cells = new Set([...byCell].filter(([, v]) => v.size > 1).map(([k]) => k));
  const people = new Set([...seenAt].filter(([, v]) => v.size > 1).map(([k]) => k));
  return { cells, people, seenAt };
}

function renderGame() {
  const c = state.case;
  const me = myPlayer();
  const prof = state.me.role === 'professor';
  const planning = state.phase === 'plan';

  // 상단 바
  $('#tb-case').textContent = c.title;
  $('#tb-test').hidden = !state.mockMode;
  $('#hud-loop').textContent = `${state.loop}/${state.loops}`;
  $('#hud-quota').innerHTML = `<span class="on">${'●'.repeat(me.placed)}</span>${'○'.repeat(Math.max(0, me.quota - me.placed))}`;
  $('#hud-quota').title = `이번 루프 ${me.quota}개 중 ${me.placed}개 배치`;
  $('#btn-plan-ready').hidden = !planning;
  $('#btn-plan-ready').textContent = state.me.ready ? '확정 취소' : '배치 확정';
  $('#btn-plan-ready').classList.toggle('ghost', state.me.ready);
  $('#btn-plan-ready').classList.toggle('primary', !state.me.ready);
  $('#btn-propose').hidden = !planning;
  $('#btn-propose').disabled = !state.canPropose;
  $('#btn-propose').title = state.canPropose ? '고발 투표 열기' : '이번 루프에는 이미 고발 투표를 열었어요';

  // 교수 기밀 패널: 평소엔 접어 두고 버튼으로 연다
  $('#btn-secret').hidden = !prof;
  $('#btn-secret').classList.toggle('on', secretOpen);
  $('#secret-panel').hidden = !prof || !secretOpen;
  if (prof && secretOpen) {
    const sec = state.secret;
    $('#secret-panel').innerHTML = `<span><b class="red">교수 전용</b> · 진범 ${chip(sec.culprit)} <b>${esc(susName(sec.culprit))}</b> · 범행 시각 <b>${c.times[sec.crimeTime]}</b></span>
      <span class="muted">변조 ${sec.charges.forge}회 · 노이즈 ${sec.charges.noise}회 남음${sec.noiseCell ? ' · <span class="red">이번 루프 노이즈 설정됨</span>' : ''}</span>
      <label class="check"><input type="checkbox" id="truth-toggle" ${showTruth ? 'checked' : ''}> 진실 겹쳐 보기</label>`;
    $('#truth-toggle').onchange = (e) => {
      showTruth = e.target.checked;
      renderStage();
    };
  }

  renderStage();

  // 지도 아래: 용의자 범례, 팀 현황
  $('#legend').innerHTML = c.suspects.map((s, i) => `<span>${chip(i)} ${esc(s.name)}</span>`).join('');
  $('#team-status').innerHTML = state.players
    .filter((p) => p.quota > 0 || p.placed > 0)
    .map((p) => `<span class="mate${p.ready ? ' ready' : ''}${p.connected ? '' : ' off'}" title="${p.placed}/${p.quota} 배치${p.ready ? ', 확정함' : ''}">${p.ready ? '✓' : `${p.placed}/${p.quota}`} ${esc(p.name)}</span>`)
    .join('');

  // 오른쪽 패널
  for (const b of document.querySelectorAll('.side-tabs .tab')) b.classList.toggle('on', b.dataset.pane === pane);
  for (const id of ['note', 'record', 'routes', 'chat']) $(`#pane-${id}`).hidden = pane !== id;
  if (pane === 'chat') seenChat = chatCount();
  const unread = chatCount() - seenChat;
  $('#chat-badge').hidden = unread <= 0;
  $('#chat-badge').textContent = unread > 9 ? '9+' : unread;
  renderNote();
  renderRecord();
  renderRoutes();
}

const chatCount = () => state.chat.filter((m) => !m.system).length;

// 지도와 타임라인
function renderStage() {
  if (viewTime === null) viewTime = selected?.time ?? state.case.window[0];
  const ctx = boardContext();
  renderMap($('#map'), ctx, viewTime);
  renderTimeline(ctx);
}

// 관측 결과, 배치, 모순을 한 번에 모아 둔다
function boardContext() {
  const obs = new Map();
  for (const o of state.observations) {
    const k = ck(o.place, o.time);
    if (!obs.has(k)) obs.set(k, []);
    obs.get(k).push(o);
  }
  return {
    obs,
    plan: new Map(state.placements.map((p) => [ck(p.place, p.time), p])),
    badCells: conflicts().cells,
    lastLoop: state.loop - 1,
    truth: state.me.role === 'professor' && showTruth ? state.secret : null,
  };
}

/** 방 하나(장소 p, 시각 t)의 class 목록과 안쪽 HTML */
function roomContent(ctx, p, t) {
  const k = ck(p, t);
  const list = ctx.obs.get(k) ?? [];
  const valid = list.filter((o) => !o.noise);
  const latest = valid.at(-1);
  const cls = [];
  const isSel = selected && selected.place === p && selected.time === t;
  if (isSel) cls.push('sel');
  if (latest) cls.push('seen');
  if (latest && latest.loop === ctx.lastLoop) cls.push('fresh');
  if (ctx.badCells.has(k)) cls.push('bad');
  if (list.length && !valid.length) cls.push('noise');

  let inner = '';
  if (latest?.blackout) {
    inner = `<span class="dark">⚡ 👥 ${latest.count}명</span>`;
  } else if (latest) {
    inner = latest.present.map((s) => chip(s)).join('') || '<span class="empty">아무도 없음</span>';
    if (latest.events.length) inner += '<i class="ev" title="기록 있음">◆</i>';
    if (latest.forged) inner += '<i class="fg" title="변조된 기록">✎</i>';
  } else if (list.length) {
    inner = '<span class="static">▒▒ 잡음</span>';
  } else if (ctx.truth) {
    inner = ctx.truth.presence.map((row, s) => (row[t] === p ? chip(s, 'ghost') : '')).join('');
  }
  if (ctx.badCells.has(k)) inner += '<i class="warn" title="재생마다 결과가 다름">!</i>';
  const pl = ctx.plan.get(k);
  if (pl) {
    cls.push(pl.isMe ? 'mine' : 'planned');
    inner += `<span class="pin" title="${esc(pl.name)} 관측 예정">👁 ${esc(initial(pl.name))}</span>`;
  }
  if (ctx.truth && ctx.truth.noiseCell === k) inner += '<span class="noise-pin">N</span>';

  // 선택한 방에는 바로 누를 수 있는 배치 버튼을 띄운다 (상세는 오른쪽 기록 패널)
  if (isSel && state.phase === 'plan') {
    const me = myPlayer();
    if (pl?.isMe) inner += '<span class="room-act ghost" data-act="unplace">관측 취소</span>';
    else if (!pl && me.placed < me.quota) inner += `<span class="room-act" data-act="place">＋ ${list.length ? '다시 관측' : '관측자 놓기'}</span>`;
  }
  return { cls, inner };
}

function sceneContent(ctx, t) {
  return ctx.truth && t !== null ? ctx.truth.presence.map((row, s) => (row[t] === 0 ? chip(s, 'ghost') : '')).join('') : '';
}

// 이웃 방 사이 통로 표시. 맞닿은 변의 가운데에 작은 문을 그린다.
// t 시각에 잠긴 문(브리핑 미리보기에서는 잠기는 문 전부)에는 자물쇠를 단다.
function doorsHtml(m, t = null) {
  const locks = state.case?.locks ?? [];
  const lockedNow = (a, b) => locks.some((l) => ((l.a === a && l.b === b) || (l.a === b && l.b === a)) && (t === null || (t >= l.from && t <= l.to)));
  const out = [];
  m.adj.forEach((list, a) => {
    for (const b of list) {
      if (b < a) continue;
      const A = m.rooms[a];
      const B = m.rooms[b];
      const yo = [Math.max(A.y, B.y), Math.min(A.y + A.h, B.y + B.h)];
      const xo = [Math.max(A.x, B.x), Math.min(A.x + A.w, B.x + B.w)];
      let x, y, dir;
      if (yo[1] - yo[0] > 0 && !(xo[1] - xo[0] > 0)) {
        x = (Math.min(A.x + A.w, B.x + B.w) + Math.max(A.x, B.x)) / 2;
        y = (yo[0] + yo[1]) / 2;
        dir = 'v';
      } else if (xo[1] - xo[0] > 0) {
        x = (xo[0] + xo[1]) / 2;
        y = (Math.min(A.y + A.h, B.y + B.h) + Math.max(A.y, B.y)) / 2;
        dir = 'h';
      } else {
        x = (A.x + A.w / 2 + B.x + B.w / 2) / 2;
        y = (A.y + A.h / 2 + B.y + B.h / 2) / 2;
        dir = 'h';
      }
      const locked = lockedNow(a, b);
      out.push(`<span class="door ${dir}${a === 0 || b === 0 ? ' to-scene' : ''}${locked ? ' locked' : ''}" style="left:${x}%;top:${y}%">${locked ? '<i>🔒</i>' : ''}</span>`);
    }
  });
  return out.join('');
}

/** 지도 그리기. ctx가 없으면(브리핑 미리보기) 방 이름만 그린다. */
function renderMap(el, ctx, t) {
  const m = state.case.map;
  const ratio = m.aspect[0] / m.aspect[1];
  el.style.aspectRatio = `${m.aspect[0]} / ${m.aspect[1]}`;
  // 화면 높이에 맞춰 지도가 넘치지 않게 너비를 제한한다 (수사 화면에서만)
  el.style.maxWidth = ctx ? `calc((100dvh - 210px) * ${ratio})` : '';
  el.style.backgroundImage = m.image ? `url("${m.image}")` : '';
  el.classList.toggle('has-image', !!m.image);
  el.innerHTML = doorsHtml(m, ctx ? t : null) + m.rooms.map((r, p) => {
    const pos = `left:${r.x}%;top:${r.y}%;width:${r.w}%;height:${r.h}%`;
    const name = esc(state.case.places[p]);
    const icon = `<span class="room-icon" aria-hidden="true">${esc(r.icon)}</span>`;
    if (p === 0) {
      return `<div class="room scene" style="${pos}">${icon}<span class="room-name">${name}</span><span class="glitch-404">404</span><div class="room-body">${ctx ? sceneContent(ctx, t) : ''}</div></div>`;
    }
    if (!ctx) return `<div class="room" style="${pos}">${icon}<span class="room-name">${name}</span></div>`;
    const { cls, inner } = roomContent(ctx, p, t);
    return `<button class="room ${cls.join(' ')}" style="${pos}" data-p="${p}" data-t="${t}">${icon}<span class="room-name">${name}</span><div class="room-body">${inner}</div></button>`;
  }).join('');
}

function renderTimeline(ctx) {
  const c = state.case;
  const rooms = c.places.length - 1;
  $('#timeline').innerHTML = c.times.map((label, t) => {
    const seen = new Set(state.observations.filter((o) => o.time === t && !o.noise).map((o) => o.place)).size;
    const planned = state.placements.filter((p) => p.time === t).length;
    const cls = ['tick'];
    if (t === viewTime) cls.push('on');
    if (inWindow(t)) cls.push('win');
    if (ctx.truth && ctx.truth.crimeTime === t) cls.push('crime');
    if ([...ctx.badCells].some((k) => k.endsWith(`:${t}`))) cls.push('bad');
    const marks = `${c.blackout === t ? '⚡' : ''}${c.locks.some((l) => t >= l.from && t <= l.to) ? '🔒' : ''}`;
    return `<button class="${cls.join(' ')}" data-t="${t}" title="관측된 방 ${seen}/${rooms}${planned ? `, 이번 루프 배치 ${planned}` : ''}${c.blackout === t ? ', 정전' : ''}">
      <span class="tick-time">${label}${marks ? ` <span class="tick-mark">${marks}</span>` : ''}</span>
      <span class="tick-bar"><i style="width:${(seen / rooms) * 100}%"></i></span>
      <span class="tick-pins">${'●'.repeat(planned)}</span>
    </button>`;
  }).join('');
}

function setViewTime(t) {
  viewTime = Math.max(0, Math.min(state.case.times.length - 1, t));
  if (selected) selected = { ...selected, time: viewTime };
  renderStage();
  renderRecord();
}

function cellAction(act, cell) {
  if (act === 'place') socket.emit('place', cell);
  if (act === 'unplace') socket.emit('unplace', cell);
  if (act === 'noise') socket.emit('noise', cell);
  if (act === 'unnoise') socket.emit('noise', {});
  if (act === 'unforge') socket.emit('forge', { ...cell, forge: null });
  if (act === 'forge') {
    const present = [...document.querySelectorAll('input[name="fg"]:checked')].map((x) => Number(x.value));
    socket.emit('forge', { ...cell, forge: { present, hideEvents: $('#fg-hide').checked } });
  }
}

$('#map').addEventListener('click', (e) => {
  const btn = e.target.closest('button.room');
  if (!btn) return;
  const cell = { place: Number(btn.dataset.p), time: Number(btn.dataset.t) };
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act) return cellAction(act, cell);
  selected = cell;
  pane = 'record';
  renderGame();
});
$('#timeline').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-t]');
  if (btn) setViewTime(Number(btn.dataset.t));
});
document.querySelector('.side-tabs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-pane]');
  if (!b) return;
  pane = b.dataset.pane;
  renderGame();
});
$('#btn-secret').onclick = () => {
  secretOpen = !secretOpen;
  renderGame();
};
// ← → 키로 시간을 옮긴다 (입력창에 쓰는 중이면 무시)
document.addEventListener('keydown', (e) => {
  if (!state || PHASE_SCREEN[state.phase] !== 'game' || state.phase !== 'plan') return;
  if (e.target.closest('input, textarea')) return;
  if (e.key === 'ArrowLeft') setViewTime(viewTime - 1);
  if (e.key === 'ArrowRight') setViewTime(viewTime + 1);
});

// 오른쪽 "노트" 패널: 관측된 사실만 모아 둔다. 누가 수상한지, 어느 시각이 진짜인지는 판단하지 않는다.
// 소리가 난 시각마다 용의자별로 30분 전 / 그 시각 / 30분 후에 찍힌 방을 나란히 보여 준다.

// 관측된 기록상 위치: who가 t에 찍힌 방들 (잡음 제외)
function placesAt(valid, who, t) {
  return [...new Set(valid.filter((o) => o.time === t && o.present.includes(who)).map((o) => o.place))];
}

function renderNote() {
  const c = state.case;
  const valid = state.observations.filter((o) => !o.noise);
  const rooms = c.places.length - 1;
  const timeLink = (t) => `<button class="link" data-goto="${t}">${c.times[t]}</button>`;
  const roomsSeen = (t) => new Set(valid.filter((o) => o.time === t).map((o) => o.place)).size;
  const cell = (who, t) => {
    if (t < 0 || t >= c.times.length) return '<td class="muted">-</td>';
    if (t === c.blackout) return '<td class="muted" title="정전">⚡</td>';
    const ps = placesAt(valid, who, t);
    return `<td>${ps.length ? ps.map((p) => `<span title="${esc(c.places[p])}">${esc(c.map.rooms[p].icon)}</span>`).join('') : '<span class="muted">?</span>'}</td>`;
  };

  const sounds = [...new Set(valid.filter((o) => o.events.some((e) => e.clue)).map((o) => o.time))].sort((a, b) => a - b);
  let html = '';

  // ① 소리
  html += `<div class="step"><p class="step-head"><span class="num">1</span> 현장 쪽 소리</p>`;
  html += sounds.length
    ? '<ul class="plain">' + sounds.map((t) => {
      const where = [...new Set(valid.filter((o) => o.time === t && o.events.some((e) => e.clue)).map((o) => o.place))];
      return `<li>${timeLink(t)} <span class="muted small">◆ ${where.map((p) => `${esc(c.map.rooms[p].icon)} ${esc(c.places[p])}`).join(', ')}</span></li>`;
    }).join('') + '</ul>'
    : '<p class="small muted">아직 찾지 못했어요.</p>';
  const rest = [];
  for (let t = c.window[0]; t <= c.window[1]; t++) if (!sounds.includes(t)) rest.push(`${timeLink(t)} <span class="muted small">${roomsSeen(t)}/${rooms}</span>`);
  if (rest.length) html += `<p class="small muted">추정 시간대 관측 현황: ${rest.join(' · ')}</p>`;
  html += '</div>';

  // ② 소리가 난 시각 전후의 위치 (판단 없이 기록만)
  html += `<div class="step"><p class="step-head"><span class="num">2</span> 그 시각 전후의 위치</p>`;
  if (!sounds.length) html += '<p class="small muted">소리를 찾으면, 그 시각과 30분 전후에 각자 어디 찍혔는지 여기 모여요.</p>';
  for (const t of sounds) {
    html += `<p class="sub-head">${timeLink(t)} <span class="muted small">방 ${roomsSeen(t)}/${rooms} 관측</span></p>
      <table class="mini"><thead><tr><th></th><th>${t > 0 ? c.times[t - 1] : ''}</th><th class="amber">${c.times[t]}</th><th>${t + 1 < c.times.length ? c.times[t + 1] : ''}</th></tr></thead><tbody>`;
    c.suspects.forEach((s, who) => {
      html += `<tr><th>${chip(who)}</th>${cell(who, t - 1)}${cell(who, t)}${cell(who, t + 1)}</tr>`;
    });
    html += '</tbody></table>';
  }
  html += '</div>';

  // ③ 추리 방법 (이름은 짚지 않는다)
  if (c.level > 1) html += `<div class="step"><p class="step-head"><span class="num">!</span> 이번 사건의 규칙</p>${ruleNotes(false)}</div>`;
  html += `<div class="step"><p class="step-head"><span class="num">3</span> 추리 방법</p>
    <p class="small muted">범인은 범행 시각 자기 기록을 아무도 없는 방으로 위조했어요. 사람은 30분에 통로로 이어진 옆방까지만 움직여요. 30분 만에 갈 수 없는 방에 찍힌 사람을 찾아 상단의 <b>고발</b>로 투표를 여세요.</p>
  </div>`;
  $('#pane-note').innerHTML = html;
}

$('#pane-note').addEventListener('click', (e) => {
  const b = e.target.closest('[data-goto]');
  if (b) setViewTime(Number(b.dataset.goto));
});

// 오른쪽 "기록" 패널: 선택한 방의 관측 기록과 (교수라면) 변조·노이즈
function renderRecord() {
  const el = $('#pane-record');
  if (!selected) {
    el.innerHTML = `<div class="hint">
      <p><b>방을 눌러</b> 기록을 보고 관측자를 놓으세요.</p>
      <p class="muted small">아래 타임라인으로 시각을 바꿔요. 노란 시각이 범행 추정 시간대예요. 모두 <b>배치 확정</b>을 누르면 그 밤이 다시 재생돼요.</p>
    </div>`;
    return;
  }
  const c = state.case;
  const { place, time } = selected;
  const k = ck(place, time);
  const prof = state.me.role === 'professor';
  const planning = state.phase === 'plan';
  const list = state.observations.filter((o) => o.place === place && o.time === time);
  const pl = state.placements.find((p) => p.place === place && p.time === time);
  const me = myPlayer();
  const { cells: badCells, people } = conflicts();
  const icon = c.map.rooms[place].icon;

  let html = `<h3 class="rec-title">${esc(icon)} ${esc(c.places[place])} <span class="rec-time${inWindow(time) ? ' amber' : ''}">${c.times[time]}</span></h3>`;
  if (!list.length) html += '<p class="muted">아직 관측된 적 없어요.</p>';
  for (const o of list) {
    html += `<div class="record${o.forged ? ' forged' : ''}"><p class="small muted">${o.loop}번째 재생 · ${esc(o.by)}${o.forged ? ' · <span class="red">변조됨</span>' : ''}</p>`;
    if (o.noise) {
      html += '<p class="static-text">▒▒ 신호 잡음. 기록을 읽지 못했다.</p>';
    } else if (o.blackout) {
      html += `<p class="dark">⚡ 정전. 사람 ${o.count}명이 있었다는 것만 남았다.</p>`;
      html += o.events.map((ev) => `<p class="event">◆ ${esc(ev.text)}</p>`).join('');
    } else {
      html += `<p>${o.present.length ? o.present.map((s) => `${chip(s)} ${esc(susName(s))}${people.has(`${s}:${time}`) ? ' <span class="red small">같은 시각 다른 곳에서도 보임</span>' : ''}`).join('<br>') : '<span class="muted">아무도 없었다.</span>'}</p>`;
      html += o.events.map((ev) => `<p class="event${ev.clue ? ' clue' : ''}">◆ ${esc(ev.text)}${ev.clue ? ' <span class="tag">현장 쪽 소리</span>' : ''}</p>`).join('');
    }
    html += '</div>';
  }
  if (badCells.has(k)) html += '<p class="red small">같은 방, 같은 시각인데 재생마다 결과가 달라요. 누군가 기록을 변조했어요.</p>';

  if (planning) {
    html += '<div class="row">';
    if (pl?.isMe) html += '<button class="btn ghost" data-act="unplace">관측 취소</button>';
    else if (pl) html += `<p class="muted">${esc(pl.name)}님이 관측 예정</p>`;
    else if (me.placed < me.quota) html += `<button class="btn primary" data-act="place">${list.length ? '다시 관측하기' : '관측자 놓기'}</button>`;
    else html += '<p class="muted small">이번 루프 관측자를 다 놓았어요.</p>';
    if (prof) {
      const sec = state.secret;
      if (sec.noiseCell === k) html += '<button class="btn ghost" data-act="unnoise">노이즈 해제</button>';
      else if (sec.charges.noise > 0) html += '<button class="btn danger" data-act="noise">노이즈 걸기</button>';
    }
    html += '</div>';
    if (prof && pl?.isMe) html += forgeEditor(pl);
  }
  el.innerHTML = html;
}

function forgeEditor(pl) {
  const sec = state.secret;
  // 기록상 위치 기준 (범인의 가짜 알리바이 칸에는 범인이 찍혀 있다)
  const shown = (s, t) => (s === sec.culprit && t === sec.fake.time ? sec.fake.place : sec.presence[s][t]);
  const truth = sec.presence.map((_, s) => (shown(s, selected.time) === selected.place ? s : -1)).filter((s) => s >= 0);
  const current = pl.forge?.present ?? truth;
  const canForge = pl.forge || sec.charges.forge > state.placements.filter((p) => p.isMe && p.forge).length;
  if (!canForge) return '<p class="muted small">변조 기회를 다 썼어요.</p>';
  return `<div class="forge">
    <p class="kicker red">// 기록 변조 (교수 전용)</p>
    <p class="small muted">실제 기록: ${truth.map((s) => esc(susName(s))).join(', ') || '아무도 없음'}</p>
    <div class="forge-list">${state.case.suspects.map((s, i) => `<label class="check"><input type="checkbox" name="fg" value="${i}" ${current.includes(i) ? 'checked' : ''}>${chip(i)} ${esc(s.name)}</label>`).join('')}</div>
    <label class="check"><input type="checkbox" id="fg-hide" ${pl.forge?.hideEvents ? 'checked' : ''}> 기록 문장 숨기기</label>
    <div class="row">
      <button class="btn danger" data-act="forge">${pl.forge ? '변조 내용 바꾸기' : '이대로 변조'}</button>
      ${pl.forge ? '<button class="btn ghost" data-act="unforge">변조 취소</button>' : ''}
    </div>
    ${pl.forge ? '<p class="small red">이 칸은 변조된 결과로 공개돼요.</p>' : ''}
  </div>`;
}

$('#pane-record').addEventListener('click', (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act && selected) cellAction(act, { place: selected.place, time: selected.time });
});

// 오른쪽 "동선" 패널: 용의자 × 시각. 좁은 패널에 맞게 장소는 방 이모지로 보여 준다
function renderRoutes() {
  const c = state.case;
  const { people, seenAt } = conflicts();
  const hour = (label) => label.replace(':00', '').replace(':30', '½');
  let html = `<thead><tr><th></th>${c.times.map((t, i) => `<th class="${inWindow(i) ? 'win' : ''}" title="${t}">${hour(t)}</th>`).join('')}</tr></thead><tbody>`;
  c.suspects.forEach((s, i) => {
    html += `<tr><th title="${esc(s.name)}">${chip(i)}</th>`;
    c.times.forEach((_, t) => {
      const places = [...(seenAt.get(`${i}:${t}`) ?? [])];
      const bad = people.has(`${i}:${t}`);
      const cell = places.map((p) => `<span title="${esc(c.places[p])}">${esc(c.map.rooms[p].icon)}</span>`).join('');
      html += `<td class="${bad ? 'bad' : ''}${inWindow(t) ? ' win' : ''}">${cell || '<span class="muted">·</span>'}</td>`;
    });
    html += '</tr>';
  });
  $('#routes').innerHTML = html + '</tbody>';
  $('#routes-key').innerHTML = c.map.rooms.slice(1).map((r, i) => `${esc(r.icon)} ${esc(c.places[i + 1])}`).join(' · ');
}

// 고발 투표에서 고르는 중인 표. 범인을 고르기 전에는 수단·동기만 기억해 두고, 범인을 고르면 함께 보낸다
let voteDraft = null;

function renderVote() {
  const v = state.phase === 'vote' ? state.vote : null;
  $('#vote').hidden = !v;
  if (!v) {
    voteDraft = null;
    return;
  }
  const c = state.case;
  const TEXT = {
    accuse: ['// 고발 투표', `${esc(v.proposer)}님이 고발 투표를 열었다`, '과반이 같은 용의자를 고르면 바로 고발돼요. 고발은 한 번뿐이고, 확신이 없으면 보류하세요. 수단과 동기도 맞히면 각각 +30점이에요.'],
    final: ['// 최종 고발', '모든 재생이 끝났다', '가장 많은 표를 받은 용의자를 고발해요. 동률이면 고발하지 못해요. 수단과 동기도 맞히면 각각 +30점이에요.'],
    unmask: ['// 교수 지목', '범인을 맞혔다. 교수는 누구인가?', '가장 많은 표를 받은 사람을 지목해요. 동률이면 교수는 도주해요.'],
  }[v.kind];
  $('#vote-kicker').textContent = TEXT[0];
  $('#vote-title').innerHTML = TEXT[1];
  $('#vote-desc').textContent = TEXT[2];

  let html;
  if (v.kind === 'unmask') {
    const myName = state.me.name;
    html = state.roster.map((name, i) => (name === myName ? '' : `<button class="vote-opt${v.mine === i ? ' on' : ''}" data-unmask="${i}">${esc(name)}</button>`)).join('');
  } else {
    if (!voteDraft) voteDraft = { suspect: null, method: null, motive: null, ...(v.mine ?? {}) };
    const d = voteDraft;
    const opt = (field, value, label) => `<button class="vote-opt${d[field] === value ? ' on' : ''}" data-field="${field}" data-value="${esc(JSON.stringify(value))}">${label}</button>`;
    html = '<p class="label">범인</p><div class="vote-group">'
      + c.suspects.map((s, i) => opt('suspect', i, `${chip(i)} ${esc(s.name)} <span class="muted small">${esc(s.role)}</span>`)).join('')
      + (v.kind === 'accuse' ? opt('suspect', 'pass', '보류') : '')
      + '</div><p class="label">범행 수단 <span class="muted">(선택)</span></p><div class="vote-group chips">'
      + c.options.methods.map((m) => opt('method', m, esc(m))).join('')
      + '</div><p class="label">동기 <span class="muted">(선택)</span></p><div class="vote-group">'
      + c.options.motives.map((m) => opt('motive', m, esc(m))).join('')
      + '</div>';
  }
  $('#vote-options').innerHTML = html;
  const total = state.players.filter((p) => p.connected).length;
  $('#vote-status').textContent = `투표 ${v.voted.length}/${total}${v.voted.length ? ` · ${v.voted.join(', ')}` : ''} · 다시 누르면 표를 바꿀 수 있어요`;
}

$('#vote-options').addEventListener('click', (e) => {
  const u = e.target.closest('[data-unmask]');
  if (u) return socket.emit('vote', Number(u.dataset.unmask));
  const b = e.target.closest('[data-field]');
  if (!b) return;
  const value = JSON.parse(b.dataset.value);
  // 같은 수단·동기를 다시 누르면 선택을 지운다
  voteDraft[b.dataset.field] = b.dataset.field !== 'suspect' && voteDraft[b.dataset.field] === value ? null : value;
  if (voteDraft.suspect !== null) socket.emit('vote', voteDraft);
  renderVote();
});

// ---------- 결과 화면: 그날 밤 다시 재생 ----------
// 진짜 동선으로 용의자 칩을 방마다 옮긴다. 범행 시각에는 범인이 현장에 있고, 위조된 기록 자리에 깨진 칩이 뜬다.
let replay = { key: null, t: 0, timer: null, playing: false };
const REPLAY_STEP_MS = 1500;

function startReplayOnce() {
  const key = `${state.code}:${state.case.title}:${state.result.crimeTime}`;
  if (replay.key === key) return;
  stopReplay();
  replay = { key, t: 0, timer: null, playing: false };
  renderMap($('#replay-map'), null, null);
  // 화면 높이 안에 지도가 다 보이게 너비를 제한한다
  const m = state.case.map;
  $('#replay-wrap').style.maxWidth = `calc((100dvh - 230px) * ${m.aspect[0] / m.aspect[1]})`;
  $('#replay-map').classList.add('replaying');
  // 칩은 한 번만 만들고 위치만 바꿔서 방 사이를 움직이게 한다
  $('#replay-layer').innerHTML = state.case.suspects.map((_, i) => `<span class="rchip s${i}" data-i="${i}">${esc(initial(susName(i)))}</span>`).join('')
    + state.result.fakes.map((f) => `<span class="rchip fake s${state.result.culprit}" data-ft="${f.time}" hidden>${esc(initial(susName(state.result.culprit)))}<em>위조 기록</em></span>`).join('');
  showReplayStep(0);
  playReplay();
}

function playReplay() {
  replay.playing = true;
  $('#btn-replay').textContent = '⏸ 멈춤';
  clearInterval(replay.timer);
  replay.timer = setInterval(() => {
    const last = state.case.times.length - 1;
    if (replay.t >= last) {
      // 끝까지 재생하면 범행 시각에서 멈춘다
      stopReplay();
      showReplayStep(state.result.crimeTime);
      return;
    }
    showReplayStep(replay.t + 1);
  }, REPLAY_STEP_MS);
}

function stopReplay() {
  clearInterval(replay.timer);
  replay.playing = false;
  const btn = $('#btn-replay');
  if (btn) btn.textContent = '▶ 재생';
}

function showReplayStep(t) {
  if (!state?.result) return;
  replay.t = t;
  const r = state.result;
  const c = state.case;
  const rooms = c.map.rooms;
  const crime = t === r.crimeTime;
  // 방마다 그 시각에 있던 사람을 모아 가운데에 나란히 놓는다
  // 위조 칩도 그 방의 한 자리로 쳐서 간격을 계산한다 (공범 칩과 겹치지 않게)
  const byRoom = new Map();
  r.presence.forEach((row, i) => {
    if (!byRoom.has(row[t])) byRoom.set(row[t], []);
    byRoom.get(row[t]).push(i);
  });
  const fakeNow = r.fakes.find((f) => f.time === t);
  const slots = (p) => (byRoom.get(p) ?? []).length + (fakeNow && fakeNow.place === p ? 1 : 0);
  // 같은 방에 여럿이면 32px 간격으로 나란히 (좁은 화면에서도 겹치지 않게 픽셀로)
  const spot = (p, k, n) => {
    const room = rooms[p];
    return { x: `calc(${room.x + room.w / 2}% + ${(k - (n - 1) / 2) * 32}px)`, y: `${room.y + room.h / 2 + 6}%` };
  };
  for (const [p, list] of byRoom) {
    list.forEach((i, k) => {
      const el = document.querySelector(`#replay-layer .rchip[data-i="${i}"]`);
      const { x, y } = spot(p, k, slots(p));
      el.style.left = x;
      el.style.top = y;
      const forgedNow = r.fakes.some((f) => f.time === t);
      el.classList.toggle('culprit', forgedNow && i === r.culprit);
      el.classList.toggle('accomplice', crime && i === r.accomplice);
    });
  }
  // 위조 기록: 그 시각에만 위조된 방에 깨진 칩을 띄운다 (공범이 있으면 그 옆에)
  for (const el of document.querySelectorAll('#replay-layer .rchip.fake')) {
    const f = r.fakes.find((x) => x.time === Number(el.dataset.ft));
    el.hidden = f.time !== t;
    if (f.time === t) {
      const n = (byRoom.get(f.place) ?? []).length;
      const { x, y } = spot(f.place, n, slots(f.place));
      el.style.left = x;
      el.style.top = y;
    }
  }
  $('#replay-map').classList.toggle('crime-now', crime);

  $('#replay-timeline').innerHTML = c.times.map((label, i) => {
    const cls = ['tick', i === t ? 'on' : '', i === r.crimeTime ? 'crime' : '', i === r.decoyTime ? 'win' : ''].join(' ');
    return `<button class="${cls}" data-rt="${i}"><span class="tick-time">${label}</span></button>`;
  }).join('');

  const name = esc(susName(r.culprit));
  const where = (p) => (p === 0 ? `현장(${esc(c.places[0])})` : esc(c.places[p]));
  let caption = `${c.times[t]} · 그날 밤`;
  const accompliceNote = r.accomplice !== null ? ` 공범 ${esc(susName(r.accomplice))}이(가) 그 자리에 함께 있었다고 거짓 증언했다.` : '';
  const second = r.fakes.find((f) => f.time === t && t !== r.crimeTime);
  if (crime) caption = `<b class="red">${c.times[t]} · 범행 시각.</b> ${name}은(는) ${esc(c.places[0])}에 있었다. 기록에는 ${esc(c.places[r.fake.place])}에 있던 것처럼 위조돼 있었다.${accompliceNote}`;
  else if (second) caption = `<b class="red">${c.times[t]} · 두 번째 위조.</b> ${name}은(는) 실제로 ${where(r.presence[r.culprit][t])}에 있었지만, 기록에는 ${esc(c.places[second.place])}에 있던 것처럼 남겼다.`;
  else if (t === r.decoyTime) caption = `${c.times[t]} · ${esc(c.places[0])} 쪽에서 소리가 났지만, 이때 현장은 비어 있었다.`;
  else if (Math.abs(t - r.crimeTime) === 1) caption = `${c.times[t]} · ${name}은(는) ${where(r.presence[r.culprit][t])}에 있었다.`;
  $('#replay-caption').innerHTML = caption;
}

$('#btn-replay').onclick = () => {
  if (replay.playing) return stopReplay();
  if (replay.t >= state.case.times.length - 1) showReplayStep(0);
  playReplay();
};
$('#replay-timeline').addEventListener('click', (e) => {
  const b = e.target.closest('[data-rt]');
  if (!b) return;
  stopReplay();
  showReplayStep(Number(b.dataset.rt));
});

// 수단·동기: 고른 것과 정답
function answerLine(label, picked, truth) {
  const mark = picked == null ? '<span class="muted">고르지 않음</span>' : picked === truth ? '<span class="accent">✓ 맞힘</span>' : `<span class="red">✗ ${esc(picked)}</span>`;
  return `${label} <b>${esc(truth)}</b> ${mark}`;
}

function renderResult() {
  const r = state.result;
  const c = state.case;
  const o = r.outcome;
  const rep = r.report ?? {};
  $('#result-head').className = `card result-head ${o.detectivesWin ? 'win' : 'lose'}`;
  $('#result-head').innerHTML = `<p class="kicker">// 수사 종료</p>
    <h2>${esc(o.title)}</h2>
    ${o.detectivesWin ? `<p class="score">점수 <b>${o.score}</b></p>` : ''}
    <p>진범: ${chip(r.culprit)} <b>${esc(susName(r.culprit))}</b> · 범행 시각 ${c.times[r.crimeTime]} · ${esc(c.places[0])}</p>
    ${state.accusation ? `<p class="muted">고발: ${esc(susName(state.accusation.suspect))} (${state.accusation.loopsDone ? `${state.accusation.loopsDone}번째 재생 뒤` : '첫 재생 전'})</p>` : '<p class="muted">고발하지 못했다.</p>'}
    <p class="answers">${answerLine('범행 수단', state.accusation?.method, r.answer.method)} · ${answerLine('동기', state.accusation?.motive, r.answer.motive)}</p>
    ${r.accomplice !== null ? `<p>공범: ${chip(r.accomplice)} <b>${esc(susName(r.accomplice))}</b> · 범인의 위조 기록에 함께 찍혀 알리바이를 대 줬다</p>` : ''}
    ${r.professor ? `<p>교수는 <b class="red">${esc(r.professor)}</b>${r.unmask ? (r.unmask.caught ? ' · 정체가 밝혀졌다' : ` · 도주 (지목: ${esc(r.unmask.target ?? '없음')})`) : ''}</p>` : ''}`;

  $('#result-report').innerHTML = `<p class="kicker">// 수사 보고서</p>
    <h3>${esc(rep.headline)}</h3>
    <p class="label">사건의 전말</p><p>${esc(rep.story)}</p>
    <p class="small muted">진범의 동선: ${esc(rep.route)}</p>
    <p class="label">수사 기록</p><p>${esc(rep.investigation)}</p>
    ${rep.professor ? `<p class="label">교수의 행적</p><p>${esc(rep.professor)}</p>` : ''}
    <p class="label">요원 평가</p>
    <ul class="notes">${(rep.playerNotes ?? []).map((n) => `<li><b>${esc(n.name)}</b> ${esc(n.note)}</li>`).join('')}</ul>
    <p class="small muted">동기: ${esc(r.motive)} 방법: ${esc(r.method)}</p>`;

  const forged = new Set(state.observations.filter((x) => x.forged).map((x) => `${x.place}:${x.time}`));
  let html = `<thead><tr><th></th>${c.times.map((t, i) => `<th class="${i === r.crimeTime ? 'crime' : ''}">${t}</th>`).join('')}</tr></thead><tbody>`;
  r.presence.forEach((row, s) => {
    html += `<tr class="${s === r.culprit ? 'culprit' : ''}"><th>${chip(s)} ${esc(susName(s))}</th>`;
    row.forEach((p, t) => {
      const cls = [p === 0 ? 'red' : '', t === r.crimeTime ? 'crime' : '', forged.has(`${p}:${t}`) ? 'forged' : ''].join(' ');
      const fake = s === r.culprit && t === r.fake.time ? `<br><span class="small muted">기록상 ${esc(c.places[r.fake.place])}</span>` : '';
      html += `<td class="${cls}">${esc(c.places[p])}${fake}</td>`;
    });
    html += '</tr>';
  });
  $('#truth').innerHTML = html + '</tbody>';
  startReplayOnce();
  $('#btn-again').hidden = !state.me.isHost;
}

// ---------- 소리 설정 (왼쪽 아래 버튼 → 켜기/끄기, 배경음악·효과음 볼륨) ----------
const musicBtn = $('#btn-music');
const soundPanel = $('#sound-panel');
function renderMusicBtn(status) {
  musicBtn.classList.toggle('off', status === 'off');
  musicBtn.classList.toggle('blocked', status === 'blocked');
  musicBtn.querySelector('span').textContent = status === 'off' ? '소리 꺼짐' : status === 'blocked' ? '눌러서 소리 켜기' : '소리';
  $('#btn-sound-toggle').setAttribute('aria-checked', String(status !== 'off'));
  for (const kind of ['music', 'sfx']) {
    $(`#vol-${kind}`).value = window.Music.volume(kind);
    $(`#vol-${kind}-out`).textContent = window.Music.volume(kind);
    $(`#vol-${kind}`).disabled = status === 'off';
  }
}
if (window.Music) {
  renderMusicBtn(window.Music.status());
  window.Music.onChange(renderMusicBtn);
  musicBtn.onclick = () => {
    // 이 클릭으로 막 소리가 풀린 거라면 창은 열지 않는다
    if (window.Music.justUnlocked()) return renderMusicBtn(window.Music.status());
    soundPanel.hidden = !soundPanel.hidden;
    musicBtn.setAttribute('aria-expanded', String(!soundPanel.hidden));
    renderMusicBtn(window.Music.status());
  };
  $('#btn-sound-toggle').onclick = () => window.Music.toggle();
  for (const kind of ['music', 'sfx']) {
    const input = $(`#vol-${kind}`);
    input.oninput = () => {
      window.Music.setVolume(kind, input.value);
      $(`#vol-${kind}-out`).textContent = input.value;
    };
  }
  // 효과음은 손을 뗄 때 한 번 들려준다
  $('#vol-sfx').onchange = () => window.Music.preview();
  // 창 밖을 누르면 닫는다
  document.addEventListener('pointerdown', (e) => {
    if (!soundPanel.hidden && !e.target.closest('#sound-panel, #btn-music')) {
      soundPanel.hidden = true;
      musicBtn.setAttribute('aria-expanded', 'false');
    }
  });
} else {
  musicBtn.hidden = true;
}

render();
