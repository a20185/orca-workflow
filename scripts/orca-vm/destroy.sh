#!/bin/bash
# gov-local-docker 环境配方 destroy 脚本（T2.3）。
# stdin 读生命周期 JSON 取 userData.resourceId（官方 docker-ssh 参考字段），
# docker rm -f（对 paused 容器同样有效）；容器已不存在视为成功（幂等）；
# 顺带清理该容器的 SSH 密钥目录。rm -f 真失败时保留 resourceId 供查明。
set -euo pipefail

KEYROOT="${GOV_VM_KEYROOT:-/tmp/gov-vm-keys}"

read -r LINE
RID="$(printf '%s' "$LINE" | sed -nE 's/.*"resourceId"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' | head -n1)"
if [ -z "$RID" ]; then
  RID="$(printf '%s' "$LINE" | sed -nE 's/.*"containerId"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' | head -n1)"
fi
if [ -z "$RID" ]; then
  printf '{"schemaVersion":1,"ok":false,"stage":"stdin","message":"生命周期 JSON 缺少 userData.resourceId"}\n'
  exit 1
fi

if docker inspect "$RID" >/dev/null 2>&1; then
  if ! docker rm -f "$RID" >/dev/null 2>&1; then
    printf '{"schemaVersion":1,"ok":false,"stage":"rm","resourceId":"%s","message":"docker rm -f 失败（容器保留供查明）"}\n' "$RID"
    exit 1
  fi
  EXISTED=true
else
  EXISTED=false
fi

rm -rf "$KEYROOT/$RID" 2>/dev/null || true
printf '{"schemaVersion":1,"destroyed":true,"resourceId":"%s","existed":%s}\n' "$RID" "$EXISTED"
