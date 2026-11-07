# T0.2 探针报告：纯 jj 目录的 Orca 生命周期

- 任务：governance-tasks.md v0.3 §T0.2（探针协议见 `execution/phase-0.2-brief.md`）
- 日期：2026-11-07
- 执行者：T0.2 探针子代理
- 探针问题：只有 `.jj`、没有 `.git` 的目录，能否经任一 Orca 注册入口完成注册、启动独立 Agent、再删除，且 jj 共享仓库仍可查询。

## 结论

**两入口皆败（平台缺口）。**

- **入口 A（`repo add`）**：对纯 jj 目录直接失败，错误为 `Not a valid git repository`（完整 JSON 见 §3）。Orca 的 `repo add` 只接受 git 仓库，不识别 jj 目录。
- **入口 B（`project setup-existing-folder`）**：失败发生在更靠前的一层——**CLI 无法新造 project**。`project setup-create` 要求 project 已存在（`Project not found`）；`setup-existing-folder` 携带全新 project id 时报 `Imported folder does not match the selected project identity`。该失败与目录是 jj 还是普通文件夹无关（错误出现在项目身份核对层，早于任何 git/jj 内容检查），即当前 CLI 没有任何能为任一新文件夹建立 project 的路径（`repo add` 校验 git、`setup-clone` 需要 git URL、`setup-create` 不铸造 project）。
- 两个入口都失败 → 按 accept rule 与 governance-tasks.md §2 停止条件，判定为平台缺口；后续环境适配任务（T2.3）开工前需要先在 Orca 侧获得（或等待）一个可用的 jj/文件夹注册通道，或在仓内决策改用 co-located jj（`.jj` + `.git` 并存）形态重测入口 A——本次探针按红线未做 Git 变体重试，该对照留给后续任务决定。
- 因注册即失败，协议步骤 4（`agent launch` 启动、`terminal list`、`terminal close`、`worktree rm` 删除序列）在两个入口下均未执行；启动回执、worktree ID、terminal handle、删除行为均为 **N/A（未到达该步骤）**。

## 环境与版本记录（协议步骤 1）

Orca CLI：`/Applications/Orca.app/Contents/Resources/bin/orca`（下称 `$ORCA`）。Orca 桌面已在运行。

| 命令 | 输出 | 退出码 |
|---|---|---|
| `$ORCA --help \| head -3` | `orca` / `Usage: orca <command> [options]` | 0 |
| `jj --version` | `jj 0.41.0` | 0 |
| `$ORCA status --json` | `app.running: true, pid: 478`；`runtime.state: "ready", reachable: true, connectionState: "connected"` | 0 |

`status --json` 关键字段：`runtimeId: "ca5d05e1-cd2e-42a8-b1fd-b53d97b4e567"`，**appVersion `1.4.238`**。

基准快照（探针前）：

- `$ORCA worktree list --json` → `result.worktrees` 29 条，`totalCount: 29`，`truncated: false`
- `$ORCA repo list --json` → `result.repos` 17 条

## 探针过程（协议步骤 2–6）

### 步骤 2：造两个纯 jj 临时仓库

偏差记录：简报原文使用 `mkdtemp -d`，本机（macOS）无该命令（`command not found: mkdtemp`），改用等价的 `mktemp -d /tmp/gov-probe-t02-XXXX`，得到 `TMP=/tmp/gov-probe-t02-6TIV`。其余步骤无偏差。

仓库 A：

```
jj git init --no-colocate "$TMP/probe-repo"        # exit 0（--no-colocate 在 jj 0.41.0 存在，无需替代参数）
ls -a "$TMP/probe-repo"                             # 仅 .jj（验证：NO .git / HAS .jj）
echo "probe content" > probe-file.txt && jj commit -m "probe"   # exit 0
jj log -r @ --no-graph -T 'commit_id'               # 1388edaa6298102058822d9b72d35b55f8435b7f（工作副本提交）
```

`probe` 提交本身为父提交 `3f43d504...`，工作副本非空。

仓库 B（同法，路径 `$TMP/probe-repo-b`）：仅 `.jj` 无 `.git`；`probe-b` 提交 `165fbd97...`，工作副本提交 `595212a35c1fe954014a26fb774336e86a9f9de7`。

### 步骤 3：入口 A —— `repo add`

```
$ORCA repo add --path "$TMP/probe-repo" --json
```

- 退出码：**1**
- JSON（完整关键字段）：

```json
{
  "ok": false,
  "error": {
    "code": "runtime_error",
    "message": "Not a valid git repository: /tmp/gov-probe-t02-6TIV/probe-repo"
  },
  "_meta": { "runtimeId": "ca5d05e1-cd2e-42a8-b1fd-b53d97b4e567" }
}
```

未到达 `repo show`（无 `kind` 字段可记录）。按协议不做变体重试，步骤 4 对入口 A 跳过。

### 步骤 5：入口 B —— `project setup-existing-folder`

**(a) 现有 project 清点**：`$ORCA project list --json` → 17 个 project，其中 16 个 `kind: git`，唯一 `kind: folder` 的 project 为 `playground`（id `repo:830efe52-5c24-4978-93a7-9043754b7367`，path `/Users/souler/Documents/daqian/playground`，`setupMethod: legacy-repo`）。该 project 是用户全部真实仓库的宿主（agents-impl、snow-mystery 系列等均挂在其下），**不是可复用的 sandbox project**；向其导入 /tmp 临时目录会改动真实注册状态，违反“全程只读现有注册仓库”的约束，故未复用。列表中没有 sandbox project。

**(b) 按简报允许创建专用 project**（先读了 `--help` 确认参数）：

```
$ORCA project setup-create --project gov-probe-sandbox --host local \
  --kind folder --path "$TMP/probe-repo-b" --state ready --display-name gov-probe-sandbox --json
```

- 退出码：**1**
- 错误：`{"ok": false, "error": {"code": "runtime_error", "message": "Project not found: gov-probe-sandbox"}}`
- 语义：`setup-create` 只为**已存在**的 durable project 补建 host setup 元数据，不铸造新 project。

**(c) 直接导入**：

```
$ORCA project setup-existing-folder --project gov-probe-sandbox --host local \
  --path "$TMP/probe-repo-b" --kind folder --json
```

- 退出码：**1**
- 错误：`{"ok": false, "error": {"code": "runtime_error", "message": "Imported folder does not match the selected project identity."}}`

**(d) 只读佐证**（selector 解析行为）：

```
$ORCA project setups --project gov-probe-sandbox --json   # ok: true, setups: []（selector 合法但匹配为空）
$ORCA project setups --project playground --json          # 按名解析成功（对照组）
```

即运行时接受任意 selector 字符串、但不为不存在的 project 建档；CLI 全量命令面（`orca --help`）中能产生新 durable project 的只有 `repo add`（校验 git）与 `project setup-clone`（需要 git URL），没有文件夹路径可用的新造入口。

**(e)** 因注册未成功，入口 B 的启动/删除序列（步骤 4 同款）同样未执行。

### 步骤 6：jj 侧完整性（删除前）

仓库 A：`jj workspace list` → `default: qxumxpum 1388edaa`（exit 0）；`jj log --no-graph -T 'commit_id' -r 'all()' | head -3` → `1388edaa...`、`3f43d504...`、jj 合成根（exit 0）。

仓库 B：`jj workspace list` → `default: lmvzvwxw 595212a3`（exit 0）；同款 log → `595212a3...`、`165fbd97...`、根（exit 0）。

两仓共享仓库在探针全程可查询；清理时目录已随 `rm -rf "$TMP"` 一并消失（见下）。

## 清理（协议步骤 7）

所有写操作都在建档前失败，Orca 侧本就未产生新资源；逐项核对：

| 核对项 | 结果 |
|---|---|
| `terminal list --worktree path:<A>` / `path:<B>` | 各 0 条（从未启动过终端） |
| `worktree list --json` 条目数 | 29（== 基准） |
| `repo list --json` 条目数 | 17（== 基准，无新增条目需评估移除） |
| worktree/repo/project 三列表 grep `gov-probe-t02` | 0 命中 |
| `project list --json` grep `gov-probe-sandbox` | 0 命中 |
| `project setups --project gov-probe-sandbox --json` | `setups: []`（无残留） |
| `rm -rf "$TMP"`（/tmp/gov-probe-t02-6TIV） | exit 0，目录消失，`/tmp` 下无 gov-probe-t02 条目 |

## 残余资源

**无。** Orca 注册面（worktree 29 / repo 17 / project 17 / setups 17）与基准完全一致；/tmp 临时目录已删除。唯一新增产物为本报告文件与 `execution/phase-0.2-report.md`（后者在 gitignore 的 execution/ 目录内，不进版本库）。

## 附注（对后续任务的输入）

1. **失败层级区分**：入口 A 死于 git 校验层（jj 目录被拒）；入口 B 死于 project 铸造层（任何新文件夹都进不去，与 jj 无关）。T2.3 若要“适配环境”，两个层都要有解；若 Orca 后续版本放开文件夹建档，入口 B 值得原样重测。
2. **未测对照**：co-located jj（`.jj` + `.git` 并存）目录走入口 A 是否可行，属 Git 变体，按红线本次未试，可作为 T2.3 的第一候选实验。
3. `playground` 是唯一 folder-kind project 且 `setupMethod: legacy-repo`，说明现存文件夹 project 来自旧版 Orca 的导入路径，当前 CLI（appVersion 1.4.238）没有等价命令。
