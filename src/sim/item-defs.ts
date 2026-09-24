import type { ItemId } from './types.js';

export interface ItemDef {
  id: ItemId;
  name: string;        // Korean
  nameEn: string;
  /** Uses before the slot empties (triples = 3). */
  uses: number;
  /** Can be held behind the kart as a shield (single items) or orbit (triples). */
  shield: 'none' | 'trail' | 'orbit';
  /** HUD icon colors: primary / secondary (renderer & UI draw the icon procedurally). */
  color: string; color2: string;
  description: string;
}

export const ITEMS: Record<ItemId, ItemDef> = {
  banana: { id: 'banana', name: '바나나', nameEn: 'Banana', uses: 1, shield: 'trail', color: '#ffe135', color2: '#8a6d1a', description: '뒤에 떨어뜨려 상대를 미끄러뜨립니다. 버튼을 누르고 있으면 방패가 됩니다.' },
  banana3: { id: 'banana3', name: '바나나 ×3', nameEn: 'Triple Banana', uses: 3, shield: 'trail', color: '#ffe135', color2: '#8a6d1a', description: '바나나 세 개가 뒤따라옵니다.' },
  orb: { id: 'orb', name: '통통 구슬', nameEn: 'Bounce Orb', uses: 1, shield: 'trail', color: '#38e36b', color2: '#0f7a35', description: '곧게 날아가 벽에 튕깁니다. 뒤로 발사할 수도 있습니다.' },
  orb3: { id: 'orb3', name: '통통 구슬 ×3', nameEn: 'Triple Orb', uses: 3, shield: 'orbit', color: '#38e36b', color2: '#0f7a35', description: '주위를 도는 구슬 세 개. 하나씩 발사합니다.' },
  rocket: { id: 'rocket', name: '추적 로켓', nameEn: 'Homing Rocket', uses: 1, shield: 'trail', color: '#ff3b3b', color2: '#8c1010', description: '바로 앞 레이서를 끝까지 추적합니다.' },
  rocket3: { id: 'rocket3', name: '추적 로켓 ×3', nameEn: 'Triple Rocket', uses: 3, shield: 'orbit', color: '#ff3b3b', color2: '#8c1010', description: '추적 로켓 세 발이 주위를 돕니다.' },
  nitro: { id: 'nitro', name: '니트로', nameEn: 'Nitro', uses: 1, shield: 'none', color: '#ff8a00', color2: '#ffe066', description: '순간적으로 가속합니다. 오프로드도 무시합니다.' },
  nitro3: { id: 'nitro3', name: '니트로 ×3', nameEn: 'Triple Nitro', uses: 3, shield: 'none', color: '#ff8a00', color2: '#ffe066', description: '세 번 가속할 수 있습니다.' },
  star: { id: 'star', name: '슈퍼 스타', nameEn: 'Super Star', uses: 1, shield: 'none', color: '#ffe600', color2: '#ff4fd8', description: '잠시 무적이 되어 빨라지고, 부딪힌 상대를 날려 버립니다.' },
  thunder: { id: 'thunder', name: '번개 구름', nameEn: 'Thunder Cloud', uses: 1, shield: 'none', color: '#7fd1ff', color2: '#fff45c', description: '모든 상대를 작게 만들어 속도를 떨어뜨립니다.' },
  ink: { id: 'ink', name: '먹물 문어', nameEn: 'Ink Squid', uses: 1, shield: 'none', color: '#3a2d5c', color2: '#b7a6ff', description: '앞선 레이서들의 시야를 먹물로 가립니다.' },
  autopilot: { id: 'autopilot', name: '터보 로켓', nameEn: 'Turbo Rocket', uses: 1, shield: 'none', color: '#2b2d42', color2: '#ff5d5d', description: '로켓으로 변신해 자동으로 질주하며 부딪히는 상대를 날립니다.' },
  skybomb: { id: 'skybomb', name: '선두 폭탄', nameEn: 'Sky Bomb', uses: 1, shield: 'none', color: '#2f6bff', color2: '#b8e1ff', description: '하늘을 날아 1위 레이서를 폭격합니다.' },
  coins: { id: 'coins', name: '코인 주머니', nameEn: 'Coin Pouch', uses: 1, shield: 'none', color: '#ffc300', color2: '#b8860b', description: '코인 3개를 얻습니다. 코인은 최고 속도를 높입니다.' },
};

export const ITEM_IDS = Object.keys(ITEMS) as ItemId[];

/**
 * Relative item weights by rank bucket. Bucket from rank fraction
 * f = (position - 1) / (racers - 1): 0 = leader … 4 = last.
 */
export const ITEM_WEIGHTS: Record<ItemId, [number, number, number, number, number]> = {
  banana: [30, 16, 6, 2, 0],
  banana3: [6, 8, 6, 1, 0],
  orb: [26, 18, 10, 4, 0],
  orb3: [2, 8, 10, 8, 4],
  rocket: [2, 14, 16, 12, 6],
  rocket3: [0, 2, 8, 12, 12],
  nitro: [6, 12, 16, 16, 10],
  nitro3: [0, 2, 8, 16, 18],
  star: [0, 0, 3, 10, 16],
  thunder: [0, 0, 1, 4, 8],
  ink: [0, 4, 6, 3, 1],
  autopilot: [0, 0, 1, 6, 16],
  skybomb: [0, 1, 4, 5, 4],
  coins: [28, 15, 5, 1, 0],
};

export function rankBucket(position: number, racers: number): number {
  if (racers <= 1 || position <= 1) return 0;
  const f = (position - 1) / (racers - 1);
  if (f <= 0.3) return 1;
  if (f <= 0.6) return 2;
  if (f <= 0.85) return 3;
  return 4;
}
