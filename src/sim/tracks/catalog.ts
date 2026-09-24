import type { CupId, ThemeId } from '../types.js';

/** Lightweight metadata (no geometry) so menus can list tracks without building them. */
export interface TrackMeta {
  id: string;
  name: string;
  nameEn: string;
  cup: CupId;
  order: number;
  theme: ThemeId;
  blurb: string;
}

export interface CupMeta { id: CupId; name: string; nameEn: string; color: string; emblem: 'sprout' | 'bolt' }

export const CUPS: readonly CupMeta[] = [
  { id: 'sprout', name: '새싹 컵', nameEn: 'Sprout Cup', color: '#46c35a', emblem: 'sprout' },
  { id: 'thunder', name: '번개 컵', nameEn: 'Thunder Cup', color: '#ffb400', emblem: 'bolt' },
];

export const TRACK_CATALOG: readonly TrackMeta[] = [
  { id: 'sunny-meadow', name: '햇살 초원 서킷', nameEn: 'Sunny Meadow Circuit', cup: 'sprout', order: 1, theme: 'meadow', blurb: '풍차와 꽃밭 사이를 달리는 입문 서킷.' },
  { id: 'palm-beach', name: '야자수 해변', nameEn: 'Palm Beach Boulevard', cup: 'sprout', order: 2, theme: 'beach', blurb: '파도와 모래사장, 게들이 오가는 해변 도로.' },
  { id: 'canyon-rally', name: '붉은 협곡 랠리', nameEn: 'Red Canyon Rally', cup: 'sprout', order: 3, theme: 'canyon', blurb: '굴러오는 바위와 점프대가 가득한 협곡.' },
  { id: 'neon-city', name: '네온 시티 나이트', nameEn: 'Neon City Nights', cup: 'sprout', order: 4, theme: 'city', blurb: '네온사인과 차량 사이를 누비는 한밤의 시가지.' },
  { id: 'frost-peak', name: '눈꽃 봉우리', nameEn: 'Frost Peak Pass', cup: 'thunder', order: 1, theme: 'snow', blurb: '미끄러운 빙판과 눈덩이를 피하는 설산 고갯길.' },
  { id: 'jungle-ruins', name: '정글 유적', nameEn: 'Jungle Ruins', cup: 'thunder', order: 2, theme: 'jungle', blurb: '고대 유적과 폭포를 가로지르는 밀림 코스.' },
  { id: 'lava-fortress', name: '용암 요새', nameEn: 'Lava Fortress', cup: 'thunder', order: 3, theme: 'volcano', blurb: '용암 위 난간 없는 다리를 건너는 요새.' },
  { id: 'starlight-road', name: '별빛 은하 로드', nameEn: 'Starlight Road', cup: 'thunder', order: 4, theme: 'galaxy', blurb: '난간 없는 무지갯빛 우주 도로. 최종 관문.' },
];

export function tracksOfCup(cup: CupId): TrackMeta[] {
  return TRACK_CATALOG.filter(t => t.cup === cup).sort((a, b) => a.order - b.order);
}

export function getTrackMeta(id: string): TrackMeta {
  const t = TRACK_CATALOG.find(m => m.id === id);
  if (!t) throw new Error(`Unknown track ${id}`);
  return t;
}
