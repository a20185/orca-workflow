# T0.2b 探针报告：colocated jj 仓（.jj + .git 并存）的 Orca 生命周期

- 任务：governance-tasks.md v0.4 §T0.2b（探针协议见 `execution/phase-0.2b-brief.md`）
- 日期：2026-11-07
- 执行者：T0.2b 探针子代理
- 探针问题：`.jj` 与 `.git` 并存的 colocated jj 仓，能否完成 Orca 注册 → 无 prompt 启动独立 Agent 终端 → 删除，且删除前后 jj 侧可查询、无残留。

## 结论

**colocated 全链通过，T2.3 解锁。** 注册、启动、jj 查询、删除四环节全部走通，Orca 注册面与基准完全一致、无残留。删除环节的实际行为与简报预期不同，记录为口径修正而非失败（见 §删除行为）：

- **可注册**：`repo add` 对 colocated 仓直接成功，`kind: "git"`（Orca 只见 git 面，`.jj` 不构成障碍）。
- **可启动**：`agent launch --agent claude`（不带 `--prompt`）成功开出独立终端，Claude Code 在仓目录内启动并等待信任确认（未见 trust 预置时这是预期行为，属 T2.3 需预置的工作区信任问题，治理文档 §8.1/T3.1/T5.1 已有记载）。
- **jj 侧完整**：启动 Agent 之后、注销注册之前，`jj st` 干净、`jj log -r 'all()'` 三提交齐整；注销之后复查仍一致，jj/git 双面 `commit_id` 全程相同。
- **可删除**：注册项可完整注销、列表回到基准；但注销走的是 `project setup-delete --force`，不是 `worktree rm`——后者对 `repo add` 注册的仓根本身拒绝执行（保护主工作树）。目录本身不由 Orca 从磁盘删除，由协议自身的 `rm -rf "$TMP"` 移除。

三条对 T2.3 直接可用的操作口径（均为本探针实测）：

1. **路径选择器必须用 `/private/tmp` 形态**：`repo add --path /tmp/...` 登记后存储路径为 `/private/tmp/...`（macOS 符号链接归一化），后续 `path:/tmp/...` 选择器一律 `repo_not_found`，须用 `path:/private/tmp/...`。
2. **注销 `repo add` 注册项的命令是 `project setup-delete --setup <repoId> --force`**：repo 记录与 `legacy-repo` 型 project host setup 同 id（本例 `bfa21ed5-5ec5-4238-b95e-b020febc8882`）；不带 `--force` 会因「已保存工作区详情」拒绝。CLI 无 `repo remove` 命令。
3. **`worktree rm` 只适用于 Orca 自建工作树**：对注册仓根（`isMainWorktree: true`）即使 `--force` 也拒绝（`Refusing to delete protected worktree path`），且 Orca 注销时不删除磁盘目录——对非自建目录不执行 `rm` 是其保护语义，磁盘清理由调用方负责。

## 环境与版本记录（协议步骤 1）

Orca CLI：`/Applications/Orca.app/Contents/Resources/bin/orca`（下称 `$ORCA`）。Orca 桌面已在运行。

| 命令 | 输出 | 退出码 |
|---|---|---|
| `jj --version` | `jj 0.41.0` | 0 |
| `$ORCA status --json` | `app.running: true, pid: 478`；`runtime.state: "ready", reachable: true, connectionState: "connected"` | 0 |

`status --json` 关键字段：`runtimeId: "ca5d05e1-cd2e-42a8-b1fd-b53d97b4e567"`，**Orca appVersion `1.4.238`**。

基准快照（探针前）：

- `$ORCA worktree list --json` → `result.worktrees` 29 条，`totalCount: 29`
- `$ORCA repo list --json` → `result.repos` 17 条

## 探针过程（协议步骤 2–6）

### 步骤 2：造 colocated 临时仓

```
TMP=$(mktemp -d /tmp/gov-probe-t02b-XXXX)   # → /tmp/gov-probe-t02b-ByUZ
jj git init "$TMP/probe-repo"                # exit 0
ls -a "$TMP/probe-repo"                      # . 与 .git 并存：.jj PRESENT / .git PRESENT
```

- jj 0.41.0 的 `jj git init <路径>` **默认即 colocated**（与 T0.2 用 `--no-colocate` 强制纯 jj 互为印证），无需 `--colocate` 重造，未发生简报预设的回退分支。
- 写入 `src/hello.txt` 后 `jj commit -m probe` → exit 0：

| 面 | 命令 | 值 | 退出码 |
|---|---|---|---|
| jj（probe 提交 `@-`） | `jj log -r @- --no-graph -T commit_id` | `23b122454cb19f0bbd4c9d82bee0462ef21f8f38` | 0 |
| jj（新工作副本 `@`） | `jj log -r @ --no-graph -T commit_id` | `7c6bfc6d175fe969ae89c7705163bb4cd192f3d3` | 0 |
| git | `git -C "$TMP/probe-repo" log --oneline -1` | `23b1224 probe` | 0 |

colocated 双面一致性成立：jj `commit_id` 与 git SHA 逐位相同（`23b1224...`）。偏差记录：`jj commit` 后 `@` 已是新的空工作副本提交，故同时记录 `@` 与 `@-` 两个 `commit_id`，以 `@-` 为 probe 提交。

### 步骤 3：注册

```
$ORCA repo add --path "$TMP/probe-repo" --json     # exit 0
```

关键字段：`ok: true`；`repo.id: "bfa21ed5-5ec5-4238-b95e-b020febc8882"`；`kind: "git"`（预期值）；`displayName: "probe-repo"`；**存储路径为 `/private/tmp/gov-probe-t02b-ByUZ/probe-repo`**（归一化发生在此步）。

```
$ORCA repo show --repo path:"$TMP/probe-repo" --json          # exit 1，repo_not_found
$ORCA repo show --repo path:"/private/tmp/.../probe-repo" --json  # exit 0，kind: "git"
```

`path:` 选择器按存储的归一化路径精确匹配，`/tmp` 形态查不到（口径 1 的出处）。

### 步骤 4：启动（无 prompt）

```
$ORCA agent launch --agent claude --worktree path:"/private/tmp/gov-probe-t02b-ByUZ/probe-repo" --json   # exit 0
```

关键字段：

- `outcome.kind: "terminal"`，**终端句柄 `handle: "term_e2bb7c29-5693-437f-a0e4-3ad6548a1920"`**
- `worktreeId: "bfa21ed5-5ec5-4238-b95e-b020febc8882::/private/tmp/gov-probe-t02b-ByUZ/probe-repo"`（注册仓根即主工作树）
- `receipt`: `mode/preferred: "terminal"`, `reason: "user_default"`；未携带任何 prompt

`terminal list --worktree path:"/private/tmp/..." --json` → exit 0，`totalCount: 1`：

- `handle` 同上；`agentIdentity: "claude"`；`connected: true`；`orphaned: false`；`title: "cglm"`
- `preview` 显示 Claude Code 已在仓目录内启动并弹出目录信任确认（`Quick safety check: Is this a project you created or one you trust? ... ❯ No, exit`）——探针不与终端交互，启动成功即满足验收；信任预置是 T2.3 的已知事项。

### 步骤 5：jj 侧完整性（删除前）

```
jj -R "$TMP/probe-repo" st                                # exit 0：working copy 无变更，@ = 7c6bfc6d，@- = 23b12245 "probe"
jj -R "$TMP/probe-repo" log --no-graph -T commit_id -r 'all()' | head -3
# 7c6bfc6d175fe969ae89c7705163bb4cd192f3d3
# 23b122454cb19f0bbd4c9d82bee0462ef21f8f38
# 0000000000000000000000000000000000000000   （root）       # exit 0
```

此时 `worktree list` 的该条目 `head: "23b122454cb19f0bbd4c9d82bee0462ef21f8f38"`——Orca 的 git 面读数与 jj `commit_id` 相同。

### 步骤 6：清理与删除行为

按序执行及结果：

| 命令 | 退出码 | 关键结果 |
|---|---|---|
| `$ORCA terminal close --worktree path:"/private/tmp/..." --all --json` | 0 | `closed: 1, stopped: 1, retiredSurfaces: true` |
| `$ORCA worktree rm --worktree path:"/private/tmp/..." --force --json` | **1** | `runtime_error: "Refusing to delete protected worktree path: /private/tmp/gov-probe-t02b-ByUZ/probe-repo"` |
| `$ORCA project setups --project "repo:bfa21ed5..." --json`（定位注销通道） | 0 | 1 条 setup：`setupMethod: "legacy-repo"`，`id = repoId = bfa21ed5-...` |
| `$ORCA project setup-delete --setup "bfa21ed5-..." --json` | **1** | 拒绝：`This project has saved details for 1 workspace ... Re-run with --force` |
| `$ORCA project setup-delete --setup "bfa21ed5-..." --force --json` | **0** | `ok: true`，回执含被移除的 project + setup + repo 三记录 |
| `ls "$TMP/probe-repo"` | 0 | **目录仍在**（注销不删磁盘，见口径 3） |
| `rm -rf "$TMP"` | 0 | 目录消失，`/tmp` 下无 gov-probe 条目 |

`worktree rm` 拒绝时的现场：`worktree list` 30 条（该条目 `isMainWorktree: true`）、`repo list` 18 条。`setup-delete --force` 之后：

- `$ORCA worktree list --json` → **29 条**（回到基准）；`$ORCA repo list --json` → **17 条**（回到基准）
- worktree / repo / project 三列表 grep `gov-probe-t02b` → 0 命中
- `$ORCA terminal list --json` → 全局 32 台终端，引用探针路径的 0 台

删除后 jj 复查（注销后、`rm -rf` 前）：`jj st` 干净、`@-` 仍为 `23b122454cb19f0bbd4c9d82bee0462ef21f8f38`、git 面 `23b1224 probe`——完整 Orca 生命周期未触碰 jj 状态。

删除行为判定：`worktree rm` 的拒绝是**对注册仓根的保护语义**，不是 colocated 形态的失败——同一目录上注册、启动、jj 查询均已成功，且存在 CLI 自身文档标注的注销通道（`project setup-delete` 帮助文本："Repo-backed setups remove the registered repo compatibility record"），走通后注册面零残留。按简报「repo 注册项若残留记录处置」的要求，处置方式即口径 2。

## 残余资源

**无。** Orca 注册面（worktree 29 / repo 17）与基准完全一致；project 列表无探针条目；终端无探针引用；`/tmp/gov-probe-t02b-ByUZ` 及本探针的全部临时 JSON 已删除。唯一新增产物为本报告文件与 `execution/phase-0.2b-report.md`（后者在 gitignore 的 execution/ 目录内，不进版本库）。
