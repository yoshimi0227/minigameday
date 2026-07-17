// 採点・導出ロジックの唯一の置き場 (React 非依存の純関数)。
// UI (App/Tiles/ScoreTable) と dev サーバ (vite.config.ts の gameEventsSync) の両方から使う。
//
// スコアの優先順位: scoreOverride (手動最終裁定) > 自動採点 (タイムスタンプが揃ったとき) > score (手動素点)
// 自動採点 = 検知 (影響開始 → 検知宣言の速さ) + 復旧 (MTTR) + 伝達 (commsScore 手動)。
// canary に映らない障害 (scenario-02 の読み取りプローブ死角が実例) は impactStartAt が
// 付かず自動採点は成立しない → 手動採点にフォールバックする。「影響なし = 自動満点」にはしない。

import type {
  GameEvent,
  GamedayData,
  Inject,
  InjectStatus,
  ScoringConfig,
  ScoringCurve,
} from './types';

export const DEFAULT_SCORING: ScoringConfig = {
  detection: { maxPoints: 40, fullWithinMinutes: 2, zeroAfterMinutes: 15 },
  recovery: { maxPoints: 40, fullWithinMinutes: 5, zeroAfterMinutes: 30 },
  commsMaxPoints: 20,
};

/** 開示済みヒントの消費ポイント合計 */
export function hintPenalty(inject: Inject, revealed: ReadonlySet<string>): number {
  return (inject.hints ?? [])
    .filter((h) => revealed.has(h.id))
    .reduce((sum, h) => sum + (h.cost ?? 0), 0);
}

/** 線形減衰: fullWithin 以内 = 満点、zeroAfter 以降 = 0、間は線形。負分 (影響前) は満点扱い */
export function decayPoints(minutes: number, curve: ScoringCurve): number {
  if (minutes <= curve.fullWithinMinutes) return curve.maxPoints;
  if (minutes >= curve.zeroAfterMinutes) return 0;
  const remain =
    (curve.zeroAfterMinutes - minutes) / (curve.zeroAfterMinutes - curve.fullWithinMinutes);
  return Math.round(curve.maxPoints * remain);
}

/** ISO8601 2 時刻の差を分 (小数 1 桁) で返す */
function minutesBetween(fromIso: string, toIso: string): number {
  return Math.round(((Date.parse(toIso) - Date.parse(fromIso)) / 60000) * 10) / 10;
}

/**
 * 自動採点の素点 = 検知点 + 復旧点 + 伝達点 (commsScore 手動、上限 clamp)。
 * 影響開始・検知宣言・復旧の 3 タイムスタンプが揃わないうちは undefined (未確定)。
 */
export function autoScore(
  inject: Inject,
  scoring: ScoringConfig = DEFAULT_SCORING,
): number | undefined {
  if (!inject.impactStartAt || !inject.ackAt || !inject.recoveredAt) return undefined;
  const detectionMin = Math.max(0, minutesBetween(inject.impactStartAt, inject.ackAt));
  const recoveryMin = Math.max(0, minutesBetween(inject.impactStartAt, inject.recoveredAt));
  const comms = Math.min(Math.max(inject.commsScore ?? 0, 0), scoring.commsMaxPoints);
  return decayPoints(detectionMin, scoring.detection) + decayPoints(recoveryMin, scoring.recovery) + comms;
}

/** 素点の解決: scoreOverride > 自動採点 > 手動 score。どれも無ければ undefined (未採点) */
export function resolveScore(
  inject: Inject,
  scoring: ScoringConfig = DEFAULT_SCORING,
): number | undefined {
  if (typeof inject.scoreOverride === 'number') return inject.scoreOverride;
  const auto = autoScore(inject, scoring);
  if (auto !== undefined) return auto;
  return typeof inject.score === 'number' ? inject.score : undefined;
}

/** 自動採点の内訳 (スコアセルの小書き表示用)。自動採点が成立しないときは undefined */
export function autoScoreBreakdown(
  inject: Inject,
  scoring: ScoringConfig = DEFAULT_SCORING,
): { detection: number; recovery: number; comms: number } | undefined {
  if (!inject.impactStartAt || !inject.ackAt || !inject.recoveredAt) return undefined;
  return {
    detection: decayPoints(
      Math.max(0, minutesBetween(inject.impactStartAt, inject.ackAt)),
      scoring.detection,
    ),
    recovery: decayPoints(
      Math.max(0, minutesBetween(inject.impactStartAt, inject.recoveredAt)),
      scoring.recovery,
    ),
    comms: Math.min(Math.max(inject.commsScore ?? 0, 0), scoring.commsMaxPoints),
  };
}

/** 実効スコア = 素点 (resolveScore) − ヒント消費 (0 下限)。未採点は undefined */
export function effectiveScore(
  inject: Inject,
  revealed: ReadonlySet<string>,
  scoring: ScoringConfig = DEFAULT_SCORING,
): number | undefined {
  const base = resolveScore(inject, scoring);
  if (base === undefined) return undefined;
  return Math.max(0, base - hintPenalty(inject, revealed));
}

/** 手動の確定ステータス (自動導出はこれを上書きしない) */
const MANUAL_FINAL: readonly InjectStatus[] = ['success', 'partial', 'failed'];

type DerivedField =
  | 'experimentId'
  | 'experimentStartedAt'
  | 'impactStartAt'
  | 'recoveredAt'
  | 'ackAt'
  | 'detectionMinutes'
  | 'recoveryMinutes'
  | 'status';

/**
 * events[] から injects の派生フィールドを毎回全量再計算する (冪等)。
 * increment 更新ではなく再計算にすることで、イベントの重複・順序乱れ・再配送・
 * アラームのフラッピングを一括で自然に処理する。変更があれば true。
 *
 * ルール:
 * - FIS running → experimentTemplateId が一致し experimentId 未割当の最初の inject に割当て
 * - ALARM/OK → 「その時刻以前に armed になった最新の inject」に帰属。
 *   impactStartAt = 帰属した最初の ALARM、recoveredAt = 列が OK で終わるときだけその時刻
 *   (再 ALARM が来たら recoveredAt は消える = フラッピング対応)
 * - イベント材料が無い inject は一切触らない (既存の手動採点データ・手書きフォールバックを保護)
 * - 手動確定ステータス (success/partial/failed) は上書きしない
 */
export function deriveFromEvents(data: GamedayData): boolean {
  const events = [...(data.events ?? [])].sort(
    (a, b) => a.at.localeCompare(b.at) || a.key.localeCompare(b.key),
  );
  if (events.length === 0) return false;
  let changed = false;

  const set = (inject: Inject, field: DerivedField, value: string | number | undefined): void => {
    const rec = inject as Record<DerivedField, string | number | undefined>;
    if (value === undefined) {
      if (rec[field] !== undefined) {
        delete rec[field];
        changed = true;
      }
    } else if (rec[field] !== value) {
      rec[field] = value;
      changed = true;
    }
  };

  // 1) 実験イベント → inject へ割当て (テンプレート ID で突き合わせ、実験 ID で追跡)
  for (const e of events) {
    if (e.type !== 'experiment' || e.status !== 'running' || !e.experimentId) continue;
    const target =
      data.injects.find((i) => i.experimentId === e.experimentId) ??
      data.injects.find(
        (i) => i.experimentTemplateId === e.experimentTemplateId && !i.experimentId,
      );
    if (!target) continue;
    set(target, 'experimentId', e.experimentId);
    set(target, 'experimentStartedAt', e.at);
  }

  // 2) 検知宣言イベント → ackAt (最初の宣言だけ有効。/api/ack の直接書き込みと重なっても冪等)
  for (const e of events) {
    if (e.type !== 'ack' || !e.injectId) continue;
    const inject = data.injects.find((i) => i.id === e.injectId);
    if (inject && !inject.ackAt) set(inject, 'ackAt', e.at);
  }

  // 3) アラーム遷移を inject に帰属させる (その時刻以前に armed になった最新の inject)
  const armed = data.injects
    .filter((i): i is Inject & { experimentStartedAt: string } => Boolean(i.experimentStartedAt))
    .sort((a, b) => a.experimentStartedAt.localeCompare(b.experimentStartedAt));
  const alarmSeq = new Map<string, GameEvent[]>();
  for (const e of events) {
    if (e.type !== 'alarm' || (e.state !== 'ALARM' && e.state !== 'OK')) continue;
    const owner = [...armed].reverse().find((i) => i.experimentStartedAt <= e.at);
    if (!owner) continue;
    const seq = alarmSeq.get(owner.id) ?? [];
    seq.push(e);
    alarmSeq.set(owner.id, seq);
  }

  // 4) inject ごとの導出
  for (const inject of data.injects) {
    const seq = alarmSeq.get(inject.id);
    const eventManaged = Boolean(seq && seq.length > 0);
    if (seq && eventManaged) {
      const firstAlarm = seq.find((e) => e.state === 'ALARM');
      const last = seq[seq.length - 1];
      const impactAt = firstAlarm?.at;
      set(inject, 'impactStartAt', impactAt);
      set(inject, 'recoveredAt', impactAt && last.state === 'OK' ? last.at : undefined);
    }

    // 分数はタイムスタンプが揃っていれば常に再計算する (手書きフォールバックでも効く)。
    // イベント帰属のある inject では材料が消えたら分数も消す (フラッピングで recoveredAt が
    // 取り消されたら recoveryMinutes も取り消す)。イベント材料の無い手動採点 inject は触らない。
    if (inject.impactStartAt && inject.ackAt) {
      set(
        inject,
        'detectionMinutes',
        Math.max(0, minutesBetween(inject.impactStartAt, inject.ackAt)),
      );
    } else if (eventManaged) {
      set(inject, 'detectionMinutes', undefined);
    }
    if (inject.impactStartAt && inject.recoveredAt) {
      set(
        inject,
        'recoveryMinutes',
        Math.max(0, minutesBetween(inject.impactStartAt, inject.recoveredAt)),
      );
    } else if (eventManaged) {
      set(inject, 'recoveryMinutes', undefined);
    }

    // ステータス導出: recovered > impacted > armed。手動確定値と材料なしは触らない
    if (inject.status && MANUAL_FINAL.includes(inject.status)) continue;
    let derivedStatus: InjectStatus | undefined;
    if (inject.impactStartAt && inject.recoveredAt) derivedStatus = 'recovered';
    else if (inject.impactStartAt) derivedStatus = 'impacted';
    else if (inject.experimentStartedAt) derivedStatus = 'armed';
    if (derivedStatus) set(inject, 'status', derivedStatus);
  }

  return changed;
}
