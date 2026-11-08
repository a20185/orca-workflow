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
#   GOV_GUARD_ORCA_BUNDLE 真 CLI bundle 宿主目录（含 out/{cli,shared,main} 与
#                        node_modules；T5.1 部署步骤，拷入容器 /opt/orca-broker/cli）
#   GOV_GUARD_IDENTITY  guard 身份 JSON（govToken/govBaseUrl/taskId/claimId/
#                        terminalHandle/dispatchId/orcaPairingCode；broker 0600 落
#                        /var/lib/orca-broker/identity.json）
#   两者都缺省时行为与 T2.3 完全一致（不部署 guard 面）。
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
# 构建上下文在 /tmp 组装（仓库不进 .gitignore 改动）：Dockerfile 引用的
# guard.mjs / sudoers / orca 垫片从仓库真源拷入，保证镜像面与 src/guard 同源。
stage_buildctx() {
  local ctx
  ctx="$(mktemp -d "${TMPDIR:-/tmp}/gov-vm-buildctx-XXXXXX")"
  cp "$SCRIPT_DIR/Dockerfile" "$SCRIPT_DIR/entrypoint.sh" "$ctx/" \
    || { rm -rf "$ctx"; return 1; }
  cp "$SCRIPT_DIR/orca-shim" "$ctx/orca-shim" || { rm -rf "$ctx"; return 1; }
  cp "$SCRIPT_DIR/../../src/guard/guard.mjs" "$ctx/guard.mjs" || { rm -rf "$ctx"; return 1; }
  cp "$SCRIPT_DIR/../../deploy/sudoers/gov-guard" "$ctx/gov-guard.sudoers" || { rm -rf "$ctx"; return 1; }
  printf '%s' "$ctx"
}

if [ -n "${GOV_VM_IMAGE:-}" ]; then
  IMAGE="$GOV_VM_IMAGE"
else
  IMAGE="$IMAGE_TAG"
  if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
    BUILDCTX="$(stage_buildctx)" || emit_fail 'docker-build' "组装构建上下文失败（缺 guard/sudoers 真源文件）" "-"
    log "镜像不存在，本地构建 ${IMAGE}（ctx=${BUILDCTX}）"
    if ! docker build -t "$IMAGE" "$BUILDCTX" >&2; then
      rm -rf "$BUILDCTX"
      emit_fail 'docker-build' "镜像构建失败" "$NAME"
    fi
    rm -rf "$BUILDCTX"
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

# --- T5.1 guard 面部署（GOV_GUARD_* 缺省时整段跳过，行为与 T2.3 一致） -----
# 步骤：真 CLI bundle 拷入 broker 0700 目录 + bin/orca 包装脚本 + 身份文件
# （broker 0600）+ 任务用户工作区信任种子（/work 预信任，T2.1 实证口径）。
# 全部经 docker cp / docker exec -u 0 完成，不经容器内 shell 拼接凭据。
guard_provision() {
  local stage_tmp rc
  stage_tmp="$(mktemp -d "${TMPDIR:-/tmp}/gov-vm-guard-XXXXXX")"
  rc=0

  if [ -n "${GOV_GUARD_ORCA_BUNDLE:-}" ]; then
    if [ ! -d "$GOV_GUARD_ORCA_BUNDLE/out/cli" ]; then
      rm -rf "$stage_tmp"; emit_fail 'guard-provision' "GOV_GUARD_ORCA_BUNDLE 缺 out/cli: $GOV_GUARD_ORCA_BUNDLE" "$NAME"
    fi
    docker cp "$GOV_GUARD_ORCA_BUNDLE/." "$NAME:/opt/orca-broker/cli/" >/dev/null 2>&1 || rc=1
    # bin/orca 包装：真 CLI 入口（bundle 内 out/cli/index.js 以纯 Node 运行）。
    printf '%s\n' \
      '#!/bin/sh' \
      'exec /usr/local/bin/node /opt/orca-broker/cli/out/cli/index.js "$@"' \
      > "$stage_tmp/orca"
    docker cp "$stage_tmp/orca" "$NAME:/opt/orca-broker/bin/orca" >/dev/null 2>&1 || rc=1
    docker exec -u 0 "$NAME" sh -c \
      'chown -R orca-broker:orca-broker /opt/orca-broker && chmod 0700 /opt/orca-broker && chmod 0755 /opt/orca-broker/bin/orca' \
      >/dev/null 2>&1 || rc=1
    # 可执行性验证：broker 身份能拿到 CLI 版本号。
    docker exec -u 1200 "$NAME" /opt/orca-broker/bin/orca --version >/dev/null 2>&1 || rc=1
  fi

  if [ -n "${GOV_GUARD_IDENTITY:-}" ]; then
    case "$GOV_GUARD_IDENTITY" in
      '{'*'}') ;;
      *) rm -rf "$stage_tmp"; emit_fail 'guard-provision' "GOV_GUARD_IDENTITY 不是 JSON 对象" "$NAME" ;;
    esac
    printf '%s' "$GOV_GUARD_IDENTITY" > "$stage_tmp/identity.json"
    docker cp "$stage_tmp/identity.json" "$NAME:/var/lib/orca-broker/identity.json" >/dev/null 2>&1 || rc=1
    docker exec -u 0 "$NAME" sh -c \
      'chown orca-broker:orca-broker /var/lib/orca-broker/identity.json && chmod 0600 /var/lib/orca-broker/identity.json' \
      >/dev/null 2>&1 || rc=1
  fi

  # 工作区信任种子：容器内任务用户的 Claude 配置预信任 /work（T2.1 同口径
  # hasTrustDialogAccepted；首个 agent 不会死于 agent-trust-workspace 信任门）。
  if [ -n "${GOV_GUARD_ORCA_BUNDLE:-}" ] || [ -n "${GOV_GUARD_IDENTITY:-}" ]; then
    printf '%s\n' \
      '{"projects":{"/work":{"hasTrustDialogAccepted":true}}}' \
      > "$stage_tmp/claude.json"
    docker cp "$stage_tmp/claude.json" "$NAME:/home/task/.claude.json" >/dev/null 2>&1 || rc=1
    docker exec -u 0 "$NAME" sh -c \
      'chown 1000:1000 /home/task/.claude.json && chmod 0644 /home/task/.claude.json' \
      >/dev/null 2>&1 || rc=1
  fi

  rm -rf "$stage_tmp"
  if [ "$rc" != 0 ]; then
    emit_fail 'guard-provision' "guard 面部署失败（容器保留供查明）" "$NAME"
  fi
}

if [ -n "${GOV_GUARD_ORCA_BUNDLE:-}" ] || [ -n "${GOV_GUARD_IDENTITY:-}" ]; then
  log "部署 T5.1 guard 面（bundle=${GOV_GUARD_ORCA_BUNDLE:-无} identity=$([ -n "${GOV_GUARD_IDENTITY:-}" ] && printf 有 || printf 无)）"
  guard_provision
fi

# --- accept 前只读：宿主把可写区置 0000（0 权限在任何所有权映射下拒所有人） --
if ! chmod 0000 "$WS/$REL" 2>/dev/null; then
  emit_fail 'chmod-lock' "宿主 chmod 0000 失败: $WS/${REL}（容器保留供查明）" "$NAME"
fi

# --- 输出 SSH-mode recipe（字段名对齐官方 docker-ssh 参考） ----------------
printf '{"schemaVersion":1,"connection":{"type":"ssh","host":"127.0.0.1","port":%s,"username":"task","identityFile":%s,"identitiesOnly":true,"projectRoot":"/work"},"userData":{"resourceId":%s,"containerId":%s}}\n' \
  "$PORT" "$(json_str "$KEYDIR/id_ed25519")" "$(json_str "$NAME")" "$(json_str "$CID")"
