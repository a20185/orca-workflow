# T0.4 探针报告：工作文件可写且版本元数据不可写（双层挂载）

- 任务：governance-tasks.md v0.4 §T0.4（探针协议见 `execution/phase-0.4-brief.md`）
- 日期：2026-11-07
- 执行者：T0.4 探针子代理
- 探针问题：双层挂载（`ws` 根 ro + `ws/src` rw）下，容器内非 root 用户（1000:1000）能否写源码但碰不了 `.jj` 与 `.git`（读/写/改名/删除/符号链接/解释器子进程全测）；宿主 jj 是否仍可正常 snapshot。

## 结论

**双层挂载成立（按验收规则四条逐一通过），Track B（T5.2）可开工；但附带一个必须入档的平台事实：读取保护不成立——容器内可读 `.jj` / `.git`。**

验收规则逐条判定：

1. **普通文件新增和修改成功**：a（`new.txt` 新建）、b（`hello.txt` 追加）、P1（`py.txt`）、N1（`node.txt`）全部 rc=0。
2. **所有元数据变更路径失败**：d/d2（在 `.jj`/`.git` 内建文件）、e/e2（改名，简报标注的关键断言）、f（rm -rf 全树）、h2（写穿符号链接）+ P2–P5/P8/P9 + N2–N5/N8 全部被拒，errno 统一为 30 / EROFS（`Read-only file system`）；shell、Python、Node 三面零差异。
3. **符号链接不能绕过（写侧）**：符号链接本身可在 src 内合法创建（rw 区内建 dirent，属预期），但写穿符号链接到 `.jj` 目标全部 EROFS 拒绝（h2/P8/N8）。
4. **宿主能读取预期源码 diff**：`jj st` / `jj diff --summary` 精确列出 7 项 src/ 内变更（M hello.txt、A new.txt、A py.txt、A node.txt、A lnk、A pylnk、A nodelnk），元数据零变化；`jj commit -m probe2` 成功，git/jj 双面 commit_id 一致。

偏差记录（不在验收规则内，但证伪了协议 T1 对 c/c2/h1「预期拒绝」的假设）：c（`cat .jj/repo/store/type`）、c2（`cat .git/HEAD`）、h1/P7/N7（经符号链接读）在容器内**成功**。根因见「双层挂载实况与平台机理」：Docker Desktop macOS 的 bind mount 以 fakeowner 文件系统呈现，宿主 `chmod -R go-rwx` 的 DAC 在容器内被架空；ro 挂载位只拦写不拦读。即：**写保护 = 内核级（ro 挂载位）成立；读保护 = 本平台不存在**。若 Track B 设计需要容器不可读 `.jj`/`.git`（防历史/配置泄露），须另加层，见「对 Track B 的口径」。

## 环境与版本记录（协议步骤 1）

| 命令 | 输出 | 退出码 |
|---|---|---|
| `jj --version` | `jj 0.41.0` | 0 |
| `docker --version` | `Docker version 29.6.1, build 8900f1d` | 0 |

- `TMP=$(mktemp -d /tmp/gov-probe-t04-XXXX)` → `/tmp/gov-probe-t04-yns7`；`jj git init "$TMP/ws"` exit 0，目录内 `.jj` 与 `.git` 并存——jj 0.41.0 的 `jj git init` 默认即 colocated（与 T0.2b 探针结论一致），未触发 `--colocate` 重造回退分支。
- 写入 `src/hello.txt` 后 `jj commit -m probe` → exit 0。commit_id 记录（`jj commit` 后 `@` 已是新的空工作副本提交，沿用 T0.2b 口径同时记录两个）：

| 面 | 命令 | 值 |
|---|---|---|
| jj probe 提交（`@-`） | `jj log -r @- --no-graph -T commit_id` | `e9118e6265cd8243f754128b57b4c29df606bac6` |
| jj 新工作副本（`@`） | `jj log -r @ --no-graph -T commit_id` | `a313de295f749a22fb8eefccd8c739ac0a29e5b1` |

- 宿主权限位（`chmod -R go-rwx .jj .git` + `chmod 777 src` 之后，`ls -la` 实录）：`.git` `drwx------`、`.jj` `drwx------`（宿主侧 go-rwx 生效）、`src` `drwxrwxrwx`、`src/hello.txt` `-rw-r--r--`（宿主 souler:staff）。

## 双层挂载实况与平台机理（协议步骤 2 i）

容器内 `id`：`uid=1000 gid=1000 groups=1000`。`mount | grep /work` 实录：

```
/run/host_mark/private on /work type fakeowner (ro,nosuid,nodev,relatime,fakeowner)
/run/host_mark/private on /work/src type fakeowner (rw,nosuid,nodev,relatime,fakeowner)
```

两个关键事实：

1. 双层挂载按协议建立：`/work` ro 在下、`/work/src` rw 覆盖其上。
2. **Docker Desktop macOS 的 bind mount 是 fakeowner 文件系统**：容器内 `ls -la /work` 显示 `.jj`、`.git` 属主为 `1000 1000`（即访问者本人），宿主侧 `chmod go-rwx` 的 DAC 位在容器内被架空——权限检查按「访问者=所有者」通过。由此推出本报告全部现象的机理：
   - **写侧唯一屏障 = ro 挂载位**（内核 VFS 层，EROFS），对 shell 与任何解释器子进程同等强制，且改名/删除动的是 ro 父目录 `/work` 的 dirent，同样落在 EROFS 上；
   - **读侧无屏障**：ro 挂载允许读，DAC 又被 fakeowner 架空——c/c2/h1 读取成功的根因。

平台口径：Linux 原生 bind mount 无 fakeowner，DAC 真实生效（chmod 700 + 非 owner 会把读写都拒为 EACCES）。本报告结论以本机 Docker Desktop macOS 面为准；部署面若换 Linux，读面行为可能不同，迁移前须重跑本探针。

## 直接操作测试（协议步骤 2：alpine shell，`-u 1000:1000`）

挂载：`docker run --rm -v "$TMP/ws:/work:ro" -v "$TMP/ws/src:/work/src:rw" -u 1000:1000 alpine sh -c '<逐条>'`。每条以 `sh -c` 独立执行并回收 rc 与 stderr 文案。

| # | 命令 | 预期 | 实际 | errno / 文案 |
|---|---|---|---|---|
| a | `echo hi > /work/src/new.txt` | 成功 | rc=0 成功 | — |
| b | `echo more >> /work/src/hello.txt` | 成功 | rc=0 成功（hello.txt 6→11 字节，宿主侧核验） | — |
| c | `cat /work/.jj/repo/store/type` | 拒绝（只读或权限不足） | **rc=0 成功，输出 `git`** | —（读面偏差，见结论） |
| c2 | `cat /work/.git/HEAD` | 拒绝 | **rc=0 成功，输出 `e9118e6265cd8243f754128b57b4c29df606bac6`** | —（读面偏差） |
| d | `echo x > /work/.jj/probe` | 拒绝 | rc=1 拒绝 | `sh: can't create /work/.jj/probe: Read-only file system`（EROFS） |
| d2 | `echo x > /work/.git/probe` | 拒绝 | rc=1 拒绝 | `sh: can't create /work/.git/probe: Read-only file system` |
| e | `mv /work/.jj /work/.jj2` | 拒绝（关键断言） | rc=1 拒绝 | `mv: can't rename '/work/.jj': Read-only file system` |
| e2 | `mv /work/.git /work/.git2` | 拒绝 | rc=1 拒绝 | `mv: can't rename '/work/.git': Read-only file system` |
| f | `rm -rf /work/.jj /work/.git` | 拒绝 | rc=1 拒绝 | 逐条 `rm: can't remove '<路径>': Read-only file system`——`.jj` 全树（op_store/operations、views、index/segments、store/extra 等）与 `.git` 全树（objects、refs/jj/keep、index、HEAD…）共 60+ 条目无一成功 |
| g | `mkdir /work/newdir` | 拒绝（根只读） | rc=1 拒绝 | `mkdir: can't create directory '/work/newdir': Read-only file system` |
| h1 | `ln -s /work/.jj/repo/store/type /work/src/lnk && cat /work/src/lnk` | 读取拒绝 | 符号链接创建成功；**cat rc=0 读出 `git`** | —（读面偏差） |
| h2 | `echo x > /work/src/lnk` | 写入拒绝 | rc=1 拒绝 | `sh: can't create /work/src/lnk: Read-only file system` |
| h3 | `ls -l /work/src/lnk` | （核查项） | `lrwxr-xr-x 1 1000 1000 … /work/src/lnk -> /work/.jj/repo/store/type`——确为符号链接，h2 的拒绝是写穿目标被拦，真实有效 | — |

e/e2 的机理注记：改名操作要写父目录 `/work` 的 dirent，而 `/work` 整体 ro——这正是双层挂载防「改名绕过」的位置，实测拦住。

## 解释器子进程测试（协议步骤 3：同挂载、同用户）

### Python（`python:3-alpine`，`python -c`，异常逐条捕获 OSError）

| # | 操作 | 预期 | 实际 | errno |
|---|---|---|---|---|
| P1 | `open('/work/src/py.txt','w')` 写入 | 成功 | OK（`written`） | — |
| P2 | `open('/work/.jj/repo/store/type','a')` | 拒绝 | DENIED OSError | `errno=30 (Read-only file system)` |
| P3 | `open('/work/.git/HEAD','a')` | 拒绝 | DENIED OSError | `errno=30` |
| P4 | `os.rename('/work/.jj','/work/.jj2')` | 拒绝 | DENIED OSError | `errno=30` |
| P5 | `os.rename('/work/.git','/work/.git2')` | 拒绝 | DENIED OSError | `errno=30` |
| P6 | `os.symlink('/work/.jj/repo/store/type','/work/src/pylnk')` | 创建成功 | OK | — |
| P7 | 经 `/work/src/pylnk` 读 | （读面） | **OK，读出 `'git'`** | —（读面偏差） |
| P8 | 经 `/work/src/pylnk` append | 拒绝 | DENIED OSError | `errno=30` |
| P9 | `shutil.rmtree('/work/.jj')` | 拒绝 | DENIED OSError | `errno=30` |

### Node（`node:20-alpine`，`node -e`，try/catch 打印 code）

| # | 操作 | 预期 | 实际 | code / errno |
|---|---|---|---|---|
| N1 | `fs.writeFileSync('/work/src/node.txt','node\n')` | 成功 | OK（`written`） | — |
| N2 | `fs.appendFileSync('/work/.jj/repo/store/type','x')` | 拒绝 | DENIED | `code=EROFS errno=-30` |
| N3 | `fs.appendFileSync('/work/.git/HEAD','x')` | 拒绝 | DENIED | `EROFS -30` |
| N4 | `fs.renameSync('/work/.jj','/work/.jj2')` | 拒绝 | DENIED | `EROFS -30` |
| N5 | `fs.renameSync('/work/.git','/work/.git2')` | 拒绝 | DENIED | `EROFS -30` |
| N6 | `fs.symlinkSync('/work/.jj/repo/store/type','/work/src/nodelnk')` | 创建成功 | OK | — |
| N7 | 经 `/work/src/nodelnk` 读 | （读面） | **OK，读出 `git`** | —（读面偏差） |
| N8 | 经 `/work/src/nodelnk` append | 拒绝 | DENIED | `EROFS -30` |

解释器与 shell 三面零差异：全部由 ro 挂载位在 VFS 层统一拦截，errno 一致（Python 30 / Node -30 / busybox 文案）。「Bash 拦得住、解释器拦不住」的疑虑不成立。

## 宿主 snapshot 验证（协议步骤 4）

容器跑完后宿主侧（`-R "$TMP/ws"`）：

- `ls -la ws/src`（宿主视角）：`new.txt`、`py.txt`、`node.txt` 与三个符号链接全部出现，属主 souler:staff——Docker Desktop 以宿主用户身份落盘写穿，无 uid 错位，宿主工具链可直接接管。
- `jj st` / `jj diff --summary`：精确列出 7 项变更（M `src/hello.txt`；A `src/new.txt`、`src/py.txt`、`src/node.txt`、`src/lnk`、`src/pylnk`、`src/nodelnk`）——全部在 src/ 内，`.jj`/`.git` 元数据零变化。
- `jj commit -m probe2` → exit 0，commit_id `9b23bfbb5f5d91c99659ae80c5e6705f5485ff71`；`git log --oneline -3` 双面一致（`9b23bfb probe2` / `e9118e6 probe`）；提交后 `jj st` 干净（`working copy has no changes`）。
- `git fsck --no-progress` → rc=0（仅 `jj git init` 自带的空 dangling blob `e69de29`，与容器操作无关）——容器全程操作后元数据完整性无损。

「容器内可写源码 + 宿主独占 jj 操作」共存成立。

## 对 Track B（T5.2）的口径

1. 写保护以 ro 挂载位为唯一可靠机制——内核级、解释器无关、覆盖改名/删除/建文件/写穿符号链接全部路径；宿主 chmod 只作纵深，不进容器。
2. **读保护在本平台不存在**（fakeowner 架空 DAC + ro 不拦读）：T5.2 若要求容器不可读 `.jj`/`.git`，不能依赖本方案，须另加层（例：只挂 `src` 不挂 ws 根；或把版本元数据移出共享面）。
3. 符号链接是容器可合法制造的产物：可指向 `/work/.jj` 并读穿（读面），写穿必拒；宿主 jj 会把符号链接记为新增文件——T5.2 的产物清理与审计清单应把符号链接列入。

## 残余资源

- 容器：`docker ps -a --filter name=gov-probe` 零条（全部 `--rm` 即退，无命名容器）。
- `/tmp`：`/tmp/gov-probe-t04-yns7` 已 `rm -rf`，`/tmp/gov-probe-t04-*` 无任何残留。
- 镜像（保留不删，公共镜像）：`alpine:latest`（3f4d6b32e267）、`python:3-alpine`（a0f2e268f2ce）、`node:20-alpine`（fb4cd12c85ee）。
- 仓库内新增仅本报告文件；过程摘要另存 `execution/phase-0.4-report.md`（在 execution/ 自带 gitignore 内，不进版本库）。
