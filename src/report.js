// 결과 리포트. AI를 부르지 않고 서버가 만든다.
// 사건의 전말은 사건을 만들 때 AI가 미리 써 두었고(flavor.story),
// 이번 판의 수사 기록과 요원 평가는 서버가 가진 관측·투표 기록으로 정리한다.
import { timeLabel, SCENE } from './puzzle.js';
import { outcome } from './game.js';

// 고발할 때 고른 수단·동기가 맞았는지
function accusationExtras(game) {
  const a = game.accusation;
  const { answer } = game.case;
  const part = (label, picked, ok, truth) =>
    picked === null ? ` ${label}은(는) 고르지 않았다(정답: ${truth}).` : ok ? ` ${label} "${picked}"을(를) 맞혔다.` : ` ${label}은(는) "${picked}"(으)로 골랐지만 정답은 "${truth}"였다.`;
  return part('범행 수단', a.method, a.methodCorrect, answer.method) + part('동기', a.motive, a.motiveCorrect, answer.motive);
}

export function buildReport(game) {
  const s = game.case.structure;
  const f = game.case.flavor;
  const nameOf = (key) => game.roster.find((p) => p.key === key)?.name ?? '(나간 요원)';
  const sus = (i) => f.suspects[i].name;
  const at = (place, time) => `${timeLabel(time)} ${f.places[place]}`;
  const o = outcome(game);
  const real = game.observations.filter((x) => !x.noise && !x.forged);

  // 결정적 관측: 범행 시각 단서를 처음 본 사람, 범행 시각에 각 용의자의 알리바이를 처음 확인한 사람
  const timeClue = real.find((x) => x.events.some((e) => s.events[e].kind === 'time'));
  const alibis = s.presence
    .map((row, i) => ({ i, place: row[s.crimeTime] }))
    .filter((a) => a.i !== s.culprit)
    .map((a) => ({ ...a, found: real.find((x) => x.time === s.crimeTime && x.place === a.place) }));
  const found = alibis.filter((a) => a.found);

  // 변조를 드러낸 재관측: 교수가 변조한 칸을 나중에 다른 사람이 다시 본 경우
  const exposed = game.log.forges
    .map((fg) => ({ fg, by: real.find((x) => x.place === fg.place && x.time === fg.time && x.loop > fg.loop) }))
    .filter((x) => x.by);

  // 가짜 소리: 찾았는지, 그 시각에 다섯 명을 다 확인해 가려냈는지
  const decoyHeard = real.find((x) => x.events.some((e) => s.events[e].kind === 'decoy'));
  const decoyNote = decoyHeard ? `${timeLabel(s.decoyTime)}의 소리는 범행과 무관한 소리였다.` : '';

  // 범인의 가짜 알리바이: 그 칸과, 이어지지 않는 직전·직후 칸을 둘 다 봤으면 간파한 것
  const fakeSeen = real.find((x) => x.place === s.fake.place && x.time === s.fake.time);
  const flawSeen = [s.crimeTime - 1, s.crimeTime + 1]
    .map((t) => ({ t, p: s.presence[s.culprit][t] }))
    .filter(({ p }) => p !== SCENE && p !== s.fake.place && !s.adj[p].includes(s.fake.place))
    .map(({ t, p }) => real.find((x) => x.time === t && x.place === p))
    .find(Boolean);
  const fakeNote = fakeSeen && flawSeen
    ? `${sus(s.culprit)}의 가짜 알리바이(${at(s.fake.place, s.fake.time)})는 ${at(flawSeen.place, flawSeen.time)}에서 갈 수 없는 곳이라 들통났다.`
    : `${sus(s.culprit)}은(는) ${at(s.fake.place, s.fake.time)}에 있었던 것처럼 기록을 위조했다.`;

  // 난이도 규칙이 사건에 어떻게 쓰였는지
  const ruleNote = [
    s.accomplice !== null ? `공범 ${sus(s.accomplice)}은(는) 위조 기록에 함께 찍혀 거짓 알리바이를 대 줬다.` : '',
    ...s.locks.map((l) => `${timeLabel(l.from)}~${timeLabel(l.to)} 동안 ${f.places[l.a]}와 ${f.places[l.b]} 사이 문이 잠겨 있었는데, 범인의 위조 기록은 그 문을 지나간 셈이었다.`),
    s.fakes.length > 1 ? `범인은 ${s.fakes.map((x) => timeLabel(x.time)).join('과 ')} 두 칸을 위조해 허점을 범행 시각 밖으로 밀어냈다.` : '',
  ].filter(Boolean).join(' ');

  const route = s.presence[s.culprit].map((p, t) => `${timeLabel(t)} ${f.places[p]}`).join(' → ');
  const story = f.story
    ?? `${sus(s.culprit)}은(는) ${timeLabel(s.crimeTime)}에 ${f.places[SCENE]}에 있었다. ${f.motive} ${f.method} 그리고 그 시각 자기 기록을 ${f.places[s.fake.place]}에 있었던 것처럼 위조했다.`;

  const investigation = [
    game.accusation
      ? `${game.accusation.loopsDone ? `${game.accusation.loopsDone}번째 재생 뒤` : '첫 재생도 하기 전에'} ${sus(game.accusation.suspect)}을(를) 고발했다.${accusationExtras(game)}`
      : '끝내 고발하지 못했다.',
    timeClue
      ? `${nameOf(timeClue.by)}이(가) ${timeClue.loop}번째 재생에서 범행 시각 단서(${at(timeClue.place, timeClue.time)})를 찾았다.`
      : `범행 시각(${timeLabel(s.crimeTime)})을 알려 주는 기록은 아무도 보지 못했다.`,
    fakeNote,
    ruleNote,
    decoyNote,
    `범행 시각의 알리바이 ${alibis.length}개 중 ${found.length}개를 확인했다.`
      + (found.length < alibis.length ? ` 놓친 곳: ${alibis.filter((a) => !a.found).map((a) => `${sus(a.i)}(${f.places[a.place]})`).join(', ')}.` : ''),
  ].filter(Boolean).join(' ');

  let professor = '';
  if (game.professorKey) {
    const parts = [`교수는 ${nameOf(game.professorKey)}였다.`];
    for (const fg of game.log.forges) {
      const shown = fg.shownPresent.map(sus).join(', ') || '아무도 없음';
      const truth = fg.truePresent.map(sus).join(', ') || '아무도 없음';
      parts.push(`${fg.loop}번째 재생에서 ${at(fg.place, fg.time)} 기록을 "${truth}"에서 "${shown}"(으)로 바꿨다.`);
    }
    for (const n of game.log.noise) {
      parts.push(`${n.loop}번째 재생에서 ${at(n.place, n.time)}에 노이즈를 걸었다${n.blocked ? `(${nameOf(n.blocked)}의 관측을 막음)` : ''}.`);
    }
    if (!game.log.forges.length && !game.log.noise.length) parts.push('변조도 노이즈도 쓰지 않고 말로만 수사를 흔들었다.');
    for (const x of exposed) parts.push(`${nameOf(x.by.by)}이(가) 같은 칸을 다시 관측해 변조를 드러냈다.`);
    if (game.unmask) parts.push(game.unmask.caught ? '마지막 투표에서 정체가 밝혀졌다.' : '마지막 투표를 피해 도주했다.');
    professor = parts.join(' ');
  }

  // 요원 평가: 그 사람이 한 일 중 가장 결정적인 것 하나를 고른다
  const playerNotes = game.roster.map((p) => {
    const mine = game.observations.filter((x) => x.by === p.key);
    if (p.key === game.professorKey) {
      const n = game.log.forges.length + game.log.noise.length;
      return { name: p.name, note: game.unmask?.caught ? `교수. 방해 ${n}회 끝에 정체가 들켰다.` : `교수. 방해 ${n}회, 끝까지 정체를 숨겼다.` };
    }
    const notes = [];
    if (timeClue?.by === p.key) notes.push('범행 시각을 찾아냈다');
    if (exposed.some((x) => x.by.by === p.key)) notes.push('교수의 변조를 간파했다');
    const myAlibis = found.filter((a) => a.found.by === p.key).length;
    if (myAlibis) notes.push(`알리바이 ${myAlibis}개 확인`);
    return { name: p.name, note: `${notes.join(', ') || '결정적 관측은 없었다'} · 관측 ${mine.length}회` };
  });

  return {
    headline: `${o.title}: 진범은 ${sus(s.culprit)}`,
    story,
    route,
    investigation,
    professor,
    playerNotes,
  };
}
