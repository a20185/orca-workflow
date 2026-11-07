#!/bin/sh
# gov-local-docker 容器入口（T2.3）。以 uid1000 运行（docker run -u 1000:1000）：
# 1. 每容器首启生成唯一 SSH host key（容器生命周期内保留，绝不跨容器分发）；
# 2. 把 ORCA_SSH_PUBLIC_KEY 注入的公钥写入任务用户 authorized_keys 后立即 unset；
# 3. 以前台 sshd 监听 22（file capability 允许非 root 绑定特权端口）。
set -eu

[ "$(id -u)" = "1000" ] || { echo "gov-vm-entrypoint: 必须以 uid 1000 运行" >&2; exit 1; }

HOSTKEY_DIR="$HOME/gov-ssh-hostkeys"
mkdir -p "$HOSTKEY_DIR"
chmod 700 "$HOSTKEY_DIR"
if [ ! -f "$HOSTKEY_DIR/ssh_host_ed25519_key" ]; then
  ssh-keygen -q -t ed25519 -N '' -f "$HOSTKEY_DIR/ssh_host_ed25519_key"
fi

mkdir -p "$HOME/.ssh"
chmod 700 "$HOME/.ssh"
if [ -n "${ORCA_SSH_PUBLIC_KEY:-}" ]; then
  printf '%s\n' "$ORCA_SSH_PUBLIC_KEY" > "$HOME/.ssh/authorized_keys"
  chmod 600 "$HOME/.ssh/authorized_keys"
  unset ORCA_SSH_PUBLIC_KEY
fi

exec /usr/sbin/sshd -D -e -h "$HOSTKEY_DIR/ssh_host_ed25519_key"
