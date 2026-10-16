// AI를 못 쓰거나 AI 문장이 규칙을 어겼을 때 쓰는 기본 재료: 범행 수단이 될 물건, 동기 후보

export const ITEMS = ['와인병', '가죽 장갑', '넥타이', '열쇠 꾸러미', '촛대', '밧줄', '수면제 병', '망치', '만년필', '트로피', '스카프', '손전등'];

// key: 동기 단서 기록에 들어가는 핵심어, text: 고발할 때 고르는 동기 문장
export const MOTIVES = [
  { key: '유언장', text: '피해자가 유언장에서 자신을 빼려 했다' },
  { key: '차용증', text: '피해자에게 진 큰 빚을 갚을 수 없었다' },
  { key: '협박 편지', text: '피해자에게 약점을 잡혀 협박당하고 있었다' },
  { key: '계약서', text: '피해자가 사업을 몰래 다른 사람에게 넘기려 했다' },
  { key: '옛 사진', text: '피해자가 자신의 과거를 폭로하려 했다' },
  { key: '해고 통지서', text: '피해자 때문에 모든 것을 잃게 될 처지였다' },
  { key: '연애편지', text: '피해자가 숨겨 온 관계를 끝내려 했다' },
];

export const itemEvidence = (name, item) => `${name}이(가) ${item}을(를) 몰래 감추는 모습이 찍혔다.`;
export const motiveNote = (key) => `버려진 쪽지에 '${key}'라는 글씨가 적혀 있었다.`;

export const shuffled = (arr) => [...arr].sort(() => Math.random() - 0.5);
