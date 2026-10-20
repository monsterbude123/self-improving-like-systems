#!/usr/bin/env bash
# next-id.sh —— .learnings 条目编号分配器（多工作树并发场景）
#
# 存在理由（2026-10-18）：编号形如 LRN-YYYYMMDD-NNN，此前**没有任何分配器**，
# 每个 agent 靠「扫本地 .learnings/ 取 max+1」。而 .learnings/ 是被跟踪目录，
# **每个 git worktree 各有一份独立检出** —— 兄弟工作树里尚未提交的条目对当前 agent
# 完全不可见。两个 agent 并发取号必然撞号。
#
# 这不是「谁不小心」，是机制性的：本地扫描在多工作树下结构上不可能看见别人。
# 2026-10-18 实测已有 10 组真撞号（--audit 可复现），其中 4 组还躺在未合并分支里，
# 合并那一刻才炸 —— 而 D6 门禁只看当前检出，连「即将炸」都看不见。
#
# 用法：
#   bash scripts/learnings/next-id.sh LRN              # 探测下一个可用编号
#   bash scripts/learnings/next-id.sh LRN --claim      # 探测 + 原子占用（推荐）
#   bash scripts/learnings/next-id.sh --audit [YYYYMMDD]  # 列出跨工作树的真撞号
#
# 退出码：0 成功 / 2 用法错或编号耗尽 / 3 并发占用冲突（重跑即可）
#
# O(1) spawn：枚举走 bash glob + 单次 awk，不用 find / grep -r
# （见 ERR-20261010-001：O(行数)×(进程 spawn) 会把门禁拖成小时级）。
# 2026-10-20 补：取文件名一律 `${f##*/}` 参数展开，**不用 basename**。
# basename 是外部命令 = 每个文件一次 fork；claim 目录一旦积压（判据自己的残留就能堆到几百个），
# 单次取号就从毫秒级涨到十几秒，整条判据被拖成分钟级。参数展开是 bash 内建，0 fork。
set -euo pipefail

# 仓根**从当前工作目录**解析，不从脚本自身位置 —— 本脚本住在 skill 目录里
# （.agents/skills/self-improving-like-systems/scripts/），若按 `$BASH_SOURCE/../..`
# 推算会落到 skill 根而不是仓根，那是个和 .learnings/ 毫无关系的目录。
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
COMMON="$(git -C "$ROOT" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || echo "$ROOT/.git")"
MAIN_ROOT="$(cd "$(dirname "$COMMON")" && pwd)"
CLAIM_DIR="$MAIN_ROOT/.learnings-work/claims"

usage() {
  echo "用法:" >&2
  echo "  bash scripts/learnings/next-id.sh <LRN|ERR|FEAT>              # 探测" >&2
  echo "  bash scripts/learnings/next-id.sh <LRN|ERR|FEAT> --claim      # 探测+占用" >&2
  echo "  bash scripts/learnings/next-id.sh --audit [YYYYMMDD]          # 列撞号" >&2
  exit 2
}

# ---- --audit：跨全部工作树列出「同号不同文件」的撞号 ----
if [ "${1:-}" = "--audit" ]; then
  DATE="${2:-$(date +%Y%m%d)}"
  LIST="$(mktemp)"; trap 'rm -f "$LIST"' EXIT
  for d in "$ROOT/.learnings" "$MAIN_ROOT/.learnings" "$MAIN_ROOT"/.worktrees/*/.learnings; do
    [ -d "$d" ] || continue
    for f in "$d"/*-"$DATE"-*.md; do
      [ -e "$f" ] || continue
      printf '%s\t%s\n' "${f##*/}" "$d"
    done
  done | sort -u > "$LIST"
  awk -F'\t' -v d="$DATE" '
    {
      b = $1
      # 同一份文件在 N 棵工作树各有一份检出（同一分支的正常现象）——
      # 按**文件名**去重，否则同一个条目会被数成 N 个「不同文件」，
      # 把真撞号组数虚报好几倍（实测 10 组被报成 24 组）。
      if (b in seen) next
      seen[b] = 1
      if (match(b, /^(LRN|ERR|FEAT)-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-[0-9][0-9][0-9]/)) {
        id = substr(b, RSTART, RLENGTH)
        if (index(id, "-" d "-") == 0) next
        cnt[id]++
        paths[id] = paths[id] "\n    " $2 "/" b
      }
    }
    END {
      g = 0
      for (k in cnt) if (cnt[k] > 1) { g++; printf "撞号 %s（%d 个不同文件）:%s\n", k, cnt[k], paths[k] }
      printf "\n===== %s 真撞号组数: %d =====\n", d, g
    }' "$LIST"
  exit 0
fi

[ $# -ge 1 ] || usage
TYPE="$1"; shift
case "$TYPE" in LRN|ERR|FEAT) ;; *) usage ;; esac
WANT_CLAIM=0
for a in "$@"; do
  case "$a" in --claim) WANT_CLAIM=1 ;; *) usage ;; esac
done

DATE="${LEARNINGS_DATE:-$(date +%Y%m%d)}"
LIST="$(mktemp)"; trap 'rm -f "$LIST"' EXIT

# ---- 五层可见域 ----
# ① 本工作树 .learnings/        已落盘、可能未提交
# ② 主检出 .learnings/          并发 agent 也可能直接在主检出里写
# ③ 兄弟工作树 .learnings/      **未提交条目藏在这里** —— 撞号的直接来源
# ④ claim 文件                   原子占用记录，覆盖「同一秒并发取到同一个号」
# ⑤ my_dev 分支上已提交条目      已提交但尚未合入本工作树的
{
  for d in "$ROOT/.learnings" "$MAIN_ROOT/.learnings" "$MAIN_ROOT"/.worktrees/*/.learnings; do
    [ -d "$d" ] || continue
    for f in "$d/${TYPE}-${DATE}-"*.md; do [ -e "$f" ] && printf '%s\n' "${f##*/}"; done
  done
  for f in "$CLAIM_DIR/${TYPE}-${DATE}-"*.claim; do [ -e "$f" ] && printf '%s\n' "${f##*/}"; done
  git -C "$MAIN_ROOT" ls-tree -r --name-only my_dev -- .learnings 2>/dev/null || true
} > "$LIST"

ID="$(awk -v t="$TYPE-" -v d="$DATE-" '
  {
    n = $0
    sub(/^.*\//, "", n)
    if (index(n, t d) != 1) next
    rest = substr(n, length(t d) + 1)
    if (match(rest, /^[0-9][0-9][0-9]/)) used[substr(rest, 1, 3)] = 1
  }
  END {
    for (i = 1; i <= 999; i++) {
      k = sprintf("%03d", i)
      if (!(k in used)) { print t d k; exit }
    }
  }' "$LIST")"

[ -n "$ID" ] || { echo "编号已耗尽（${TYPE}-${DATE}-001..999 全占）" >&2; exit 2; }
[ "$WANT_CLAIM" -eq 0 ] && { echo "$ID"; exit 0; }

# 原子占用：set -o noclobber 下 `: > 文件` 在文件已存在时失败且不截断。
# 两个 agent 同秒拿到同一个号时只有一个成功，另一个拿 exit 3 去重跑。
mkdir -p "$CLAIM_DIR"
SLUG="$(basename "$ROOT" | tr -c 'A-Za-z0-9._-' '_')"
CLAIM="$CLAIM_DIR/$ID.$SLUG.claim"
if ! ( set -o noclobber; : > "$CLAIM" ) 2>/dev/null; then
  echo "并发冲突：$ID 已被占用（$(head -1 "$CLAIM" 2>/dev/null || echo '其他工作树')），请重跑" >&2
  exit 3
fi
printf 'worktree=%s\nclaimed_at=%s\n' "$ROOT" "$(date -Iseconds)" > "$CLAIM"
echo "$ID"
echo "$CLAIM"
