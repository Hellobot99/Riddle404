import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import { SUSPECTS, timeLabel } from './puzzle.js';
import { ITEMS, MOTIVES, itemEvidence, motiveNote, shuffled } from './fallback.js';

const API_KEY = process.env.GEMINI_API_KEY;
// AI는 사건을 만들 때 한 번만 부른다 (미리 만들어 두므로 느려도 괜찮다).
// 좋은 모델을 먼저 쓰고, 실패하면 Lite로 넘어간다.
const CASE_MODEL = process.env.GEMINI_MODEL || 'gemini-flash-latest';
const FALLBACK_MODEL = 'gemini-flash-lite-latest';

const ai = API_KEY ? new GoogleGenAI({ apiKey: API_KEY }) : null;
export const mockMode = !ai;

const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function generateJson({ models, fast }, systemInstruction, prompt, schema) {
  let lastError;
  for (const model of [...new Set(models)]) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await ai.models.generateContent({
          model,
          contents: prompt,
          config: {
            systemInstruction,
            responseMimeType: 'application/json',
            responseJsonSchema: schema,
            ...(fast && { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } }),
          },
        });
        if (!response.text) {
          const reason = response.promptFeedback?.blockReason ?? response.candidates?.[0]?.finishReason;
          throw new Error(`응답 거부: ${reason ?? '알 수 없음'}`);
        }
        return JSON.parse(response.text);
      } catch (err) {
        lastError = err;
        // 서버 과부하와 깨진 JSON은 다시 시도하고, 그 밖의 오류(키 오류, 응답 거부 등)는 바로 올린다
        if (!RETRYABLE.has(err?.status) && !(err instanceof SyntaxError)) throw err;
        console.warn(`${model} 응답 실패(${err.status ?? 'JSON'}), ${attempt === 0 ? '재시도' : '다음 모델로'}`);
        await sleep(1000 + attempt * 2000);
      }
    }
  }
  throw lastError;
}

const WORLD = `세계관: 모든 기록을 서버가 관리하는 도시. 사건이 난 밤의 기록이 대량 삭제됐고, 플레이어는 그 밤을 다시 재생해 남은 기록을 관측하는 "복원 요원"이다.
사건 현장의 기록은 완전히 지워져 404로만 남아 있다.`;

// ---------- 사건 문장 ----------

const CASE_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: '사건 제목. 15자 이내. 예: "산장 서재의 마지막 손님"' },
    intro: { type: 'string', description: '브리핑. 무슨 일이 있었는지 2~3문장. 범인이나 범행 시각은 밝히지 않는다' },
    victim: { type: 'string', description: '정해진 피해자 이름과 한 줄 소개. 예: "한도윤 (산장 주인)"' },
    suspects: {
      type: 'array', minItems: SUSPECTS, maxItems: SUSPECTS,
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '정해진 용의자 이름을 그대로' },
          role: { type: 'string', description: '피해자와의 관계나 직업, 8자 이내' },
          profile: { type: 'string', description: '한 문장 소개. 누구나 의심할 만한 구석을 하나씩 준다' },
        },
        required: ['name', 'role', 'profile'],
      },
    },
    motive: { type: 'string', description: '진범의 동기 1~2문장' },
    method: { type: 'string', description: '진범의 범행 방법 1~2문장. 진범 증거 기록의 물건을 쓴 방법' },
    motives: {
      type: 'array', minItems: 4, maxItems: 4,
      description: '고발할 때 고르는 동기 선택지 4개. 첫 번째가 진범의 진짜 동기, 나머지 셋은 그럴듯한 가짜',
      items: {
        type: 'object',
        properties: {
          key: { type: 'string', description: '동기를 상징하는 물건이나 문서 이름, 2~6자. 예: "유언장", "차용증"' },
          text: { type: 'string', description: '동기 한 문장, 30자 이내. 예: "피해자가 유언장에서 자신을 빼려 했다"' },
        },
        required: ['key', 'text'],
      },
    },
    eventItems: { type: 'array', items: { type: 'string' }, description: '기록 목록과 같은 순서, 같은 개수. 증거 기록이면 거기 등장한 물건 이름(2~6자), 아니면 빈 문자열' },
    story: { type: 'string', description: '게임이 끝나고 공개할 사건의 전말. 진범의 동선을 따라 언제 어디서 무엇을 했고 왜 그랬는지 4~5문장' },
    eventTexts: { type: 'array', items: { type: 'string' }, description: '기록 목록과 같은 순서, 같은 개수의 기록 문장' },
  },
  required: ['title', 'intro', 'victim', 'suspects', 'motive', 'method', 'motives', 'story', 'eventTexts', 'eventItems'],
};

const EVENT_GUIDE = {
  time: '범행 시각 단서. 현장 쪽에서 들린 소리, 정전, 비명처럼 "지금 현장에서 무슨 일이 났다"는 걸 분명히 알 수 있는 기록. 현장 이름을 문장에 넣는다',
  decoy: '현장 쪽에서 난 소리 기록. 실제로는 범행과 무관한 소리지만, 문장만으로는 범행 시각 단서와 구별되지 않게 비슷한 말투로 쓴다. 무관하다는 이유나 정체는 쓰지 않는다. 현장 이름을 문장에 넣는다',
  suspicious: '증거 기록. 이 사람이 물건 하나를 다루는 수상한 모습. 반드시 그 사람 이름으로 문장을 시작하고 물건 이름을 그대로 넣는다 (예: "민서희가 가죽 장갑을 …"). 물건 이름은 eventItems에 쓰고, 증거 기록끼리 물건이 겹치면 안 된다',
  motive: '동기 단서 기록. 쪽지, 통화, 서류처럼 진범의 진짜 동기를 짐작하게 하는 기록. motives 첫 번째의 key를 문장에 그대로 넣고, 인물 이름은 쓰지 않는다',
  flavor: '분위기용 기록. 사건과 상관없는 사소한 일, 사람 이름은 넣지 않는다',
};

/**
 * 서버가 만든 사건 구조와 지도(테마, 방 이름)에 인물과 문장을 입힌다.
 * @param {import('./puzzle.js').Structure} s
 * @param {string} theme
 * @param {string[]} places 0번이 사건 현장
 * @param {{victim: string, suspects: string[]}} names 서버가 정한 이름 (AI가 짓지 않는다)
 */
export async function writeCase(s, theme, places, names) {
  if (mockMode) return null;
  const list = s.events.map((e, i) => {
    const who = e.who === null ? '' : `, 인물: 용의자${e.who + 1}${e.who === s.culprit ? '(진범. 이 물건이 진짜 범행 수단이지만 문장에서 범행을 드러내지 말 것)' : ''}`;
    return `${i + 1}. ${places[e.place]}, ${timeLabel(e.time)}${who} - ${EVENT_GUIDE[e.kind]}`;
  }).join('\n');
  const r = await generateJson(
    { models: [CASE_MODEL, FALLBACK_MODEL], fast: false },
    `당신은 협동 추리 게임의 사건 작가입니다. ${WORLD}
사건의 논리(누가 언제 어디 있었는지, 범인)는 이미 정해져 있고, 당신은 거기에 어울리는 이름과 문장만 씁니다. 모든 출력은 한국어입니다.`,
    `배경 테마: ${theme}
장소: ${places.join(', ')} (이 이름을 그대로 쓰고, 첫 번째 "${places[0]}"이 사건 현장이자 피해자가 발견된 곳)
진범: 용의자${s.culprit + 1}
범행 시각: ${timeLabel(s.crimeTime)}, ${places[0]}
진범의 그날 밤 동선: ${s.presence[s.culprit].map((p, t) => `${timeLabel(t)} ${places[p]}`).join(' → ')}
진범의 위장: ${s.fakes.map((f) => `${timeLabel(f.time)} 기록을 ${places[f.place]}에 있었던 것처럼`).join(', ')} 위조했다 (story에 이 위장과, 왜 들킬 수밖에 없었는지를 넣는다)
${s.accomplice !== null ? `공범: 용의자${s.accomplice + 1}이 범행 시각 위조 기록에 함께 찍혀 진범의 알리바이를 대 줬다 (story에 넣는다. 공범은 살해에는 가담하지 않았다)
` : ''}${s.locks.map((l) => `잠긴 문: ${timeLabel(l.from)}~${timeLabel(l.to)} 동안 ${places[l.a]}와 ${places[l.b]} 사이 문이 잠겨 있었다 (진범은 이걸 몰라서 들켰다)
`).join('')}${s.blackout !== null ? `정전: ${timeLabel(s.blackout)}에 정전이 나서 그 시각 기록에는 사람 수만 남았다
` : ''}
아래 기록 목록에 들어갈 문장을 같은 순서로 하나씩 써 주세요. 각 문장은 40자 이내의 한 문장이고, 시각과 장소는 화면에 따로 보이니 문장에 쓰지 않습니다(범행 시각 단서는 현장 이름만 넣습니다).
인물 이름은 이미 정해져 있으니 그대로 씁니다. 피해자: ${names.victim} / ${names.suspects.map((n, i) => `용의자${i + 1}: ${n}`).join(', ')}
용의자는 "용의자N" 대신 위 이름으로 씁니다.
${list}

조건:
- suspects는 용의자1부터 용의자${SUSPECTS}까지 순서대로
- 피해자는 용의자가 아니다
- story는 게임이 끝난 뒤 공개하는 전말이므로 진범과 범행 시각을 밝혀도 된다. 위 동선과 어긋나지 않게 쓴다
- method와 story의 범행 수단은 진범 증거 기록의 물건이고, motive와 story의 동기는 motives 첫 번째와 같은 내용이다
- motives의 가짜 셋은 피해자와의 관계로 보아 그럴듯하지만 진짜와는 확실히 다른 이유로 쓴다
- 모든 문장은 "~했다", "~이다"로 끝나는 건조한 기록체로 쓴다 ("~습니다" 금지)
- 기록 문장에는 인물로 지정된 사람 외에 다른 사람이 그 자리에 있었다는 말을 쓰지 않는다 ("사람들이", "모두가", "누군가" 금지). 누가 있었는지는 게임이 따로 보여 준다
- 잔인한 묘사는 피하고, 15세 이상이 즐길 수 있는 수위로`,
    CASE_SCHEMA
  );
  if (!r || r.suspects?.length !== SUSPECTS || r.eventTexts?.length !== s.events.length) return null;
  // 동기 선택지가 형식에 안 맞으면 기본 동기로 바꾼다 (첫 번째가 진짜)
  const motivesOk = r.motives?.length === 4 && new Set(r.motives.map((m) => String(m.key).trim())).size === 4
    && r.motives.every((m) => String(m.key).trim() && String(m.text).trim());
  if (!motivesOk) r.motives = shuffled(MOTIVES).slice(0, 4);
  // 이름은 AI가 바꿔 쓰더라도 서버가 정한 이름으로 맞춘다
  const victimText = String(r.victim ?? '');
  const fixed = {
    ...r,
    title: String(r.title ?? '').trim(),
    victim: victimText.includes(names.victim) ? victimText : `${names.victim} (${victimText.replace(/^[^(]*\(?|\)$/g, '') || '피해자'})`,
    suspects: r.suspects.map((x, i) => ({ ...x, name: names.suspects[i] })),
  };
  return { ...fixed, ...guardEvents(fixed, s, places) };
}

// 추리에 쓰이는 기록은 AI 실수에 맡기지 않는다. 규칙을 어긴 문장만 안전한 기본 문장으로 바꾼다.
//  - 현장 쪽 소리: 현장 이름이 들어가야 하고, 다른 사람이 있었던 것처럼 쓰면 안 된다
//  - 증거 기록: 그 사람 이름과 물건 이름이 들어가야 하고, 물건은 증거끼리 겹치면 안 된다
//  - 동기 단서: 진짜 동기의 핵심어가 들어가야 한다
//  - 분위기 기록: 다른 사람이 있었던 것처럼 쓰면 안 된다
const CROWD = /누군가|사람들|모두|일제히|이들/;
function guardEvents(f, s, places) {
  const usedItems = new Set();
  const spare = shuffled(ITEMS);
  const eventItems = [];
  const eventTexts = s.events.map((e, i) => {
    const text = String(f.eventTexts[i] ?? '').trim();
    eventItems.push('');
    if (e.kind === 'time' || e.kind === 'decoy') {
      return text.includes(places[0]) && !CROWD.test(text) ? text : `${places[0]} 쪽에서 둔탁한 소리와 짧은 비명이 들렸다.`;
    }
    if (e.kind === 'suspicious') {
      const name = String(f.suspects[e.who].name).trim();
      let item = String(f.eventItems?.[i] ?? '').trim();
      const itemOk = item && item.length <= 10 && !usedItems.has(item);
      if (!itemOk) item = spare.find((x) => !usedItems.has(x));
      usedItems.add(item);
      eventItems[i] = item;
      return itemOk && text.includes(name) && text.includes(item) ? text : itemEvidence(name, item);
    }
    if (e.kind === 'motive') {
      const key = String(f.motives[0].key).trim();
      return text.includes(key) && !CROWD.test(text) ? text : motiveNote(key);
    }
    return text && !CROWD.test(text) ? text : '전등이 잠깐 깜빡였다.';
  });
  return { eventTexts, eventItems };
}
