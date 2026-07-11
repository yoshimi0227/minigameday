// gameday.json のスキーマ (詳細: .claude/skills/gameday-dashboard/references/data-schema.md)

export interface GamedayEvent {
  title: string;
  date?: string;
  team?: string;
  note?: string;
}

export type InjectStatus = 'success' | 'partial' | 'failed' | 'pending';

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
