# gov-local-docker 环境配方基础镜像（T2.3 + T5.1 + T5.2 统一真源）。
#
# 这是镜像的唯一真源：scripts/orca-vm/create.sh 组装构建上下文时从这里拷入
# Dockerfile / entrypoint.sh / orca-shim（guard.mjs 与 sudoers 仍从各自真源
# src/guard/guard.mjs、deploy/sudoers/gov-guard 拷入），保证镜像面与 src 同源。
#
# 用户面（机制裁定 6 + T5.1 §9.2）：
# - uid1000 任务用户（task）：SSH 会话与 Agent（claude）的运行身份，非 root。
# - orca-broker 用户（uid 1200，HOME=/var/lib/orca-broker，nologin）：持有真
#   CLI 目录 /opt/orca-broker（0700）与身份文件；guard 是任务用户到 broker 的
#   唯一入口（sudoers 单条目）。
#
# sshd 非 root 绑定端口（T5.2 变更）：sshd 以 uid1000 运行，监听 2222（非特权
# 端口）。T5.1 的 setcap cap_net_bind_service 方案已移除——它与 create.sh 的
# --cap-drop=ALL 冲突（file capability 不在 bounding set 内时 execve 直接 EPERM），
# 且 Docker Desktop 默认 sysctl ip_unprivileged_port_start=0 本就架空特权端口。
# Linux 迁移前按 deploy/README.md 重跑 T0.4 确认端口面。
#
# claude CLI（T5.2）：多阶段从 node:24-slim 以 npm 钉版安装 @anthropic-ai/
# claude-code，落 /opt/claude-code/package（orca-broker 属主 0755，任务用户可
# 执行不可改），/usr/local/bin/claude 为 root 属主符号链接（全局可执行）。
# gov 侧预置配置放 /etc/claude-code/managed-settings.json（broker 属主 0644，
# 任务用户只读——防御性 hooks/策略的宿主侧注入点，T5.3 填充内容）；任务用户
# 自身运行态（~/.claude 等）不在镜像内预置。
#
# setuid/setgid 剥离（T5.1）：apt 装 sudo 后，除 /usr/bin/sudo、/usr/bin/su 外
# 全部去位并断言清单恰好只剩二者；该步置于 claude 安装之后，覆盖镜像最终态。
FROM node:24-slim AS claude-fetch
# 钉版保证镜像可复现；升级版本走显式改此行（不追 latest）。
RUN npm install -g @anthropic-ai/claude-code@2.1.319

FROM debian:13-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends openssh-server sudo \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd -g 1000 task \
 && useradd -m -u 1000 -g 1000 -s /bin/bash task \
 && groupadd -g 1200 orca-broker \
 && useradd -M -u 1200 -g 1200 -d /var/lib/orca-broker -s /usr/sbin/nologin orca-broker \
 # privilege separation 目录须已存在且 root 属主（镜像内创建，运行时只读）。
 && mkdir -p /run/sshd && chown root:root /run/sshd && chmod 755 /run/sshd

# 真 Node 运行时（多阶段，glibc 同源；arm64/amd64 随平台解析）：guard 与真 CLI
# 的运行面（Phase 5.1 传输探针实证无需 Electron）。
COPY --from=node:24-slim /usr/local/bin/node /usr/local/bin/node

# claude CLI（安装面属 broker；任务用户经 /usr/local/bin/claude 全局可执行）。
COPY --from=claude-fetch --chown=orca-broker:orca-broker \
  /usr/local/lib/node_modules/@anthropic-ai/claude-code /opt/claude-code/package
# 构建期双身份冒烟：ELF 在 debian:13-slim 上可执行，且 broker/task 都能跑。
RUN ln -s /opt/claude-code/package/bin/claude.exe /usr/local/bin/claude \
 && mkdir -p /etc/claude-code \
 && printf '%s\n' '{}' > /etc/claude-code/managed-settings.json \
 && chown -R orca-broker:orca-broker /etc/claude-code \
 && chmod 0755 /etc/claude-code \
 && chown orca-broker:orca-broker /etc/claude-code/managed-settings.json \
 && chmod 0644 /etc/claude-code/managed-settings.json \
 && chmod 0755 /opt/claude-code/package/bin/claude.exe \
 && su -s /bin/sh -c '/usr/local/bin/claude --version' orca-broker \
 && su -s /bin/sh -c '/usr/local/bin/claude --version' task

# 非 root sshd 配置：仅任务用户、仅公钥登录；PidFile=none（/run 不可写）；
# Port 2222（非特权端口，见文件头注记）。
RUN printf '%s\n' \
  'PasswordAuthentication no' \
  'KbdInteractiveAuthentication no' \
  'PermitRootLogin no' \
  'PubkeyAuthentication yes' \
  'UsePAM no' \
  'StrictModes yes' \
  'PidFile none' \
  'Port 2222' \
  > /etc/ssh/sshd_config.d/10-gov.conf

# T5.1 面：broker 骨架目录 + guard + 垫片 + sudoers。
# guard/orca 垫片来自 deploy/docker/（create.sh 组装构建上下文时拷入同级）。
COPY guard.mjs /usr/local/lib/gov/guard
COPY gov-guard.sudoers /etc/sudoers.d/gov-guard
COPY orca-shim /usr/local/bin/orca
RUN mkdir -p /opt/orca-broker/bin /opt/orca-broker/cli /var/lib/orca-broker \
 && chown -R orca-broker:orca-broker /opt/orca-broker /var/lib/orca-broker \
 && chmod 0700 /opt/orca-broker /var/lib/orca-broker \
 && chmod 0755 /usr/local/lib/gov/guard /usr/local/bin/orca \
 && chmod 0440 /etc/sudoers.d/gov-guard \
 && chown root:root /usr/local/lib/gov/guard /usr/local/bin/orca /etc/sudoers.d/gov-guard

# T5.1：剔除非必要 setuid/setgid（保留 sudo/su——sudoers 面依赖 sudo 的
# setuid root；su 保留作容器内紧急运维通道），随后断言清单恰好只剩二者。
# mv/chfn/passwd/newgrp/mount/umount/ssh-keysign 等一律去位；去位后对应功能
# 不可用是预期（任务用户不需要本地改密/挂载/主机认证）。置于 claude 安装后，
# 覆盖镜像最终文件面。
RUN find / -xdev -perm /6000 -type f \
  ! -path /usr/bin/sudo ! -path /usr/bin/su \
  -exec chmod u-s,g-s {} + \
 && EXPECTED="$(printf '/usr/bin/sudo\n/usr/bin/su\n' | sort)" \
 && ACTUAL="$(find / -xdev -perm /6000 -type f | sort)" \
 && if [ "$EXPECTED" != "$ACTUAL" ]; then \
      echo "setuid/setgid 清单断言失败:" >&2; echo "$ACTUAL" >&2; exit 1; \
    fi

COPY entrypoint.sh /usr/local/bin/gov-vm-entrypoint
RUN chmod 755 /usr/local/bin/gov-vm-entrypoint

USER 1000:1000
WORKDIR /work
ENV HOME=/home/task
ENTRYPOINT ["/usr/local/bin/gov-vm-entrypoint"]
