/**
 * Pure mapping from the service-worker status (pwa.ts) to what the menus show:
 * offline-readiness chip, install action, update banner. No DOM access (unit tested).
 */
import type { PwaStatus } from '../pwa.js';

export type OfflineTone = 'busy' | 'good' | 'bad' | 'off';

export interface OfflineView {
  tone: OfflineTone;
  /** Short label for chips ('오프라인 준비 중 42%'). */
  label: string;
  /** Longer sentence for the settings screen. */
  detail: string;
  /** Offer pwa.retry(). */
  retry: boolean;
}

/**
 * Offline readiness as the player sees it. `prod` = a production build (the service worker only
 * registers there); null = nothing worth showing (dev server, or no service worker support on a
 * compact surface like the title screen).
 */
export function offlineView(s: Readonly<PwaStatus>, prod: boolean): OfflineView | null {
  if (!s.supported) {
    return { tone: 'off', label: '오프라인 미지원', detail: '이 브라우저는 오프라인 저장을 지원하지 않아요. 온라인에서는 그대로 플레이할 수 있어요.', retry: false };
  }
  if (s.offlineReady) {
    return s.online
      ? { tone: 'good', label: '오프라인 플레이 가능', detail: '게임 파일을 모두 저장했어요. 인터넷이 없어도 온라인 랭킹을 뺀 모든 모드를 즐길 수 있어요.', retry: false }
      : { tone: 'off', label: '오프라인 플레이 중', detail: '지금은 오프라인이에요. 온라인 랭킹을 뺀 모든 모드를 그대로 즐길 수 있어요.', retry: false };
  }
  if (s.error) return { tone: 'bad', label: '오프라인 준비 실패', detail: s.error, retry: true };
  // Until the worker reports (it answers within moments on every launch) there is nothing to say:
  // only an actual download shows progress.
  if (!prod || (!s.updating && s.progress <= 0)) return null;
  const pct = Math.max(0, Math.min(100, Math.round(s.progress)));
  return {
    tone: 'busy', label: `오프라인 준비 중 ${pct}%`,
    detail: `오프라인에서도 플레이할 수 있도록 게임 파일을 저장하고 있어요. (${pct}%)`, retry: false,
  };
}

export type InstallMode = 'prompt' | 'ios' | null;

/** '앱 설치' action: the browser's prompt, the iOS Share → Home Screen guide, or nothing. */
export function installMode(s: Readonly<PwaStatus>): InstallMode {
  if (s.installed) return null;
  if (s.installable) return 'prompt';
  if (s.iosManualInstall) return 'ios';
  return null;
}

/** The update banner never appears while a race (or its results) is in progress. */
export function updateVisible(s: Readonly<PwaStatus>, racing: boolean): boolean {
  return s.updateReady && !racing && !s.inRace;
}

/** Waiting runs are submittable only online; show how many wait and whether 등록 is possible. */
export function pendingSummary(count: number, online: boolean): { text: string; canSubmit: boolean } | null {
  if (count <= 0) return null;
  return online
    ? { text: `등록을 기다리는 타임 어택 기록이 ${count}개 있어요.`, canSubmit: true }
    : { text: `오프라인 기록 ${count}개를 보관 중이에요. 온라인이 되면 등록할 수 있어요.`, canSubmit: false };
}
