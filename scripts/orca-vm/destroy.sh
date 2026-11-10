#!/bin/bash
# gov-local-docker 环境配方 destroy 脚本（T2.3；T5.2 增符号链接审计）。
# stdin 读生命周期 JSON 取 userData.resourceId（官方 docker-ssh 参考字段），
# docker rm -f（对 paused 容器同样有效）；容器已不存在视为成功（幂等）；
# 顺带清理该容器的 SSH 密钥目录。rm -f 真失败时保留 resourceId 供查明。
#
# T5.2 符号链接审计（设计 §11.1.8 口径）：容器仍存活时，先在容器内重跑
# create.sh 同款 `find /work -type l`，与 create 时基线对比，新增符号链接写入
# 清理回执的 symlinkAudit.new（audit 事件），不阻断销毁——审计任何一步失败都
# 只降级为 scanned:false + error，rm 照常执行。宿主侧配合：基线旁的
# workspace-meta.txt 记录工作区路径，扫描前把可写子目录恢复 0755（真实 DAC
# 宿主上 0000 目录不可读；该恢复与适配器 destroy 的收尾模式一致）。
#
# stdout 仅最终单行 JSON；symlinkAudit 为新增可选字段（调用方 schema passthrough）。
set -euo pipefail

KEYROOT="${GOV_VM_KEYROOT:-/tmp/gov-vm-keys}"

# JSON 字符串字面量（含引号转义）：优先 python3，缺失时退化到字符净化。
json_str() {
  if command -v python3 >/dev/null 2>&1; then
    python3 -c 'import json,sys; sys.stdout.write(json.dumps(sys.argv[1]))' "$1"
  else
    printf '"%s"' "$(printf '%s' "$1" | tr -d '\000-\037' | sed 's/\\/\\\\/g; s/"/\\"/g')"
  fi
}

read -r LINE
RID="$(printf '%s' "$LINE" | sed -nE 's/.*"resourceId"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' | head -n1)"
if [ -z "$RID" ]; then
  RID="$(printf '%s' "$LINE" | sed -nE 's/.*"containerId"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' | head -n1)"
fi
if [ -z "$RID" ]; then
  printf '{"schemaVersion":1,"ok":false,"stage":"stdin","message":"生命周期 JSON 缺少 userData.resourceId"}\n'
  exit 1
fi

# --- 符号链接审计（仅容器存活时可做；一切失败降级，不阻断销毁） --------------
# 注意：本函数在 set -e 下运行，内部任何失败都必须就地降级为 scanned:false，
# 绝不让 errexit 抢在 docker rm -f 之前终止脚本。
AUDIT_JSON='{"scanned":false,"baselineCount":-1,"new":[]}'
collect_symlink_audit() {
  local base_file meta_file ws rel live_file baseline_count new_json
  base_file="$KEYROOT/$RID/symlink-baseline.txt"
  meta_file="$KEYROOT/$RID/workspace-meta.txt"
  if [ ! -f "$base_file" ]; then
    # 容器由 T5.2 之前的 create 建出（或密钥目录已清）：无基线可对比。
    AUDIT_JSON='{"scanned":false,"baselineCount":-1,"new":[],"error":"no-baseline"}'
    return 0
  fi
  baseline_count="$(wc -l < "$base_file" | tr -d ' ')"
  # 宿主侧恢复可读位（真实 DAC 宿主上 0000 可写区会挡住容器内 find；macOS
  # fakeowner 不受影响）。失败继续——best-effort。
  if [ -f "$meta_file" ]; then
    ws="$(sed -n '1p' "$meta_file")"
    rel="$(sed -n '2p' "$meta_file")"
    if [ -n "$ws" ] && [ -n "$rel" ] && [ -d "$ws/$rel" ]; then
      chmod 0755 "$ws/$rel" 2>/dev/null || true
    fi
  fi
  live_file="$(mktemp "${TMPDIR:-/tmp}/gov-vm-symlinks-XXXXXX" 2>/dev/null || true)"
  if [ -z "$live_file" ] || [ ! -f "$live_file" ]; then
    AUDIT_JSON='{"scanned":false,"baselineCount":'"$baseline_count"',"new":[],"error":"mktemp-failed"}'
    return 0
  fi
  if ! docker exec -u 0 "$RID" sh -c 'find /work -type l 2>/dev/null' | LC_ALL=C sort > "$live_file" 2>/dev/null; then
    rm -f "$live_file"
    AUDIT_JSON="$(printf '{"scanned":false,"baselineCount":%s,"new":[],"error":%s}' \
      "$baseline_count" "$(json_str 'live-scan-failed:容器不可 exec（可能已退出/paused）')")"
    return 0
  fi
  # 新增 = live 有而 baseline 无的行（双排序清单做差集；工具失败降级空清单）。
  if command -v python3 >/dev/null 2>&1; then
    new_json="$({ python3 - "$base_file" "$live_file" 2>/dev/null <<'PYEOF' || printf '[]'
import json, sys
base = set(open(sys.argv[1], encoding='utf-8', errors='replace').read().splitlines())
live = set(open(sys.argv[2], encoding='utf-8', errors='replace').read().splitlines())
sys.stdout.write(json.dumps(sorted(live - base), ensure_ascii=False))
PYEOF
} )"
  else
    new_json="$( (comm -13 "$base_file" "$live_file" 2>/dev/null | sed 's/\\/\\\\/g; s/"/\\"/g' | awk '{printf "%s\"%s\"", (NR>1 ? "," : ""), $0}' | sed 's/^/[/; s/$/]/') || printf '[]' )"
  fi
  rm -f "$live_file"
  AUDIT_JSON="$(printf '{"scanned":true,"baselineCount":%s,"new":%s}' "$baseline_count" "${new_json:-[]}")"
}

if docker inspect "$RID" >/dev/null 2>&1; then
  collect_symlink_audit
  if ! docker rm -f "$RID" >/dev/null 2>&1; then
    printf '{"schemaVersion":1,"ok":false,"stage":"rm","resourceId":"%s","message":"docker rm -f 失败（容器保留供查明）"}\n' "$RID"
    exit 1
  fi
  EXISTED=true
else
  EXISTED=false
fi

rm -rf "$KEYROOT/$RID" 2>/dev/null || true
printf '{"schemaVersion":1,"destroyed":true,"resourceId":"%s","existed":%s,"symlinkAudit":%s}\n' "$RID" "$EXISTED" "$AUDIT_JSON"
