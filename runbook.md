# Orca × GitLab × Matt Skills 开发工作流 Runbook

v0.2 · 2026-09-14 · pilot run_fe1036f315cb（66b-review#1）全链验证后修订
适用：公司内网 GitLab（gitlab.daqian369.com）+ 本机 Orca 1.4.190 + Matt Pocock engineering skills

> **已替代文档，仅供历史参考（2026-11-07）**
>
> 本 runbook 描述的是已被替代的旧流程，不要再按本文执行任何步骤；现行治理流程以 [governance-design.md](governance-design.md) 与 [governance-tasks.md](governance-tasks.md) 为准。旧流程中以下三处做法已明确不再沿用：
>
> 1. **手工 `task-update --status ready` 推进依赖**——父子依赖改由治理侧判定，正常流程不调用 `task-update`（设计决策 D14）。
> 2. **修复后复审复用原评审终端**——每次提交都新建独立的评审 Session 与评审工作区，不再复用原终端（设计决策 D7）。
> 3. **开发 worker 自行 push 分支**——开发完成只发送 `merge_ready`，合并由宿主侧治理流程控制（设计决策 D6）。

## 0. 拓扑与前提

三个会话各司其职，不要混：

| 会话 | 跑在哪 | 职责 |
|---|---|---|
| **cc 主会话** | 终端里 `cc`（yfp 树） | 阶段 1 讨论/成文/拆票；最终人工验收 |
| **协调会话** | **Orca 终端里的 claude**（HOME 树） | 阶段 2–4 编排驾驶舱：run-create / worker-start / check --wait / 分诊 / 升级 |
| **Workers** | 各 worktree 里的 codex / opencode / claude | 评审、开发、修复；按 worker 契约汇报 |

一次性前提（2026-09-13 已就绪 ✅ / 待办 ⏳）：

- ✅ orca 1.4.190 本机运行，Orchestration 已在 Settings → Experimental 开启
- ✅ orchestration / orca-cli skills：HOME 树 + `~/.agents`（codex/opencode 按约定读）
- ✅ Matt 8 skills（to-spec / to-tickets / setup-matt-pocock-skills / implement / code-review / triage / tdd / wizard）：`~/.agents` + HOME symlink
- ✅ cc 树日常链 symlink：grill-with-docs · start-prd · wayfinder · to-tickets · implement
- ✅ glab 1.117.0 已安装
- ⏳ glab 认证（见 Phase 0）
- ⏳ Rock5C 远程 worker（可选，见 §8）

**契约红线**（违反会导致状态错乱）：

1. "hand off / 交给另一个 agent" = 所有权转移，**不建 task、不监控**；只有明说要 supervise/wait/DAG/gate 才走编排。
2. review-only worker 的 `worker_done` 只报 findings，**协调会话不据此改文件**——综合 → 分诊 → dispatch 给指名 fixer。
3. 每个 settled 的 `worker_done` 之后、ack 之前，必须三选一：`worker-release` / 复用终端起下一 task / `worker-retain`（用户明说要留）。
4. `check --wait` 超时 = 检查点，不是失败。编码任务常态 15–60 分钟；先 `worker-show` / `terminal read` 确认活性再决定。

---

## Phase 0 · 每仓库一次性准备

```bash
# 1. glab 认证（交互式，PAT 需要 api scope；与既有 SSH 配方互不相干）
glab auth login --hostname gitlab.daqian369.com
glab auth status --hostname gitlab.daqian369.com   # 验证

# 2. 仓库注册进 Orca（等价于 UI 侧边栏 Add Repo）
orca repo add --path /abs/path/to/<repo>
orca repo list --json                             # 记下 repo id

# 3. 仓库内跑一次（cc 主会话里）：
#    /setup-matt-pocock-skills
#    它探测到 GitLab remote 会自动提议 GitLab；产物：
#    docs/agents/issue-tracker.md（glab 工作流）+ triage-labels.md + domain.md
```

验证：`glab issue list -R <group>/<repo>` 出数即通。

---

## Phase 1 · 讨论 → spec → tickets（cc 主会话）

```
/grill-with-docs          # 边问边写 ADR/glossary，磨清设计
/to-spec                  # 单特性：零访谈，综合成 spec 发 GitLab issue，打 ready-for-agent
   └─ 多特性低 token 场景改用 /start-prd（分特性 PRD + checkpoint），再 /to-tickets
/to-tickets               # 拆 tracer-bullet 票，blocking edges 用 GitLab 原生 blocked-by
```

产物验收：

```bash
glab issue list -R <group>/<repo> --label ready-for-agent
```

票即持久事实源；Orca task 只是本次 Run 的易失 DAG 镜像，两边别重复维护状态。

---

## Phase 2 · 设计评审（监督式并行 worker ×2）

**协调会话入位**：Orca UI → 仓库旁 "+" → worktree 名 `coord-<feature>` → agent 选 claude → 在该终端里对话开始编排。（HOME 树能看到 orchestration skill，这是协调会话必须跑在 Orca 终端里的原因。）

协调会话内执行（也可让它自己按 orchestration skill 走，下面是应发生的最小序列）：

```bash
orca orchestration run-create --objective "<feature>：设计评审 + 实现 + 复审" --json
orca orchestration task-create --spec "评审 <spec issue URL>：边界完整性/遗漏风险/与现有代码一致性。只报 findings 并分级 AUTO-FIX/PUSH-BACK/ESCALATE，不改文件" --json   # task_a
orca orchestration task-create --spec "对抗评审同一 spec：假设实现会走样，找出含糊到无法验收的条目" --json                                          # task_b

# 双评审并行（claude 钉 opus/high；codex 走自己的账号配额）
orca orchestration worker-start --task <a> --worktree current --agent claude --model opus --effort high --json
orca orchestration worker-start --task <b> --worktree current --agent codex --json

# 滚动等待（不是 sleep/poll）
orca orchestration check --wait --types worker_done,escalation,question --timeout-ms 900000 --json
```

消息处理协议：

- `worker_done` → 读 findings → **评审 worker 不立即 release**：进入评审收敛循环（见下），该评审名下 finding 队列全部处置完才 `worker-release --dispatch <id>`
- `worker_done` 被拒（消息带 `_orcaLifecycleRejection`）→ findings 全文仍在消息正文里存活：先读再恢复，工作不丢
- `question`（worker 的 ask）→ 汇总后**一次性**用 AskUserQuestion 问用户 → `orca orchestration reply --id <msg_id> --body "<答案>" --json`
- `escalation` → 必须人拍板的：`gate-create --task <id> --question "..." --options '["A","B"]'`，用户选后 `gate-resolve --id <gate> --resolution "A"`
- 全部处理完才 `check --ack <delivery_id> --wait ...` 进入下一窗口

分诊规则（= codex-review-loop 语义）：两路 findings 去重合并 → AUTO-FIX（直接派修复 task）/ PUSH-BACK（驳回，写明理由）/ ESCALATE（gate 问用户）。

**采纳门（AUTO-FIX 前置；细则 = codex-review-loop 的 decision-rubric.md CHALLENGE+KISS）**：每条 finding 先过三问，任一不过 → PUSH-BACK（写明理由）：

1. **现有架构接得住吗**——要新抽象/新缝/动公共契约才修得了的，不自动修（要这个复杂度就 ESCALATE 交人拍板）
2. **不修会踩到吗**——没人用的接口、拦不拦都行的边界、够不着的路径，不修
3. **修完复杂度净增吗**——净增者必须指认它堵住的真实可达失败路径；指不出，不修

评审循环的净方向是变简单：**越评审越复杂 ＝ 分诊在放水**，回查哪条采纳门漏了。

**评审收敛循环（review-until-converge）**：

- **复用不换人**：修复后的复审派在**原评审终端**（`worker-start --task <re-review> --terminal <原 handle>`）——原会话记得自己报过什么，复审＝逐条核销，不是从头再评审。换新评审仅当原终端丢失/挂死（新评审首轮即全量）
- **跨票同样复用（硬校验，2026-09-17 Rock5C 实证反例补）**：同一 worktree 的连续复审任务（票02→票03→…→票0N），**禁止每张票新开评审 session**——首个复审新开一个终端，后续一律 `--terminal <原 handle>` 接续。反例：pi-blind CF 移植一次 run 里 8 张票开了 9 个 claude 复审 session（每票冷启动重读全量 diff），既慢一倍又堆内存。判定口诀：**「下一活是否还是同一类评审、同一 worktree」→ 是则必须复用**；新开评审终端的唯一合法理由是换了评审职责（spec 评审 → 实现复审）或原终端死了。
- **spec 修复归协调会话**：评审 worker 契约是只报不改；AUTO-FIX 的 spec 修订由协调会话直接改（issue 正文 + 仓内 spec/plan 文件），改完再核销
- **复审 task spec 固定形态**：逐条列原 findings → 每条给 verdict：`FIXED`（指认修订位置）/ `NOT_FIXED` / `NEW_EVIDENCE`；仅对修订触及的行报新 finding，**禁止重开全量评审**
- **收敛判据（机械）**：该评审名下 findings 全部 ∈ {FIXED, PUSH-BACK, ESCALATE 已 gate} → release。两个评审独立收敛独立放（task_a 可先走）
- **深度上限 3 轮**：第 3 轮复审仍有 NOT_FIXED → `gate-create` 交人拍板（同时防"永不收敛"与"复用会话放水"两个方向的失控）

---

## Phase 3 · 开发 + 实现复审 loop

```bash
# dev task（依赖评审修正后的 spec；--deps 只写真实阻塞关系）
orca orchestration task-create --spec "按 GitLab issue <N> 实现。gate=测试通过+不越 tickets 边界。/implement + /tdd" --deps '[<fix_task_ids>]' --json
# codex 信任预置：新 worktree 对 codex 是陌生路径，首启必弹信任框、吃掉注入 prompt（pilot 实证；路径拿不准看 orca worktree list）
printf '\n[projects."/Users/souler/orca/workspaces/<repo>/<N>-<slug>"]\ntrust_level = "trusted"\n' >> ~/.codex/config.toml

orca orchestration worker-start --task <dev> --worktree new-child --name <N>-<slug> --agent opencode --setup run --json
#    worktree 名带 issue 号 = GitLab 衔接约定（Orca 的 --issue 仅支持 GitHub）
```

**Agent 分工裁定（2026-09-16 用户确认，cf-compat 票01 Run 实证）**：dev task → **opencode**（走下方降级协议，省 codex 配额）；复审/评审类 → **claude 优先**（结构化 worker_done 通道可靠），codex 兜底（该 Run 实证 codex 全链可靠：review→复审→ask→escalation→dev）。在飞的 task 不中途换人。注意：带 `--deps` 的 task-create 产物停在 `pending`（调度器已退役，无人晋升）——先 `task-update --status ready` 再 worker-start。Linux 机 `claude --model opus` 实际落到 glm-5.3[1m]，仅警告不致命。

```bash
```

**opencode 降级监督协议**（Orca 1.4.190 对 opencode 注入确认 3/3 误判 `agent_prompt_stalled`、capability 即撤，bug 报告已起草；修复前按此跑，pilot 已验证）：

- dispatch 对 opencode **只当放置用**：worktree/终端/prompt 注入实际全部就位，判死只是汇报凭证（capability）被撤
- 首判 stalled → `orca terminal read --terminal <handle>` 确认任务文本已到 → **不 retry 注入**（mid-turn 重注入会把 worker 逼进自我排障循环）
- 结果通道 = status 直发（契约见下）；验证 commit 后 `task-update --status completed` 收口
- 评审/复审类 task 不派 opencode——那些环节依赖 worker_done 结构化 payload，通道必须可靠

dev 完成后起复审（同 worktree 只读模式，不需要新 worktree；opencode 的"完成"信号 = status 直发或 commit 落地）：

**批量票先分流（2026-09-17 裁定）**：多张同构票（同一类翻译/搬运/适配，票间是并列而非设计依赖）**不要逐票复审**——全部开发完、一次评审 + 一个收敛循环。逐票复审的用途是「早发现设计决策错误，防下游票跟着错」；票间无设计依赖时（如 CF 移植这类同构批）逐票复审只会让同一类系统性问题被重复报 N 遍、且每票冷启动。判定口诀：**票间有真依赖（票 N+1 的正确性依赖票 N 的裁决）→ 逐票复审；同构并列 → 合并一次评审**。合并评审时把全部分票的 diff 作为一个整体送进同一个评审 session。

```bash
orca orchestration task-create --spec "对照 spec issue <N> 复审 worktree <N>-<slug> 的 diff（orca file open-changed --mode diff）。双轴：Standards（仓库规范）× Spec（对照票面）。只报 findings" --json
orca orchestration worker-start --task <review> --worktree name:<N>-<slug> --agent codex --json
```

修复回流（**named owner 原则**：计划里谁开发谁修）：

```bash
# 从 worker-show 拿 dev 的终端句柄，复用它派 fix task（同时转移清理责任）
orca orchestration worker-show --dispatch <dev_dispatch> --json     # 读 worker.agent_terminal_handle
orca orchestration worker-start --task <fix> --terminal <dev_handle> --worktree name:<N>-<slug> --json
#    复用终端必须显式带归属 worktree，否则 terminal_worktree_mismatch
```

循环：fix → 再复审 → 直到 clean 或 ESCALATE。**再复审复用原复审终端**（Phase 2 收敛循环同款：`worker-start --task <re-review> --terminal <复审 handle>`，task spec 为逐条核销上轮 findings + 只审本轮 fix diff 的双轴增量；复审 worker 循环期间不 release）。clean ＝ 上轮 findings 全核销 + 本轮增量零新增；复审轮数 >3 → gate 交人。深度超过 3–4 层依赖链时停下来重新拆票（`task-list --ready` 当外部记忆用）。

---

## Phase 4 · 测试 / ship / 拆除

**测试与冒烟**：

```bash
orca terminal split --terminal <dev_handle> --direction horizontal --command "npm test"
# UI 冒烟走 Orca 内嵌浏览器：goto → snapshot → click → wait --text（每次导航后重新 snapshot）
orca goto --url http://localhost:3000 && orca snapshot
```

视觉/设备类验证在 Orca 里人眼看（Design Mode / emulator）——这类工作 tests+logs 不算验收。

**Ship**：

```bash
# dev worktree 内（或让 dev worker 做）：
git push -u origin <branch>
glab mr create --title "<N> <标题>" --description "$(glab issue view <N> | ...)" --target-branch <default-branch>
```

**拆除清单**（顺序敏感）：

```bash
# 1. 每个 settled dispatch 释放（只关 Dispatch 拥有的 agent 终端，不删 worktree）
orca orchestration worker-release --dispatch <id> --json        # 逐个
# 2. 删 worktree（分支随删）；release 关不掉的 retained 终端（user_takeover 等）随 worktree rm 一并清理，Run 期间不必手动关
orca worktree rm --worktree name:<N>-<slug> --force
orca worktree rm --worktree name:coord-<feature> --force        # 协调舱也拆
# 3. 票状态收口
glab issue update <N> --label "done"   # 或你们的状态流转约定
```

Run 记录留档（审计用，无 run-delete，这是特性）。

---

## Worker 契约速查（注入的 preamble 会教，人会看更稳）

```bash
# 完成恰好报一次（失败用 --outcome failed，别只在正文里写失败）
orca orchestration send --type worker_done \
  --subject "<短状态>" --body "<做了什么/发现什么/剩什么>" \
  --task-id <task_id> --dispatch-id <dispatch_id> \
  --outcome succeeded --files-modified "path/a,path/b" --json

# 卡住要答案（不是要人拍板方案）
orca orchestration ask --question "..." --options "yes,no" --timeout-ms 600000 --json

# dispatch 通道两次被拒（capability 已撤）→ status 直发兜底，所有 agent 通用
orca orchestration send --type status \
  --subject "worker_done (fallback): <task_id> / <dispatch_id> <outcome> — <一句话结果 + commit>" \
  --body "<做了什么/发现什么/files-modified/剩什么>" --json

# 不发心跳：活性检查归协调会话（worker-show / terminal read）；capability 撤销后心跳只会变成 REJ 噪音
```

发完 `worker_done` 就停在 agent 提示符，不要自起后续工作。

## 决策速查

| 场景 | 用法 |
|---|---|
| 催一下现有终端 | `terminal send`（无跟踪） |
| 要 worker 按 task 汇报 | `worker-start`（监督式） |
| 整件事交出去不再看 | `worktree create --agent X --prompt ...`（handoff，禁 task-create/dispatch/check） |
| worker 问协调者 | `ask` / `reply` |
| 流程必须人选才能继续 | `gate-create` / `gate-resolve`（协调者建的 DAG 决策门） |

## 故障恢复

```bash
orca orchestration worker-show --dispatch <id> --json
#   ready       → 继续等 / worker-read 读有界输出
#   failed|stopped    → worker-start --task <t> --retry-of <id> --worktree ... --agent ...（重试不继承放置，要显式重给）
#   outcome_unknown   → worker-stop 后再看，或 worker-abandon（接受资源可能还活着）
# 彻底放弃本地编排态（仅恢复用）：
orca orchestration reset --tasks|--messages|--all --json
```

**Linux 机 agent 终端起即死**（2026-09-16 实证 ×3：worker-start 与 terminal create --command 均中招，终端回滚只剩 zsh 提示符或 `command not found: laude`）：oh-my-zsh 更新询问（13 天周期到期）抢在 agent 启动前，Orca 是往交互 zsh 里**敲**启动命令——命令被当成 `[Y/n]` 的答案吃掉，垃圾答案不写时间戳 → 之后每个新终端必弹。修复（等效答 n，管 13 天，不动 dotfile）：

```bash
echo "LAST_EPOCH=$(($(date +%s) / 86400))" > ~/.oh-my-zsh/cache/.zsh-update
```

永久方案 = `~/.zshrc` 取消注释 `zstyle ':omz:update' mode disabled`（用户 dotfile，先问再动）。鉴定特征：终端回滚首行 `[oh-my-zsh] Would you like to update? [Y/n]` 紧跟 agent 启动命令。codex 偶尔幸存是 `log/update.lock` 目录锁竞态，不可依赖。

**Linux 机 claude TUI 注入停在草稿**（2026-09-16 实证）：omz 修好后 claude TUI 能起，但 dispatch 注入的 preamble+TASK 落进 composer **不自动提交**——进程活着、屏幕底部就是注入文本末尾、无任何 UI chrome，worker 永远空转（codex 无此问题，自动吃 prompt）。修复：

```bash
orca terminal send --terminal <handle> --text "" --enter --json   # 手动提交草稿
```

起 claude worker 后必做 60 秒活性验证：屏幕底部应见 spinner/工作 UI 而非注入文本末尾。

## Rock5C 远程 worker（可选）

```bash
# Run/Task 留在本机，worker 放板子；之后命令按 dispatch 路由，不再带 --on
orca orchestration worker-start --task <t> --on Rock5C \
  --worktree new-top-level --repo <精确远端 repo selector> \
  --name <slug> --agent codex --setup run --json
# 注意：--model/--effort 转发需对端声明 launch-preference 支持；Mac 须在 110 网段
```

---

## Pilot 验证清单（run_fe1036f315cb · 2026-09-13 首跑实录）

- [x] `glab auth login` 后 `glab issue list -R <group>/<repo>` 出数
- [x] `/setup-matt-pocock-skills` 在 GitLab repo 上正确提议 GitLab 并写出 `docs/agents/issue-tracker.md`
- [ ] `/to-tickets` 产出的票带 blocked-by 关系（本次走 /to-spec 单票，未验证）
- [x] 协调会话（Orca 终端内 claude）`run-create` 干净绑定，`check --wait` 能收到消息（全 Run 20 条消费）
- [x] codex worker 免教学走 worker_done（首启信任框 1 次、retry 即恢复；v0.2 信任预置根除）
- [ ] opencode worker 同上 — ✗ 结构性缺口：注入确认 3/3 误判 `agent_prompt_stalled`（bug 报告已起草待提交），按降级监督协议绕行
- [x] ESCALATE 全程走 gate/AskUserQuestion，没有静默决策（3 gate 一次批量决议）
- [x] 拆除后 `orca worktree list` 干净、无孤儿 dispatch（37 活终端无一指向已删 worktree）
- [ ] （可选）Rock5C `--on` 放置成功且 `worker-read` 可读
