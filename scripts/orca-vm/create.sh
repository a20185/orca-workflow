#!/bin/bash
# gov-local-docker 环境配方 create 脚本（T2.3）。
#
# 用法：create.sh <workspaceHostPath> <taskDirRel>
#   workspaceHostPath  宿主工作区绝对路径（挂载为容器内只读 /work）
#   taskDirRel         工作区内任务可写子目录（相对路径，挂载为读写 /work/<taskDirRel>）
# 环境变量：
#   GOV_VM_IMAGE        预构建镜像名（设置则跳过本地构建；错误镜像名由 docker run 报错）
#   GOV_VM_IMAGE_TAG    本地构建镜像 tag（默认 gov-local-docker-sshd:latest）
#   GOV_VM_KEYROOT      SSH 密钥根目录（默认 /tmp/gov-vm-keys；临时资源只在 /tmp）
#   GOV_VM_SSH_WAIT_SECS sshd 端口就绪等待上限秒数（默认 25）
#
# stdout 仅最终 JSON。成功：SSH-mode recipe（connection + userData.resourceId），
# userData.resourceId = 容器名（官方 docker-ssh 参考字段，destroy 据此 docker rm -f）。
# 失败：单行 {"schemaVersion":1,"ok":false,"stage":...,"resourceId":...,"message":...}
# 且 exit 1；docker run 成功后的失败保留容器与密钥供查明，不自动清理。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE_TAG="${GOV_VM_IMAGE_TAG:-gov-local-docker-sshd:latest}"
KEYROOT="${GOV_VM_KEYROOT:-/tmp/gov-vm-keys}"
WAIT_SECS="${GOV_VM_SSH_WAIT_SECS:-25}"

# JSON 字符串字面量（含引号转义）：优先 python3，缺失时退化到字符净化。
json_str() {
  if command -v python3 >/dev/null 2>&1; then
    python3 -c 'import json,sys; sys.stdout.write(json.dumps(sys.argv[1]))' "$1"
  else
    printf '"%s"' "$(printf '%s' "$1" | tr -d '\000-\037' | sed 's/\\/\\\\/g; s/"/\\"/g')"
  fi
}

emit_fail() { # <stage> <message> <resourceId|->
  local stage="$1" message="$2" rid="$3"
  if [ "$rid" = "-" ]; then
    printf '{"schemaVersion":1,"ok":false,"stage":%s,"message":%s}\n' "$(json_str "$stage")" "$(json_str "$message")"
  else
    printf '{"schemaVersion":1,"ok":false,"stage":%s,"resourceId":%s,"message":%s}\n' \
      "$(json_str "$stage")" "$(json_str "$rid")" "$(json_str "$message")"
  fi
  exit 1
}

log() { printf '[create.sh] %s\n' "$*" >&2; }

# --- 参数校验 -------------------------------------------------------------
if [ "$#" -ne 2 ]; then
  emit_fail 'args' "用法: create.sh <workspaceHostPath> <taskDirRel>" "-"
fi
WS="$1"
REL="$2"

case "$WS" in
  /*) ;;
  *) emit_fail 'args' "workspaceHostPath 必须是绝对路径: $WS" "-" ;;
esac
REL_OK=1
IFS='/' read -r -a REL_SEGS <<<"$REL"
[ "$REL" = '' ] && REL_OK=0
for seg in "${REL_SEGS[@]}"; do
  case "$seg" in
    ''|'.'|'..') REL_OK=0 ;;
  esac
done
if [ "$REL_OK" != 1 ]; then
  emit_fail 'args' "taskDirRel 非法（须为不含 . / .. / 空段的相对子路径）: $REL" "-"
fi
if [ ! -d "$WS" ]; then
  emit_fail 'args' "workspaceHostPath 不是目录: $WS" "-"
fi
if [ ! -d "$WS/$REL" ]; then
  emit_fail 'args' "可写子目录不存在: $WS/$REL" "-"
fi

# --- 资源命名与 SSH 密钥 ---------------------------------------------------
NAME="gov-vm-$(date +%s)-$$-$RANDOM"
KEYDIR="$KEYROOT/$NAME"
mkdir -p "$KEYDIR"
chmod 700 "$KEYDIR"
ssh-keygen -q -t ed25519 -N '' -f "$KEYDIR/id_ed25519" >/dev/null 2>&1 \
  || emit_fail 'ssh-keygen' "生成 SSH 密钥对失败" "$NAME"
PUBKEY="$(cat "$KEYDIR/id_ed25519.pub")"

# --- 镜像：预构建名优先，否则按需本地构建（利用层缓存） --------------------
if [ -n "${GOV_VM_IMAGE:-}" ]; then
  IMAGE="$GOV_VM_IMAGE"
else
  IMAGE="$IMAGE_TAG"
  if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
    log "镜像不存在，本地构建 $IMAGE"
    docker build -t "$IMAGE" "$SCRIPT_DIR" >&2 || emit_fail 'docker-build' "镜像构建失败" "$NAME"
  fi
fi

# --- 起容器：双层挂载 + tmpfs 遮蔽 + 资源上限 + 随机映射端口 ---------------
# /work 只读 = 工作区根；/work/<REL> 读写 = 任务可写区；/work/.jj 与 /work/.git
# 叠空只读 tmpfs 遮蔽（读保护：Docker Desktop macOS 架空宿主 DAC，只能靠遮蔽）。
log "docker run --name ${NAME}（image=$IMAGE ws=$WS rel=${REL}）"
if ! CID="$(docker run -d \
  --name "$NAME" \
  -u 1000:1000 \
  --memory 2g --cpus 2 --pids-limit 256 \
  -p 127.0.0.1::22 \
  -e ORCA_SSH_PUBLIC_KEY="$PUBKEY" \
  -v "$WS:/work:ro" \
  -v "$WS/$REL:/work/$REL:rw" \
  --tmpfs /work/.jj:ro,size=64k \
  --tmpfs /work/.git:ro,size=64k \
  "$IMAGE")"; then
  rm -rf "$KEYDIR"
  emit_fail 'docker-run' "docker run 失败（image=${IMAGE}）" "$NAME"
fi
CID="$(docker inspect --format '{{.Id}}' "$NAME" 2>/dev/null || printf '%s' "$CID")"

# --- 等待 sshd 端口就绪 ----------------------------------------------------
port_open() {
  if command -v nc >/dev/null 2>&1; then
    nc -z -w 2 127.0.0.1 "$1" >/dev/null 2>&1
  else
    (exec 3<>"/dev/tcp/127.0.0.1/$1") >/dev/null 2>&1 && exec 3>&- 3<&- || return 1
  fi
}
PORT=""
for _ in $(seq 1 "$WAIT_SECS"); do
  LINE_PORT="$(docker port "$NAME" 22 2>/dev/null | head -n1 || true)"
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
  docker logs "$NAME" >&2 || true
  emit_fail 'ssh-wait' "sshd 端口 ${WAIT_SECS}s 内未就绪（容器保留供查明）" "$NAME"
fi

# --- accept 前只读：宿主把可写区置 0000（0 权限在任何所有权映射下拒所有人） --
if ! chmod 0000 "$WS/$REL" 2>/dev/null; then
  emit_fail 'chmod-lock' "宿主 chmod 0000 失败: $WS/${REL}（容器保留供查明）" "$NAME"
fi

# --- 输出 SSH-mode recipe（字段名对齐官方 docker-ssh 参考） ----------------
printf '{"schemaVersion":1,"connection":{"type":"ssh","host":"127.0.0.1","port":%s,"username":"task","identityFile":%s,"identitiesOnly":true,"projectRoot":"/work"},"userData":{"resourceId":%s,"containerId":%s}}\n' \
  "$PORT" "$(json_str "$KEYDIR/id_ed25519")" "$(json_str "$NAME")" "$(json_str "$CID")"
