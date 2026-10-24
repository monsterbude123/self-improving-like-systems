#!/usr/bin/env bash
# next-id.sh —— .learnings 条目编号分配器（多工作树并发场景）
#
# 编号方案（2026-10-24 改）：LRN|ERR|FEAT-YYYYMMDD-HHMMSS（本地时分秒，六位）。
# 顺序号（NNN,001..999）是**存量形态**：只读兼容、永不复用 —— 它对「看得见别人」零容忍，
# 而五层可见域是启发式（兄弟树路径枚举、分支名都是猜测），漏看一个就撞号（2026-10-18 实测 10 组）。
# 六位时基把撞号条件压到「同日同型同秒」；同机同秒由 claim 原子占用兜住（exit 3，重跑即得新秒），
# 残余风险只剩跨机器克隆同秒。
#
# **claim 按 ID 唯一**（2026-10-24 改）：文件名是 `<ID>.claim`，工作树身份只写在文件内容里。
# 旧形态 `$ID.$SLUG.claim` 让两棵工作树对同一 ID 各建各的文件、noclobber 双双成功 ——
# 「同机同秒已兜住」一直是假的（OCR 评审 2026-10-24 实证），本次一并修掉。
#
# 用法：
#   bash scripts/next-id.sh LRN              # 探测下一个可用编号
#   bash scripts/next-id.sh LRN --claim      # 探测 + 原子占用（**建文件必须走这条**,探测不落账本）
#   bash scripts/next-id.sh --audit [YYYYMMDD]  # 列出跨工作树的真撞号（三/六位双形态）
#
# 退出码：0 成功 / 2 避让上限耗尽（连续 120 秒候选全被占）/ 3 并发占用冲突（重跑即可）
#
# O(1) spawn：枚举走 bash glob + 单次 awk，不用 find / grep -r
# （见 ERR-20261010-001：O(行数)×(进程 spawn) 会把门禁拖成小时级）。
# 2026-10-20 补：取文件名一律 `${f##*/}` 参数展开，**不用 basename**。
# basename 是外部命令 = 每个文件一次 fork；claim 目录一旦积压（判据自己的残留就能堆到几百个），
# 单次取号就从毫秒级涨到十几秒，整条判据被拖成分钟级。参数展开是 bash 内建，0 fork。
# 五层扫描的文件层与 claim 层 glob 都按 `TYPE-DATE-*` 限界：成本只随当天条目数走，不随账本全量涨。
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
  echo "  bash scripts/next-id.sh <LRN|ERR|FEAT>              # 探测" >&2
  echo "  bash scripts/next-id.sh <LRN|ERR|FEAT> --claim      # 探测+占用" >&2
  echo "  bash scripts/next-id.sh --audit [YYYYMMDD]          # 列撞号" >&2
  exit 2
}

# ---- --audit：跨全部工作树列出「同号不同文件」的撞号（三/六位双形态）----
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
      # 双形态 ID 抽取：六位分支在前（前缀锚定的 match+substr 下,三位在前会把
      # 六位号截断成三位假 ID,制造假撞号组）；尾段必须是纯数字串（后随 - 或 . 或行尾）,
      # 边界字符不得进抽取串（substr 按 RSTART+RLENGTH 截,吃了边界就污染撞号键）。
      # POSIX ERE：平铺交替、无环视。
      if (match(b, /^(LRN|ERR|FEAT)-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9][0-9][0-9]/)) {
        id = substr(b, RSTART, RLENGTH)
      } else if (match(b, /^(LRN|ERR|FEAT)-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-[0-9][0-9][0-9]/)) {
        # 三位分支不带边界组:六位分支已在前,走到这里尾段必然恰为三位(再带数字会先命中六位);
        # 带边界组会让 substr 把 -/. 吃进抽取串,「999.md」与「999-x.md」被记成两个键,真撞号漏报。
        id = substr(b, RSTART, RLENGTH)
      } else {
        next
      }
      if (index(id, "-" d "-") == 0) next
      cnt[id]++
      paths[id] = paths[id] "\n    " $2 "/" b
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
TIME="${LEARNINGS_TIME:-$(date +%H%M%S)}"
HH="${TIME:0:2}"; MM="${TIME:2:2}"; SS="${TIME:4:2}"
LIST="$(mktemp)"; trap 'rm -f "$LIST"' EXIT

# ---- 五层可见域（占用检测,不再决定发放值）----
# ① 本工作树 .learnings/        已落盘、可能未提交
# ② 主检出 .learnings/          并发 agent 也可能直接在主检出里写
# ③ 兄弟工作树 .learnings/      **未提交条目藏在这里**
# ④ claim 文件                   原子占用记录,覆盖「同一秒并发取到同一个号」
# ⑤ my_dev 分支上已提交条目      已提交但尚未合入本工作树的
# 三层 glob 都按 `TYPE-DATE-*` 限界；发放值取自时间轴,扫描只回答「这个秒被占了没有」。
{
  for d in "$ROOT/.learnings" "$MAIN_ROOT/.learnings" "$MAIN_ROOT"/.worktrees/*/.learnings; do
    [ -d "$d" ] || continue
    for f in "$d/${TYPE}-${DATE}-"*.md; do [ -e "$f" ] && printf '%s\n' "${f##*/}"; done
  done
  for f in "$CLAIM_DIR/${TYPE}-${DATE}-"*.claim; do [ -e "$f" ] && printf '%s\n' "${f##*/}"; done
  git -C "$MAIN_ROOT" ls-tree -r --name-only my_dev -- .learnings 2>/dev/null || true
} > "$LIST"

# 候选 = 当前时刻时分秒;被占则 +1 秒避让（进位跨分跨时在 sprintf 前归一）,
# 连续 120 秒全占用才 exit 2（同机同秒已由 claim 兜住,此上限是 fail-closed 兜底,正常用不到）。
# 尾段解析与 --audit 同口径:纯数字串,边界 = 其后的 - 或 . 或行尾;六位分支在前。
ID="$(awk -v t="$TYPE-" -v d="$DATE-" -v hh="$HH" -v mm="$MM" -v ss="$SS" '
  {
    n = $0
    sub(/^.*\//, "", n)
    if (index(n, t d) != 1) next
    rest = substr(n, length(t d) + 1)
    if (match(rest, /^[0-9][0-9][0-9][0-9][0-9][0-9]([-.]|$)/)) used6[substr(rest, 1, 6)] = 1
    else if (match(rest, /^[0-9][0-9][0-9]([-.]|$)/)) used3[substr(rest, 1, 3)] = 1
  }
  END {
    sec = (hh * 3600 + mm * 60 + ss) % 86400
    for (i = 0; i < 120; i++) {
      s = (sec + i) % 86400
      k = sprintf("%02d%02d%02d", int(s / 3600), int((s % 3600) / 60), s % 60)
      if (!(k in used6)) { print k; exit }
    }
    print ""
  }' "$LIST")"

[ -n "$ID" ] || { echo "避让上限耗尽:候选时分秒连续 120 秒均被占用（${TYPE}-${DATE}-*）。请人工核查账本" >&2; exit 2; }
[ "$WANT_CLAIM" -eq 0 ] && { echo "${TYPE}-${DATE}-${ID}"; exit 0; }

# 原子占用：set -o noclobber 下 `: > 文件` 在文件已存在时失败且不截断。
# claim 文件按 **ID 唯一**（无工作树 slug 段）—— 两棵工作树同秒抢同一号时,
# 后到者的 `: >` 必失败,拿 exit 3 去重跑（重跑时时刻已走秒,自然换号）。
mkdir -p "$CLAIM_DIR"
SLUG="$(basename "$ROOT" | tr -c 'A-Za-z0-9._-' '_')"
CLAIM="$CLAIM_DIR/$TYPE-$DATE-$ID.claim"
if ! ( set -o noclobber; : > "$CLAIM" ) 2>/dev/null; then
  echo "并发冲突：${TYPE}-${DATE}-${ID} 已被占用（$(head -1 "$CLAIM" 2>/dev/null || echo '其他工作树')），请重跑" >&2
  exit 3
fi
printf 'worktree=%s\nslug=%s\nclaimed_at=%s\n' "$ROOT" "$SLUG" "$(date -Iseconds)" > "$CLAIM"
echo "${TYPE}-${DATE}-${ID}"
echo "$CLAIM"
