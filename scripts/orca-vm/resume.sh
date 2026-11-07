#!/bin/bash
# gov-local-docker 环境配方 resume 脚本（T2.3）。
# stdin 读生命周期 JSON 取 userData.resourceId；docker unpause（必要时 start），
# 不重建容器——SSH 终端与 Session 保持。stdout 原样重发 create 形态的 recipe
# JSON（连接可能换端口，故重新查询映射端口）。
set -euo pipefail

KEYROOT="${GOV_VM_KEYROOT:-/tmp/gov-vm-keys}"
WAIT_SECS="${GOV_VM_SSH_WAIT_SECS:-15}"

read -r LINE
RID="$(printf '%s' "$LINE" | sed -nE 's/.*"resourceId"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' | head -n1)"
if [ -z "$RID" ]; then
  RID="$(printf '%s' "$LINE" | sed -nE 's/.*"containerId"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' | head -n1)"
fi
if [ -z "$RID" ]; then
  printf '{"schemaVersion":1,"ok":false,"stage":"stdin","message":"生命周期 JSON 缺少 userData.resourceId"}\n'
  exit 1
fi

fail() {
  printf '{"schemaVersion":1,"ok":false,"stage":"%s","resourceId":"%s","message":"%s"}\n' "$1" "$RID" "$2"
  exit 1
}

# docker inspect 对不存在对象会在 stdout 先吐一个空行（实测），统一剔除空白后判等。
STATE="$({ docker inspect --format '{{.State.Status}}:{{.State.Paused}}' "$RID" 2>/dev/null || printf 'missing'; } | tr -d '[:space:]')"
if [ "$STATE" = missing ]; then
  fail not-found "容器不存在: $RID"
fi
case "$STATE" in
  paused:*) docker unpause "$RID" >/dev/null || fail unpause "docker unpause 失败" ;;
  running:*) ;;
  created:*|exited:*) docker start "$RID" >/dev/null || fail start "docker start 失败" ;;
  *) fail state "不可恢复的容器状态: $STATE" ;;
esac

port_open() {
  if command -v nc >/dev/null 2>&1; then
    nc -z -w 2 127.0.0.1 "$1" >/dev/null 2>&1
  else
    (exec 3<>"/dev/tcp/127.0.0.1/$1") >/dev/null 2>&1 && exec 3>&- 3<&- || return 1
  fi
}
PORT=''
for _ in $(seq 1 "$WAIT_SECS"); do
  LINE_PORT="$(docker port "$RID" 22 2>/dev/null | head -n1 || true)"
  PORT="${LINE_PORT##*:}"
  case "$PORT" in
    ''|*[!0-9]*) PORT=''; sleep 1; continue ;;
  esac
  if port_open "$PORT"; then
    break
  fi
  PORT=''
  sleep 1
done
if [ -z "$PORT" ]; then
  docker logs "$RID" >&2 || true
  fail ssh-wait "resume 后 sshd 端口 ${WAIT_SECS}s 内未就绪"
fi

CID="$(docker inspect --format '{{.Id}}' "$RID" 2>/dev/null || printf '?')"
KEY="$KEYROOT/$RID/id_ed25519"
if [ -f "$KEY" ]; then
  IDENTITY_JSON="$(printf ',"identityFile":"%s","identitiesOnly":true' "$KEY")"
else
  IDENTITY_JSON=''
fi
printf '{"schemaVersion":1,"connection":{"type":"ssh","host":"127.0.0.1","port":%s,"username":"task"%s,"projectRoot":"/work"},"userData":{"resourceId":"%s","containerId":"%s"}}\n' \
  "$PORT" "$IDENTITY_JSON" "$RID" "$CID"
