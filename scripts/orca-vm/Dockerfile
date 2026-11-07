# gov-local-docker 环境配方基础镜像（T2.3）。
#
# 约束（机制裁定 6）：debian + openssh-server + uid1000 任务用户；不装 Agent CLI
# （T5.2 范围）；sshd 监听 22。容器一律以 `-u 1000:1000` 运行，因此 sshd 也以
# 非 root 运行——通过给二进制授予 file capability cap_net_bind_service 绑定特权
# 端口 22（依赖容器默认完整 capability bounding set，故不得 --cap-drop=ALL，
# 也不得 --security-opt no-new-privileges，二者都会架空 setcap）。
FROM debian:13-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends openssh-server libcap2-bin \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd -g 1000 task \
 && useradd -m -u 1000 -g 1000 -s /bin/bash task \
 # privilege separation 目录须已存在且 root 属主（镜像内创建，运行时只读）。
 && mkdir -p /run/sshd && chown root:root /run/sshd && chmod 755 /run/sshd \
 && setcap cap_net_bind_service=+ep /usr/sbin/sshd

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

COPY entrypoint.sh /usr/local/bin/gov-vm-entrypoint
RUN chmod 755 /usr/local/bin/gov-vm-entrypoint

USER 1000:1000
WORKDIR /work
ENV HOME=/home/task
ENTRYPOINT ["/usr/local/bin/gov-vm-entrypoint"]
