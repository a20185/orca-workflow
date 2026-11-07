#!/bin/bash
# gov-local-docker 环境配方 suspend 脚本（T2.3）。
# 从 stdin 读生命周期 JSON（create 输出或其子集），取 userData.resourceId
# （兼容 userData.containerId），docker pause 全冻结进程。stdout 仅最终 JSON。
set -euo pipefail

read -r LINE
RID="$(printf '%s' "$LINE" | sed -nE 's/.*"resourceId"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' | head -n1)"
if [ -z "$RID" ]; then
  RID="$(printf '%s' "$LINE" | sed -nE 's/.*"containerId"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' | head -n1)"
fi
if [ -z "$RID" ]; then
  printf '{"schemaVersion":1,"ok":false,"stage":"stdin","message":"生命周期 JSON 缺少 userData.resourceId"}\n'
  exit 1
fi

# 状态格式 <status>:<paused>；容器不存在 → missing（docker inspect 对不存在对象
# 会在 stdout 先吐一个空行，实测），统一剔除空白后判等。
STATE="$({ docker inspect --format '{{.State.Status}}:{{.State.Paused}}' "$RID" 2>/dev/null || printf 'missing'; } | tr -d '[:space:]')"
case "$STATE" in
  missing)
    # 已销毁的容器视为已挂起（幂等），existed=false 交由调用方判断。
    printf '{"schemaVersion":1,"suspended":true,"resourceId":"%s","existed":false}\n' "$RID"
    exit 0
    ;;
  paused:*)
    printf '{"schemaVersion":1,"suspended":true,"resourceId":"%s","existed":true,"already":true}\n' "$RID"
    exit 0
    ;;
  running:*)
    docker pause "$RID" >/dev/null
    printf '{"schemaVersion":1,"suspended":true,"resourceId":"%s","existed":true}\n' "$RID"
    ;;
  *)
    # created/exited 等非运行态无进程可冻结。
    printf '{"schemaVersion":1,"suspended":true,"resourceId":"%s","existed":true,"state":"%s"}\n' "$RID" "${STATE%%:*}"
    ;;
esac
