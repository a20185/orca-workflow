# gov-local-docker 环境配方基础镜像（T2.3 + T5.1 受限启动器）。
#
# 约束（机制裁定 6）：debian + openssh-server + uid1000 任务用户；不装 Agent CLI
# （T5.2 范围）；sshd 监听 22。容器一律以 `-u 1000:1000` 运行，因此 sshd 也以
# 非 root 运行——通过给二进制授予 file capability cap_net_bind_service 绑定特权
# 端口 22（依赖容器默认完整 capability bounding set，故不得 --cap-drop=ALL，
# 也不得 --security-opt no-new-privileges，二者都会架空 setcap）。
#
# T5.1 面（设计 §9.2）：
# - orca-broker 用户（uid 1200，HOME=/var/lib/orca-broker，nologin）持有真 CLI
#   目录 /opt/orca-broker（0700）与身份文件目录；真 CLI 由 create.sh 部署期
#   （GOV_GUARD_ORCA_BUNDLE）拷入，镜像只落骨架与启动器。
# - /usr/local/lib/gov/guard（root:root 0755）= 唯一 sudo 入口；
#   /usr/local/bin/orca（root:root 0755）= preamble 裸命令名垫片，仅转调 guard。
# - sudoers 只含 deploy/sudoers/gov-guard 一条（task → orca-broker 的 guard）。
# - Node（多阶段取自 node:24-slim，与真 CLI 的纯 JS 运行面匹配——Phase 5.1
#   传输探针实证无需 Electron）。
# - 构建期剥除非必要 setuid/setgid（保留 sudo/su），并断言清单恰好只剩二者。
FROM debian:13-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends openssh-server libcap2-bin sudo \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd -g 1000 task \
 && useradd -m -u 1000 -g 1000 -s /bin/bash task \
 && groupadd -g 1200 orca-broker \
 && useradd -M -u 1200 -g 1200 -d /var/lib/orca-broker -s /usr/sbin/nologin orca-broker \
 # privilege separation 目录须已存在且 root 属主（镜像内创建，运行时只读）。
 && mkdir -p /run/sshd && chown root:root /run/sshd && chmod 755 /run/sshd \
 && setcap cap_net_bind_service=+ep /usr/sbin/sshd

# 真 Node 运行时（多阶段，glibc 同源；arm64/amd64 随平台解析）。
COPY --from=node:24-slim /usr/local/bin/node /usr/local/bin/node

# 非 root sshd 配置：仅任务用户、仅公钥登录；PidFile=none（/run 不可写）。
RUN printf '%s\n' \
  'PasswordAuthentication no' \
  'KbdInteractiveAuthentication no' \
  'PermitRootLogin no' \
  'PubkeyAuthentication yes' \
  'UsePAM no' \
  'StrictModes yes' \
  'PidFile none' \
  > /etc/ssh/sshd_config.d/10-gov.conf

# T5.1：broker 骨架目录 + guard + 垫片 + sudoers。
# guard/orca 垫片来自仓库 src/guard/（create.sh 组装构建上下文时拷入同级）。
COPY guard.mjs /usr/local/lib/gov/guard
COPY gov-guard.sudoers /etc/sudoers.d/gov-guard
COPY orca-shim /usr/local/bin/orca
RUN mkdir -p /opt/orca-broker/bin /opt/orca-broker/cli /var/lib/orca-broker \
 && chown -R orca-broker:orca-broker /opt/orca-broker /var/lib/orca-broker \
 && chmod 0700 /opt/orca-broker /var/lib/orca-broker \
 && chmod 0755 /usr/local/lib/gov/guard /usr/local/bin/orca \
 && chmod 0440 /etc/sudoers.d/gov-guard \
 && chown root:root /usr/local/lib/gov/guard /usr/local/bin/orca /etc/sudoers.d/gov-guard

# T5.1：剔除非必要 setuid/setgid（保留 sudo/su——sudoers 面本身依赖 sudo 的
# setuid root；su 保留作容器内紧急运维通道），随后断言清单恰好只剩二者。
# mv/chfn/passwd/newgrp/mount/umount/ssh-keysign 等一律去位；去位后对应功能
# 不可用是预期（任务用户不需要本地改密/挂载/主机认证）。
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
