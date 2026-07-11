#!/usr/bin/env bash
# GameDay 振り返りデータ収集スクリプト。
# FIS 実験タイムライン / canary 成功率 / cdk drift / CDK コードの git diff を
# 1 つの Markdown に束ねて標準出力に出す。これを Claude Code に渡し、
# gameday-retrospective スキルで講評する。
#
# 使い方: bash scripts/collect-retrospective.sh <experiment-id> [canary-name] [stack-name]
#   例:   bash scripts/collect-retrospective.sh EXPxxxx gameday-top GameDay > retro-data.md
#
# 前提: AWS 認証情報が設定済みであること (aws sts get-caller-identity が通る)。
#       各コマンドは失敗しても続行し、取れた分だけ出力する (set -e は使わない)。
set -uo pipefail

EXP_ID="${1:?usage: collect-retrospective.sh <experiment-id> [canary-name] [stack-name]}"
CANARY="${2:-gameday-top}"
STACK="${3:-GameDay}"

echo "# GameDay 振り返りデータ (自動収集)"
echo
echo "- 実験 ID: \`${EXP_ID}\` / canary: \`${CANARY}\` / スタック: \`${STACK}\`"
echo "- 収集元: FIS get-experiment / CloudWatch SuccessPercent / cdk drift / git diff"
echo

echo "## 1. FIS 実験タイムライン"
echo '```json'
aws fis get-experiment --id "${EXP_ID}" \
  --query "experiment.{status:state.status,start:startTime,end:endTime,actions:actions,stopConditions:stopConditions}" \
  --output json 2>&1 || echo '{"error":"get-experiment に失敗 (実験 ID / 認証を確認)"}'
echo '```'
echo

echo "## 2. 実験前後の canary 成功率 (SuccessPercent, 1 分粒度)"
START=$(aws fis get-experiment --id "${EXP_ID}" --query "experiment.startTime" --output text 2>/dev/null)
END=$(aws fis get-experiment --id "${EXP_ID}" --query "experiment.endTime" --output text 2>/dev/null)
# 実験の前後に余白を付ける (GNU date 前提。無ければ実験時刻そのまま)。
WIN_START=$(date -u -d "${START} -15 minutes" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo "${START}")
WIN_END=$(date -u -d "${END} +30 minutes" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo "${END}")
echo "窓: ${WIN_START} 〜 ${WIN_END}"
echo '```'
aws cloudwatch get-metric-statistics \
  --namespace CloudWatchSynthetics --metric-name SuccessPercent \
  --dimensions Name=CanaryName,Value="${CANARY}" \
  --start-time "${WIN_START}" --end-time "${WIN_END}" \
  --period 60 --statistics Average \
  --query "sort_by(Datapoints,&Timestamp)[].[Timestamp,Average]" --output table 2>&1 \
  || echo "get-metric-statistics に失敗 (canary 名 / 認証を確認)"
echo '```'
echo

echo "## 3. 顧客影響: ALB 5xx (HTTPCode_ELB_5XX_Count, 1 分粒度)"
# GameDay の ALB を名前で特定し、CloudWatch の LoadBalancer ディメンション値 (app/<name>/<id>) を得る
LB_FULLNAME=$(aws elbv2 describe-load-balancers \
  --query "LoadBalancers[?starts_with(LoadBalancerName,'GameDa')].LoadBalancerArn | [0]" --output text 2>/dev/null \
  | sed 's|.*:loadbalancer/||')
if [ -n "${LB_FULLNAME}" ] && [ "${LB_FULLNAME}" != "None" ]; then
  echo "LoadBalancer: ${LB_FULLNAME} / 窓: ${WIN_START} 〜 ${WIN_END}"
  echo '```'
  aws cloudwatch get-metric-statistics \
    --namespace AWS/ApplicationELB --metric-name HTTPCode_ELB_5XX_Count \
    --dimensions Name=LoadBalancer,Value="${LB_FULLNAME}" \
    --start-time "${WIN_START}" --end-time "${WIN_END}" \
    --period 60 --statistics Sum \
    --query "sort_by(Datapoints,&Timestamp)[].[Timestamp,Sum]" --output table 2>&1 | head -40 \
    || echo "get-metric-statistics (ELB 5xx) に失敗"
  echo '```'
  echo "> 全て 0 なら「ユーザーに見える障害は無かった」= 自己回復型の証拠。"
else
  echo "(GameDay の ALB が見つからない。デプロイ中か名前が異なる)"
fi
echo

echo "## 4. cdk drift (実リソース vs 期待状態 = 応急処置の痕跡)"
echo '```'
npx cdk drift "${STACK}" 2>&1 | grep -aviE "^\s*$|Acknowledge with|feature flag|crossStack" | tail -50 \
  || echo "cdk drift に失敗 (リポジトリルートで実行しているか / 認証を確認)"
echo '```'
echo

echo "## 5. CDK コードの git diff (参加者が IaC を直したか = フェーズ4-B の痕跡)"
echo '```diff'
git diff -- lib/ bin/ 2>&1 || echo "git diff に失敗"
echo '```'
echo "> 空なら「参加者はコンソール/CLI で直した (フェーズ4-A)」= drift 側に痕跡が出るはず。"
