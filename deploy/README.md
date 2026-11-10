# deploy/ —— gov 容器面（镜像、sudoers、配对码、资源参数）

本目录持有 gov-local-docker 环境配方（`scripts/orca-vm/` 四脚本的执行面）的全部
部署真源：

- `docker/Dockerfile`：镜像唯一真源（T5.2 起收编；`scripts/orca-vm/` 不再有副本）。
- `docker/entrypoint.sh`、`docker/orca-shim`：随构建上下文拷入镜像的入口与垫片
  （guard 本体真源在 `src/guard/guard.mjs`，sudoers 在 `deploy/sudoers/gov-guard`，
  均由 `create.sh` 组装上下文时拷入）。

## 镜像构建

正常路径不需要手工构建：`scripts/orca-vm/create.sh` 在镜像不存在时按需本地构建
（层缓存命中时秒级）。构建上下文在 `/tmp` 组装（`gov-vm-buildctx-*`，构建后即删），
Dockerfile 引用的四个文件从仓库真源拷入，镜像面与 `src/guard` 始终同源。

需要预构建时：

```bash
ctx=$(mktemp -d)
cp deploy/docker/Dockerfile deploy/docker/entrypoint.sh "$ctx/"
cp deploy/docker/orca-shim "$ctx/orca-shim"
cp src/guard/guard.mjs "$ctx/guard.mjs"
cp deploy/sudoers/gov-guard "$ctx/gov-guard.sudoers"
docker build -t gov-local-docker-sshd:t52 "$ctx" && rm -rf "$ctx"
```

或直接 `GOV_VM_IMAGE=<预构建镜像名>` 传给 create.sh（跳过本地构建；镜像缺失由
docker run 阶段报错，create 非零退出）。

镜像内容（关键面）：

- uid1000 任务用户 `task`（SSH 会话与 Agent 运行身份）+ uid1200 `orca-broker`
  （真 CLI `/opt/orca-broker` 0700 与身份文件持有者，nologin）。
- openssh-server 以 uid1000 前台运行，**监听容器内 2222**（非特权端口），
  仅公钥登录；create.sh 以 `-p 127.0.0.1::<随机宿主端口>->2222` 映射。
- Node 24（guard 与真 CLI 运行面）+ **claude CLI**（见下节）。
- guard（`/usr/local/lib/gov/guard`，root 0755）与 `/usr/local/bin/orca` 垫片；
  sudoers 单条目 `task ALL=(orca-broker) NOPASSWD: /usr/local/lib/gov/guard`。
- setuid/setgid 剥离 + 构建期断言：镜像内恰好只剩 `/usr/bin/sudo`、`/usr/bin/su`。

## claude CLI 安装面

- 安装：多阶段以 npm 钉版安装 `@anthropic-ai/claude-code@2.1.319`（版本钉在
  Dockerfile，升级显式改行，不追 latest），落 `/opt/claude-code/package`
  （orca-broker 属主、0755——任务用户**可执行、不可改**），构建期以 broker 与
  task 双身份跑 `claude --version` 冒烟。
- 全局可执行：`/usr/local/bin/claude`（root 属主符号链接），任务用户 PATH 直达。
- 配置（gov 预置面）：`/etc/claude-code/managed-settings.json`（orca-broker
  属主 0644，任务用户**只读不可写**）。这是 Claude Code 的 managed settings
  注入点，防御性 hooks / 策略（T5.3）由此下发，Agent 无法篡改或删除；
  当前为空对象占位。任务用户自身运行态（`~/.claude.json` 信任种子等）由
  create.sh 按容器写入，不在镜像内预置。

## 配对码铸造（T5.1 探针口径，候选 A）

容器内真 CLI 经 `ORCA_PAIRING_CODE` 回连桌面 Orca runtime（同一 runtimeId，不在
容器内跑 `orca serve`）。配对码**只读重构**，不写桌面状态：

1. 桌面设备注册表 `~/Library/Application Support/orca/orca-devices.json` 取
   `scope=runtime` 的设备（优先从未配对过的 pending 设备）的 `token`/`deviceId`。
2. `orca-e2ee-keypair.json` 取桌面 E2EE 公钥 `publicKeyB64`。
3. `orca-runtime.json` 取 websocket 传输端口（默认 6768）。
4. 三者拼 offer（endpoint 换 `ws://host.docker.internal:<port>`，scope=runtime），
   base64url 编码为 `orca://pair?code=<b64>`，随 guard 身份
   （`GOV_GUARD_IDENTITY`）注入容器，落 broker 0600 的 `identity.json`。

前置：桌面 runtime 处于 ready；设备注册表至少有一个 runtime-scope 设备（全新
桌面需在 Orca 桌面设置里打开一次 runtime 配对面）。铸造实现见
`test/isolation/guard/guard.test.ts` 的 `mintPairingCode`。

## 信任预置

Orca worker 首个 agent 会话会死于工作区信任门（T2.1 实测）。create.sh 在部署
guard 面时把 `{"projects":{"/work":{"hasTrustDialogAccepted":true}}}` 写入容器内
`/home/task/.claude.json`（task 0644）。宿主侧 Claude 配置不受影响——预置只写
容器内文件。

## 资源与隔离参数（create.sh 固定携带）

| 参数 | 值 | 说明 |
|---|---|---|
| `-u` | `1000:1000` | 非 root；sshd 与 Agent 同 uid |
| `--cap-drop=ALL` + `--cap-add` | SETUID/SETGID/CHOWN/FOWNER/DAC_READ_SEARCH/AUDIT_WRITE | guard 面 sudo 入口（setuid/审计）与 guard_provision 部署步（穿越 0700 broker 目录做 chown -R / chmod）的最小补回；任务用户 CapEff 恒空集，root 进程也拿不到多余 capability |
| `--memory` | `2g` | 单容器内存上限，OOM 只杀本容器 |
| `--cpus` | `2` | CPU 上限 |
| `--pids-limit` | `256` | 进程数上限，fork 炸弹自限 |
| 挂载 | `$WS:/work:ro` + `$WS/<rel>:/work/<rel>:rw` | 双层挂载；`.jj`（及存在时的 `.git`）叠空只读 tmpfs 遮蔽——读保护不依赖 DAC（Docker Desktop 架空宿主 DAC，T0.4 口径） |

### 关于 no-new-privileges（不设，实测裁定）

T5.2 曾计划 `--security-opt no-new-privileges`，实测**与 T5.1 guard 面互斥**：
该标志使 execve 不再授予 setuid 位与 file capability，sudo 直接拒跑
（`sudo: The "no new privileges" flag is set, which prevents sudo from running
as root.`），而 guard 的唯一入口就是 `sudo -n -u orca-broker …`；且 NNP 下任何
进程都无法转 uid 到 broker（sshd 会话/`docker exec` 全部继承），T5.1 架构整体
失效。替代达成同一目标（Agent 零 capability、不可提权）：`--cap-drop=ALL`
+ 最小补回 + 镜像 setuid 清单断言（仅 sudo/su）。若未来 guard 入口改为非
setuid 机制（如 broker 侧 unix socket 服务），可再评估 NNP。

同理，`--cap-drop=ALL` 下任何带 file capability 的二进制 execve 会直接 EPERM，
故镜像内不再 setcap sshd，改为监听 2222（Docker Desktop 默认
`ip_unprivileged_port_start=0`，特权端口本就不设防）。

## 符号链接审计（destroy 回执）

create.sh 在容器就绪后以容器视角 `find /work -type l` 落基线（随 SSH 密钥存
`/tmp/gov-vm-keys/<容器名>/`）；destroy.sh 在 `docker rm -f` 前重跑同命令，新增
符号链接写入回执 `symlinkAudit.new`（audit 事件），扫描失败只降级
（`scanned:false` + `error`），不阻断销毁。

## 部署面迁移到 Linux 前：重跑 T0.4

当前全部实测口径（0000↔0777 切换、fakeowner、tmpfs 遮蔽、端口面）基于
macOS Docker Desktop（virtiofs + fakeowner 架空宿主 DAC）。Linux 宿主上 DAC
真实生效、`ip_unprivileged_port_start` 默认 1024、tmpfs/bind 行为有差，迁移前
必须重跑 T0.4 探针确认：读保护（遮蔽仍必要，且 DAC 可作纵深）、sshd 2222
绑定、0000 切换语义、审计扫描的可读位恢复路径。
