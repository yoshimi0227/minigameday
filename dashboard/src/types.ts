// gameday.json のスキーマ (詳細: .claude/skills/gameday-dashboard/references/data-schema.md)

export interface GamedayEvent {
  title: string;
  date?: string;
  team?: string;
  note?: string;
}

export type InjectStatus =
  // 手動の確定値 (運営/振り返りが記入。自動導出はこれを上書きしない)
  | 'success'
  | 'partial'
  | 'failed'
  | 'pending'
  // ライブ状態 (gameEventsSync が events[] から導出する)
  | 'armed' // 実験開始済み (aws:fis:wait 中かも。障害はいつ来るか分からない)
  | 'impacted' // canary アラーム ALARM = 影響発生中
  | 'recovered'; // canary アラーム OK = 復旧済み

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
  /** ラウンド番号 (1=観察 / 2=対応)。表示のグルーピングと小計に使う。採点には影響しない */
  round?: number;
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
  /** FIS 実験テンプレート ID。イベントとの突き合わせキー (運営がセットアップ時に記入) */
  experimentTemplateId?: string;
  /**
   * 以下 4 つは gameEventsSync が events[] から導出して書く (手編集しない)。
   * 例外: FIS イベントの取り逃し (best effort 配信) 時は experimentStartedAt を
   * 手書きすれば同じに動く (導出はイベント材料が無いフィールドを触らない)。
   */
  experimentId?: string; // 実際に走った FIS 実験 ID
  experimentStartedAt?: string; // ISO8601 — FIS running (= armed。障害はまだ)
  impactStartAt?: string; // ISO8601 — canary アラーム ALARM (影響開始)
  recoveredAt?: string; // ISO8601 — canary アラーム OK (最後の ALARM より後の最後の OK)
  /** 検知宣言の時刻 (/api/ack がサーバ時刻で付与。最初の宣言だけ有効) */
  ackAt?: string;
  /** 伝達・記録の点数 0〜20 (手動。運営がルーブリックで判断して記入) */
  commsScore?: number;
  /** 最終的な手動オーバーライド。これがあれば自動採点・手動 score より優先 */
  scoreOverride?: number;
}

/** 採点カーブ: fullWithinMinutes 以内 = 満点、zeroAfterMinutes 以降 = 0、間は線形減衰 */
export interface ScoringCurve {
  maxPoints: number;
  fullWithinMinutes: number;
  zeroAfterMinutes: number;
}

/**
 * エスカレーション (スコア到達で次の障害を自動発火) の運用スイッチ。
 * enabled: false にすると dev サーバが SCORE アイテムに escalationEnabled=false を写し、
 * score-escalator Lambda が判定ごとスキップする。scenario-03 (legacy) のラウンド中など
 * 「累計スコアが閾値を超えても本体側の障害を出したくない」局面で運営が切る。
 * セクションが無ければ有効 (後方互換)。npm run reset では持ち越さない (毎周回 有効に戻る)。
 */
export interface EscalationConfig {
  enabled?: boolean;
}

/** 自動採点の設定 (gameday.json の scoring セクション。無ければ DEFAULT_SCORING) */
export interface ScoringConfig {
  detection: ScoringCurve; // 検知: impactStartAt → ackAt (検知宣言) の速さ
  recovery: ScoringCurve; // 復旧: impactStartAt → recoveredAt (MTTR)
  commsMaxPoints: number; // 伝達・記録の満点 (commsScore の上限。手動採点)
}

/** ゲームイベント (GameEvents Lambda が DynamoDB に記録 → dev サーバが同期。タイムライン素材) */
export interface GameEvent {
  key: string; // DynamoDB の pk (重複排除キー)。ack は 'ACK#<injectId>'
  type: 'experiment' | 'alarm' | 'ack';
  at: string; // ISO8601 (EventBridge の time / dev サーバ時刻)
  // type: 'experiment'
  experimentId?: string;
  experimentTemplateId?: string;
  status?: string; // running | completed | stopped | failed
  // type: 'alarm'
  alarmName?: string;
  state?: 'ALARM' | 'OK';
  reason?: string;
  // type: 'ack'
  injectId?: string;
}

/**
 * AI 講評が feedback[] に書き込むときの author 値。
 * 再生成時はこの author のエントリを入れ替える (人間の KPT は触らない)。
 * かつては独立した Review セクション + retrospectives/ レポートだったが、
 * 2026-07-18 に「講評も KPT 形式で同じボードへ」に一本化した。
 */
export const AI_FEEDBACK_AUTHOR = 'AI 講評';

/** 構成図のノード (AWS リソース 1 つ分) */
export interface SystemNode {
  service: string; // サービス名 (例: "ALB" / "ECS Fargate")
  icon?: string; // AWS 公式アイコンのキー (awsIcons.ts の AWS_ICONS)。無い/不明ならアイコン無しで描画
  label?: string; // 一言補足 (例: "internet-facing / HTTP:80")
  count?: number; // 台数。2 以上で "×N" バッジを表示
}

/** 構成図の層 (サブネット / リージョン等のまとまり。上から下へ矢印でつなぐ) */
export interface SystemTier {
  name: string; // 層の名前 (例: "アプリ層 — app サブネット")
  icon?: string; // 層のグループアイコンのキー (例: "public-subnet" / "region")。任意
  nodes: SystemNode[];
  note?: string; // 層への補足 (任意)
}

/** GameDay のお題システム。scenarioIds で scenarios/ のシナリオと紐づく */
export interface TargetSystem {
  id: string;
  name: string; // タブに出る短い名前
  summary: string; // システムについての軽い補足 (何をするアプリか)
  scenarioIds: string[]; // このシステムを対象とするシナリオ id
  tiers: SystemTier[];
  notes?: string[]; // 箇条書きの補足 (観測手段・ハンドアウト等)
}

export type FeedbackType = 'keep' | 'problem' | 'try';

export interface Feedback {
  type: FeedbackType;
  scenarioId?: string | null;
  author?: string;
  comment: string;
}

/** ヒント開示の記録 (dev サーバが gameday.json に追記。振り返りの集計元) */
export interface HintReveal {
  injectId: string;
  hintId: string;
  label: string;
  cost: number;
  at: string; // ISO8601 タイムスタンプ (サーバ側で付与)
}

/** ラウンドの定義 (見出し・説明)。inject.round と number で結ぶ */
export interface RoundDef {
  round: number;
  title: string; // 例: "観察ラウンド" / "対応ラウンド"
  description?: string; // 例: "自己回復する障害。静観・判断の練習"
}

export interface GamedayData {
  event: GamedayEvent;
  systems?: TargetSystem[]; // お題システムの構成図 (シナリオ追加と連動して増やす)
  rounds?: RoundDef[]; // ラウンドの見出し (無ければ round 番号だけで表示)
  injects: Inject[];
  feedback: Feedback[];
  hintReveals?: HintReveal[];
  scoring?: ScoringConfig; // 自動採点のカーブ設定 (無ければ DEFAULT_SCORING)
  escalation?: EscalationConfig; // エスカレーションの運用スイッチ (無ければ有効)
  events?: GameEvent[]; // ゲームイベントログ (gameEventsSync が追記。タイムライン素材)
}

export function fmtMinutes(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
