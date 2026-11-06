# Orca 1.4.190 Orchestration bug 报告（pilot Run 实证，待提交）

环境：macOS (Darwin 25.3.0) · Orca 1.4.190 · Orchestration（Settings → Experimental）开启 · repo 为 imported-existing-folder 的 git checkout
实证来源：Run `run_fe1036f315cb`（2026-09-13，11 个 dispatch / 20 条 inbox 消息 / 7 任务全完成）

---

## Issue 1（主）：opencode 监督式 dispatch 注入确认 3/3 误判 `agent_prompt_stalled`，capability 即撤

复现：

```
orca orchestration worker-start --task <t> --worktree new-child --name <name> --agent opencode --setup run --json
```

现象链：

1. dispatch 当场判 `agent_prompt_stalled` → dispatch failed、capability 撤销
2. 但注入文本实际全部送达 opencode TUI——worker 两次完整交付工作（commit `1d439be`、`7d275dd`），判死与事实不符
3. 后果：worker 的 `worker_done` 4/4 被拒（`dispatch_capability_invalid`）、`heartbeat` 6/6 被拒（inbox 噪音）、task 无法正式落账，只能人工 `task-update --status completed` 收口
4. 次生：retry 注入落在 worker mid-turn 时，会把 worker 逼进自我排障循环（反复重试 send/check 直到人工介入）

实证数据：

- 失败 dispatch：`ctx_c640b6bf` / `ctx_c875acf5` / `ctx_6d785c76`（同一 dev task 三连失败）+ `ctx_c7f733bf`（fix task）——opencode 0/4
- 同 Run 对照：claude 2/2 正常；codex 3/5（2 次失败分别见 Issue 2 / Issue 3，retry 均恢复）→ 判定逻辑对 opencode TUI 状态信号的解析存在缺口

期望修复（任一即可解锁完整监督契约）：

1. 修正注入确认对 opencode 的判定
2. 提供官方"placement-only"降级模式：dispatch 只负责放置，结果合法走 status 消息
3. capability 撤销前加宽限/复核，而非当场吊销

顺带确认一个正向事实：被拒消息在 Run inbox 里以 `_orcaLifecycleRejection` 存活、正文完整——建议写进文档（数据不丢）。

## Issue 2：codex 在新 worktree 首启弹信任框，吃掉注入 prompt → `agent_prompt_blocked`

复现：worktree 是主 checkout 的兄弟子目录（`~/orca/workspaces/<repo>/<name>`），codex 首启必问 trust repo root，注入的 preamble 被对话框消费 → dispatch failed（`ctx_e04d4e313bfb`）。

- 已验证恢复：`orca terminal wait --for tui-idle` → `worker-start --retry-of <id> --terminal <同终端>`
- 更优绕行（我们已写进 runbook v0.2）：worker-start 前向 `~/.codex/config.toml` 预写 `[projects."<worktree 绝对路径>"] trust_level = "trusted"`
- 建议：Orca 在 codex 启动前自动做信任预置，或首启后等待并代答信任框

## Issue 3（小）：codex TUI 内自升级后，PTY 排队 paste 溢进 zsh 缓冲 → 状态污染挂死

codex 在 TUI 里 `npm install -g` 自升级 → 退出到裸 shell → PTY 里排队的 paste 溢进 zsh（`^[[200~` 可见）→ 重启的 TUI 挂死。恢复 = 弃终端，`worker-start --retry-of --agent codex` 开新终端即干净（pilot 已验证）。建议 agent 启动参数禁自升级，或升级后自动重建终端。
