// gameday.json のスキーマ (詳細: .claude/skills/gameday-dashboard/references/data-schema.md)

export interface GamedayEvent {
  title: string;
  date?: string;
  team?: string;
  note?: string;
}

export type InjectStatus = 'success' | 'partial' | 'failed' | 'pending';

/** 段階ヒント。ポイントを消費して開示する。cost が消費点。 */
export interface Hint {
  id: string;
  label: string; // 短い名前 (例: "方針" / "使う道具" / "具体手順")
  cost: number; // 消費ポイント (開示すると獲得スコアから引かれる)
  text: string; // ヒント本文
}

export interface Inject {
  id: string;
  scenarioId?: string | null;
  time?: string;
  title: string;
  instruction?: string;
  response?: string;
  status?: InjectStatus;
  detectionMinutes?: number;
  recoveryMinutes?: number;
  score?: number;
  maxScore?: number;
  notes?: string;
  hints?: Hint[];
}

/** 開示済みヒントの消費ポイント合計 */
export function hintPenalty(inject: Inject, revealed: ReadonlySet<string>): number {
  return (inject.hints ?? [])
    .filter((h) => revealed.has(h.id))
    .reduce((sum, h) => sum + (h.cost ?? 0), 0);
}

/** 実効スコア = 獲得スコア − ヒント消費 (0 下限)。未採点は undefined */
export function effectiveScore(inject: Inject, revealed: ReadonlySet<string>): number | undefined {
  if (typeof inject.score !== 'number') return undefined;
  return Math.max(0, inject.score - hintPenalty(inject, revealed));
}

export type FeedbackType = 'keep' | 'problem' | 'try';

export interface Feedback {
  type: FeedbackType;
  scenarioId?: string | null;
  author?: string;
  comment: string;
}

export interface GamedayData {
  event: GamedayEvent;
  injects: Inject[];
  feedback: Feedback[];
}

export function fmtMinutes(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
