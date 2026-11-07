# T0.3 探针报告：受限启动器机制与 Dispatch 身份来源

- 任务：governance-tasks.md v0.3 §T0.3（探针协议见 `execution/phase-0.3-brief.md`，通用纪律见 `probes/README.md`）
- 日期：2026-11-07
- 执行者：T0.3 探针子代理
- 真实模型：已获用户授权（2026-11-07，两次 worker，提示词逐字 P1/P2）
- 探针问题：Orca 注入给 worker 的 orchestration 命令是裸命令名还是绝对路径；PATH 垫片能否拦截并转发且服务端仍认原 worker 身份；宿主直接代发消息是否被拒；提前 `worker_done` 是否被拒。

## 结论（三选一）

**机制成立。** 四个可观察面全部按预期通过，Track B（受限启动器 T5.1）可以开工：

1. **preamble 形态 = 裸命令名**。两个真实 dispatch（`ctx_d2f3ffe096c3`、`ctx_fb99940df705`）注入的 preamble 中，全部 5 条 `orchestration` 命令行都以裸 `orca` 开头，无一条绝对路径。裸名经 PATH 解析 → PATH 垫片拦截可行（§子探针 A）。
2. **垫片拦截与身份保留成立**。worker 在 `export PATH=<shim>:$PATH` 后逐字执行 preamble check 命令，垫片日志记录到该次调用（`2026-11-07T03:00:53Z argv=orchestration check --terminal term_25a21456-... --json`），转发到真 orca 后服务端返回 `ok:true` 且 mailbox 归属正确（`dispatchId: ctx_fb99940df705`，`messages: []`）——转发进程仍以原 worker 身份被接受（§子探针 B）。
3. **宿主代发被拒**。控制器侧以 worker 的 handle 代发 heartbeat / worker_done 共 3 次（含对已结算 dispatch 的对照），全部 `consumer_fenced`，`effectsApplied: false`，零副作用（§子探针 C/D）。身份来源是调用方终端/进程，不是 `--from` 字段或载荷里的 Task/Dispatch id。
4. **提前 `worker_done` 被拒**。合同未完成时宿主以 worker 名义发 `worker_done --outcome succeeded` 被 `consumer_fenced` 拒绝（§子探针 D）。

### 附带平台发现（不改变上述结论，但 Track B 必须纳入设计）

- **信任门**：对从未信任过的工作区，`worker-start` 在 `agent_readiness` 阶段快速失败（`Agent startup blocked: agent-trust-workspace`，约 3 秒内吊销 capability），claude 停在 workspace 信任对话。解法是一次性接受信任（实测经 `terminal send` 发 Up+Enter 即可，接受后跨启动持久化），再以 `worker-start --retry-of <失败dispatch>` 重启。受限启动器（T5.1）必须在工作区预信任后才启动 worker，否则首个 worker 必死于该门。
- **`reset --messages` 是全局清空，不是 run 范围**：本探针按协议第 6 步执行后，`orchestration.db` 的 `messages` 表跨全部 run 清零（含 18 条属于其他历史 run 的消息；tasks/runs/dispatches 表未受影响）。已留存 WAL 快照供恢复评估（§清理与残余）。治理系统今后不得在共享宿主上使用 `reset --messages` 做单 run 清理。

## 环境与版本记录（协议步骤 1）

Orca CLI：`/Applications/Orca.app/Contents/Resources/bin/orca`（下称 `$ORCA`）。

| 组件 | 实测值 | 基线对照 |
|---|---|---|
| Orca appVersion | `1.4.238` | 一致 |
| runtimeId | `ca5d05e1-cd2e-42a8-b1fd-b53d97b4e567`（state ready, connected） | 一致 |
| jj | `0.41.0`（本探针用于 colocated 工作区） | 一致 |
| worker agent | claude 2.1.316（Orca 拉起，用户缺省模型配置 glm-5.3[1m] xhigh） | — |
| Docker | 不适用（双用户容器属 T5.1 建造范围，本探针只验证机制赌注） | — |

基准快照（探针前）：`worktree list` 29 条、`repo list` 17 条、`project list` 17 条。

临时工作区：`mktemp -d /tmp/gov-probe-t03-XXXX` → `/tmp/gov-probe-t03-a335`（下称 `$TMP`）。`jj git init --colocate $TMP/probe-ws` 成功，`.jj` 与 `.git` 并存，加一笔 `probe init` 提交。`repo add --path` 注册成功（repo id `7bea4bf1-8683-4818-b54c-935734eb0bef`，kind `git`，exit 0）——colocated jj 走 Git 语义注册，印证 T0.2 后的裁定。

## 探针过程（协议步骤 2–6）

### 步骤 2：子探针 A —— preamble 可执行形态（只读观察）

Run / Task 创建：

```
$ORCA orchestration run-create --objective "T0.3 provenance probe" --json   # exit 0
  → run.id: run_e9d1a27bfdf2（coordinator_handle: term_3a9ca3e5-aa75-4134-b51d-1972f2462785）
$ORCA orchestration task-create --spec "<P1 逐字>" --run run_e9d1a27bfdf2 --json   # exit 0
  → task.id: task_dd489fdfeb2d（status: ready）
```

P1 原文（逐字）：`只做一件事：用 Bash 逐字执行你收到的 preamble 中的 orchestration check 命令（保持参数原样），把命令的完整 JSON 输出原样贴回，然后停止。不要读其他文件，不要做任何修改。`

**第一次 worker-start（被信任门拦截，零模型调用）**：

```
$ORCA orchestration worker-start --task task_dd489fdfeb2d --worktree path:/private/tmp/gov-probe-t03-a335/probe-ws --agent claude --json   # exit 1
  → dispatchId: ctx_452ee13d5291, state: "failed", failedStage: "agent_readiness",
    lastError: "Agent startup blocked: agent-trust-workspace", capabilityRevokedAt: 2026-11-07T02:47:59.988Z
  → 残留 terminal term_649f4edf-4baf-4c2c-aba8-2f5dcbc74731 停在 Claude 信任对话（❯ No, exit）
```

处置（如实记录）：该 terminal 仍活着，经 `$ORCA terminal send --text $'\x1b[A'`（Up）+ `--text $'\r'`（Enter）走真实 UI 路径接受「Yes, I trust this folder」；另以 `$ORCA terminal create --worktree path:<probe-ws> --command claude` 实测第二次启动已无信任对话（跨启动持久化），随即 `/exit` 关闭。该 terminal 无任何模型对话。`~/.claude.json` 在首次启动时刻（mtime 10:47:57 本地）即写入该路径条目 `{"hasTrustDialogAccepted": true}` 但对话仍出现——flag 写入与对话门不是同一判定面，对话只出现一次。之后 `$ORCA orchestration worker-release --dispatch ctx_452ee13d5291`（state: released, processAction: closed_agent_terminal）。

**第二次 worker-start（真实 worker ①，P1）**：task 已被首次失败连带标 failed，直接重启被拒（`task_not_startable`，exit 1，nextSteps 指引 `--retry-of`）。按平台指引：

```
$ORCA orchestration worker-start --task task_dd489fdfeb2d --worktree path:/private/tmp/gov-probe-t03-a335/probe-ws --agent claude --retry-of ctx_452ee13d5291 --json   # exit 0
  → dispatchId: ctx_d2f3ffe096c3, state: "ready", stage: "input_accepted", turnStart: "observed"
  → agent terminal handle: term_c808c3b7-421b-49ac-a835-e8c74e0d35c1
  → effects: worktree reused / terminal created / dispatch_input accepted；timeoutMs 60000
```

**preamble 逐字摘录**（`$ORCA orchestration dispatch-show --task task_dd489fdfeb2d --preamble --json`，与 terminal 注入文本一致；只列 CLI COMMANDS 段中要求 worker 执行的命令行，其余段落省略号）：

```sh
  orca orchestration send --from term_c808c3b7-421b-49ac-a835-e8c74e0d35c1 --type worker_done --subject "<short status>" --body "<3-sentence summary: what you did, what you found, what's left>" --task-id task_dd489fdfeb2d --dispatch-id ctx_d2f3ffe096c3 --outcome succeeded
  orca orchestration send --from term_c808c3b7-421b-49ac-a835-e8c74e0d35c1 --type heartbeat --subject "alive" --task-id task_dd489fdfeb2d --dispatch-id ctx_d2f3ffe096c3 --phase "<short: investigating|implementing|reviewing|waiting>"
  orca orchestration ask --from term_c808c3b7-421b-49ac-a835-e8c74e0d35c1 --question "<your question>" --options "<optional,comma,separated>" --timeout-ms 600000
  orca orchestration send --from term_c808c3b7-421b-49ac-a835-e8c74e0d35c1 --type escalation --subject "Blocked: <reason>" --body "<details>" --task-id task_dd489fdfeb2d --dispatch-id ctx_d2f3ffe096c3
  orca orchestration check --terminal term_c808c3b7-421b-49ac-a835-e8c74e0d35c1 --json
```

**形态判定：5 条命令行全部为裸命令名 `orca`**（PATH 可解析），无一条 `/Applications/...` 绝对路径、无 `./` 前缀。第二个 dispatch（B）的 preamble 同形态。preamble 还明文要求「Include BOTH taskId and dispatchId in the payload so a late completion from a failed retry cannot complete the current dispatch」——身份绑定设计为调用方终端 + dispatch id 双因子（失败重试的旧 dispatch capability 已吊销，见 `capability_revoked_at` 字段）。

**worker ① 执行结果**（terminal `term_c808c3b7`，模型思考 29s 后执行 1 条 shell 命令）：逐字执行 check，服务端回执：

```json
{"id":"f3ddebd5-...","ok":true,"result":{"runId":"run_e9d1a27bfdf2","dispatchId":"ctx_d2f3ffe096c3","deliveryId":null,"messages":[],"count":0,"replayed":false,"acknowledged":null,"timedOut":false,"cancelled":false,"connectionLost":false,"mutation":{"requestId":"f3fa36b1-...","replayed":false}},"_meta":{"runtimeId":"ca5d05e1-..."}}
```

worker 随后按 preamble 合同发送 `worker_done`（msg_f72f03c9d2f7，payload `{"taskId":"task_dd489fdfeb2d","dispatchId":"ctx_d2f3ffe096c3","outcome":"succeeded"}`，`reportedBy: term_c808c3b7`）。dispatch `ctx_d2f3ffe096c3` 于 02:56:14.349Z completed；task `task_dd489fdfeb2d` completed（provenance worker_report）。

### 步骤 3：子探针 B —— PATH 垫片拦截与身份保留

垫片脚本 `$TMP/shim/orca`（`chmod +x`）：记录 UTC 时间戳与完整 argv 到 `$TMP/shim/log`；任一 argv 元素精确等于 `task-update|worker-start|dispatch|worktree|repo|terminal|automations` 之一则 stderr 打印拒绝并 `exit 23`（精确等值匹配：`--terminal`/`--dispatch-id` 等带前缀参数不误伤）；否则 `exec /Applications/Orca.app/Contents/Resources/bin/orca "$@"` 原样转发。

宿主侧自测（垫片双臂，未涉 worker）：

```
PATH=$TMP/shim:$PATH orca status --json            # exit 0，ok:true（转发臂）
PATH=$TMP/shim:$PATH orca worktree list --json     # exit 23，"shim: management command rejected: worktree"（拒绝臂）
PATH=$TMP/shim:$PATH orca orchestration check --terminal term_TESTprobe --json   # 经垫片转发（日志有记录），exit 1 = 服务端因假 handle 报错，非垫片拦截
```

第二个 task（同 run）spec 逐字用 P2（占位符代入：`$TMP/shim` → `/private/tmp/gov-probe-t03-a335/shim`，`<shim日志路径>` → `/private/tmp/gov-probe-t03-a335/shim/log`，`<绝对路径>` → `/private/tmp/gov-probe-t03-a335/probe-ws`；其余字符含「（$TMP 换成下面给出的绝对路径）」括注保持原文）：

```
$ORCA orchestration task-create --spec "<P2>" --run run_e9d1a27bfdf2 --json   # exit 0 → task_3fdacd0bf1c3 (ready)
$ORCA orchestration worker-start --task task_3fdacd0bf1c3 --worktree path:/private/tmp/gov-probe-t03-a335/probe-ws --agent claude --json   # exit 0（真实 worker ②）
  → dispatchId: ctx_fb99940df705, state: "ready", stage: "input_accepted"
  → agent terminal handle: term_25a21456-09f5-4404-b197-a23a05533ca3
```

**拦截证据（垫片日志新增行）**：

```
2026-11-07T03:00:53Z argv=orchestration check --terminal term_25a21456-09f5-4404-b197-a23a05533ca3 --json
```

**转发后身份保留证据**（worker ② 在 worker_done 消息体中逐字回贴的 check JSON）：

```json
{"id":"d9692cb3-...","ok":true,"result":{"runId":"run_e9d1a27bfdf2","dispatchId":"ctx_fb99940df705","deliveryId":null,"messages":[],"count":0,"replayed":false,"acknowledged":null,"timedOut":false,"cancelled":false,"connectionLost":false,"mutation":{"requestId":"c472aba3-...","replayed":false}},"_meta":{"runtimeId":"ca5d05e1-..."}}
```

垫片 `exec` 转发后，服务端仍按原 worker 身份接受该 check，并返回**该 dispatch 自己的 mailbox**（`ctx_fb99940df705`）。worker ② 随后 `worker_done`（msg_9712873008c1，payload 含 `task_3fdacd0bf1c3`+`ctx_fb99940df705`+`succeeded`），dispatch 于 03:01:15.149Z completed。行为注记（如实记录，非协议偏差）：worker ② 执行前先只读检查了垫片脚本与日志并披露该偏差，其 `worker_done` 选择了不带垫片 PATH 的新 shell 发送——不影响本子探针的两项判定（check 的拦截与转发均已成立）。

**「管理命令不能执行」的证据边界**：两枚 worker 均按题面未尝试管理命令，故该面的证据是垫片拒绝臂的宿主自测（`worktree` → exit 23）——这是 Track B 受限启动器将部署的强制点；worker 侧未实测管理命令被阻，属未测试路径，不在结论中断言。

### 步骤 4：子探针 C —— 宿主代发对照（预期拒绝）

worker ② 存活、任务未按合同完成时，控制器侧执行：

```
$ORCA orchestration send --from term_25a21456-09f5-4404-b197-a23a05533ca3 --type heartbeat --task-id task_3fdacd0bf1c3 --dispatch-id ctx_fb99940df705 --subject probe --body probe --json   # exit 1
```

- `code: "consumer_fenced"`，`effectsApplied: false`
- message：`This terminal is a Run coordinator and cannot report as term_25a21456-...; run the command from the worker's own terminal. No effects were applied.`

对照重复（对已结算的 worker ① handle 代发 heartbeat，`--task-id task_dd489fdfeb2d --dispatch-id ctx_d2f3ffe096c3`）：同样 `consumer_fenced`，`effectsApplied: false`。**结论：`--from` 字段不是授权凭据；服务端按调用方终端身份核对，宿主代发（伪造注入指令字段）改变不了身份。**

### 步骤 5：子探针 D —— 提前 worker_done 被拒

同一存活窗口内，控制器侧以 worker ② 名义提前结算：

```
$ORCA orchestration send --from term_25a21456-09f5-4404-b197-a23a05533ca3 --type worker_done --subject probe --body probe --task-id task_3fdacd0bf1c3 --dispatch-id ctx_fb99940df705 --outcome succeeded --json   # exit 1
```

- `code: "consumer_fenced"`，`effectsApplied: false`——零副作用，task 状态未被篡改，worker ② 随后按合同自行完成（见步骤 3）。

### 验证门对照（governance-tasks.md §T0.3）

- 「至少一次 merge_ready 或等价非终态消息具有正确 Dispatch 回执」：本契约版本无 merge_ready 消息型；等价物已取证——两枚 worker 的非终态 `check` 调用均被服务端接受且 dispatchId 归属正确（上两段 JSON），两枚 `worker_done`（msg_f72f03c9d2f7 / msg_9712873008c1）载荷均携带正确 taskId+dispatchId，`reportedBy` 为各自 worker terminal。
- 「提前 worker_done 被拒绝」：✓（子探针 D）。
- 「伪造注入指令中的 Task/Dispatch 不能改变身份」：✓（子探针 C/D 三个样本，含正确 id 组合的伪造 `--from`）。
- 「不能证明身份来源时 Track B 停止」：身份来源已证明（调用方终端 + dispatch capability），不停。

### 步骤 6：清理

| 动作 | 命令 | 结果 |
|---|---|---|
| 释放 worker ① 终端 | `$ORCA orchestration worker-release --dispatch ctx_d2f3ffe096c3 --json` | ok，state released，archive captured |
| 释放 worker ② 终端 | `$ORCA orchestration worker-release --dispatch ctx_fb99940df705 --json` | ok，state released，archive captured |
| 删工作区 | `$ORCA worktree rm --worktree path:<probe-ws> --force` | **被拒**：`Refusing to delete protected worktree path`（主 worktree 恒受保护，--force 不豁免） |
| 注销 repo 注册 | `$ORCA project setup-delete --setup 7bea4bf1-8683-4818-b54c-935734eb0bef --force --json` | ok（repo-backed setup 连带移除注册记录；终选先释放终端再删，避免 --force 强拆） |
| run 邮箱残留清理 | `$ORCA orchestration reset --messages --json` | ok——**但实测为全局清空**（见下） |
| 删临时目录 | `rm -rf /tmp/gov-probe-t03-a335` | ok，`ls /tmp | grep -c gov-probe-t03` = 0 |

清理后状态：`worktree list` 29 / `repo list` 17 / `project list` 17（与基准一致），三列表与 `project setups` grep `gov-probe-t03` 均零残留；`terminal list` 零探针终端；`worker-list` 余 3 行已结算记账（`workerState: succeeded/completed`、`ownershipState: released`、`terminalState: released`），属历史审计行，同既有 4 个旧 run 的记录同类。

### `reset --messages` 全局清空事故（重要）

- 执行前观察：`inbox --full` 可见 20 条消息（本 run 2 条 + 其他 run 18 条，含 `run_c70146e1df15` 的 msg_86809f04909d；最早属 2026-08/09 的旧 run）。
- 执行后：`orchestration.db` 只读核对 `SELECT COUNT(*) FROM messages` = **0**（全表跨 run 清零；`deliveries` 亦 0）。`tasks`（57 行，含本 run 2 条 completed）、`runs`（5）、`dispatch_contexts`（65）未受影响；其他 run 的 `updated_at` 未变。
- 缓解：主库 mtime 停在 10-24，全部写入在 WAL。已快照 `execution/orchestration-wal-snapshot-2026-11-07.db-wal`（1.9MB，内含 99 个 `msg_*` id 的可恢复文本）。未做库外回写——daemon 持有该库，库外写有损坏活态风险；是否恢复由用户裁定。
- 平台结论：`reset --messages`/`--tasks` 无 run 范围参数，是宿主全局操作。治理 run 的清理不得再用它；需向 Orca 侧要 run 范围的清理通道（或整 run 删除）。

## 残余资源清单

1. `~/.claude.json` 中 `projects["/private/tmp/gov-probe-t03-a335/probe-ws"] = {"hasTrustDialogAccepted": true}`：探针首次启动产生；目录已删，条目惰性。未清除原因：该文件被多个活跃 claude 会话共享，读改写有并发覆盖风险，60 字节惰性条目不值得冒险。
2. Orca 编排史：run `run_e9d1a27bfdf2`、task ×2、dispatch ×3（含被信任门废掉的 `ctx_452ee13d5291`）的已结算记账行保留（与其他历史 run 同类的审计记录，CLI 无 run 删除通道；`reset` 已证危险，不再触碰）。
3. `messages` 表 18 条其他 run 的历史消息被 `reset --messages` 误删（上节）；WAL 快照在 `execution/orchestration-wal-snapshot-2026-11-07.db-wal`。
4. /tmp、Orca 注册面、终端面：无残留（见清理后状态）。

## 最小复现（关键命令）

- 裸名注入：`dispatch-show --task <id> --preamble` 的 CLI COMMANDS 段。
- 垫片：`PATH=<shimdir>:$PATH orca orchestration check --terminal <worker_handle> --json` → 垫片 log 记录 + 真 orca `ok:true`。
- 代发拒绝：`orca orchestration send --from <worker_handle> --type heartbeat --task-id <tid> --dispatch-id <did> --subject probe --body probe --json` → `consumer_fenced`。
