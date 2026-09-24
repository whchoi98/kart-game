import type { CharacterDef, CharacterId } from './types.js';

/** Original TURBO PALS cast. Stats 1..5; every driver totals 14 so no pick dominates. */
export const CHARACTERS: readonly CharacterDef[] = [
  {
    id: 'pip', name: '핍', nameEn: 'Pip', species: 'penguin', weightClass: 'light',
    colors: { body: '#2f8cff', accent: '#ffd23f', fur: '#1d2433', detail: '#ff9f1c' },
    stats: { speed: 2, accel: 5, weight: 2, handling: 5 },
    tagline: '얼음 위의 작은 번개. 가속과 코너링의 달인.',
  },
  {
    id: 'bruno', name: '브루노', nameEn: 'Bruno', species: 'bear', weightClass: 'heavy',
    colors: { body: '#d7263d', accent: '#f4d35e', fur: '#8a5a3b', detail: '#3b2418' },
    stats: { speed: 5, accel: 2, weight: 5, handling: 2 },
    tagline: '한 번 달리면 멈추지 않는 숲속의 장갑차.',
  },
  {
    id: 'mochi', name: '모찌', nameEn: 'Mochi', species: 'rabbit', weightClass: 'light',
    colors: { body: '#ff7eb6', accent: '#ffffff', fur: '#fbf4f0', detail: '#ff4f8b' },
    stats: { speed: 3, accel: 5, weight: 1, handling: 5 },
    tagline: '통통 튀는 드리프트 요정.',
  },
  {
    id: 'rex', name: '렉스', nameEn: 'Rex', species: 'dino', weightClass: 'heavy',
    colors: { body: '#3fa34d', accent: '#f8961e', fur: '#6cc551', detail: '#1f5f2c' },
    stats: { speed: 5, accel: 2, weight: 4, handling: 3 },
    tagline: '꼬리를 휘날리는 쥐라기 스피드 킹.',
  },
  {
    id: 'kiki', name: '키키', nameEn: 'Kiki', species: 'fox', weightClass: 'medium',
    colors: { body: '#ff8c1a', accent: '#2b2d42', fur: '#f28a2e', detail: '#fff4e6' },
    stats: { speed: 4, accel: 3, weight: 3, handling: 4 },
    tagline: '어느 트랙에서도 흔들리지 않는 만능 레이서.',
  },
  {
    id: 'taro', name: '타로', nameEn: 'Taro', species: 'raccoon', weightClass: 'medium',
    colors: { body: '#7b5cff', accent: '#c7f464', fur: '#8d8d99', detail: '#2a2a33' },
    stats: { speed: 3, accel: 4, weight: 3, handling: 4 },
    tagline: '아이템 박스를 노리는 장난꾸러기.',
  },
  {
    id: 'hana', name: '하나', nameEn: 'Hana', species: 'cat', weightClass: 'light',
    colors: { body: '#ffd166', accent: '#ef476f', fur: '#f6f1e9', detail: '#f4a259' },
    stats: { speed: 3, accel: 4, weight: 2, handling: 5 },
    tagline: '인코스를 파고드는 날렵한 고양이.',
  },
  {
    id: 'bolt', name: '볼트', nameEn: 'Bolt', species: 'robot', weightClass: 'heavy',
    colors: { body: '#6c7a89', accent: '#00e5ff', fur: '#c9d6df', detail: '#ff3864' },
    stats: { speed: 4, accel: 3, weight: 5, handling: 2 },
    tagline: '계산된 라인, 흔들림 없는 강철 차체.',
  },
];

export const CHARACTER_IDS = CHARACTERS.map(c => c.id) as readonly CharacterId[];

export function getCharacter(id: CharacterId): CharacterDef {
  const c = CHARACTERS.find(ch => ch.id === id);
  if (!c) throw new Error(`Unknown character ${id}`);
  return c;
}

export function isCharacterId(v: unknown): v is CharacterId {
  return typeof v === 'string' && (CHARACTER_IDS as readonly string[]).includes(v);
}
