# Codex 双闸门证据（2026-11-14）

本文件保存工程交付双闸门的具体会话证据索引，供 `workflow-profiles-plan.md` P2.3 使用。

## 证据样本

- `/Users/souler/yfp/.claude/projects/-Users-souler-orca-workspaces-agents-impl-feat-actor-agent-0930/6778ef10-1121-4ac8-bde9-ffb12aed2465.jsonl`：子代理调研→grill-with-docs→四相位实现→Codex APPROVED；测试记录为 530/530 和 171/171 通过，之后进入人工分支去向决定。
- `/Users/souler/yfp/.codex/sessions/2026/10/13/rollout-2026-10-13T20-15-40-01a13530-9d4a-7642-8015-40a7eb606c07.jsonl`（LuxxActivationTest）：规格评审通过→subagent-dev-simple 实现并获 Opus 终审通过→Codex impl-mode READY→合并。记录同时显示部署仍是人工步骤。
- `/Users/souler/yfp/.codex/sessions/2026/09/27/rollout-2026-09-27T01-26-04-01a0dec0-af10-75b3-afcb-a6290fec1aaf.jsonl`（LuxxRebuildPlan impl-mode 质量门）：实现后出现 `FIX-FIRST`，说明实现评审关注代码级缺陷，与规格评审关注所有权、接口和范围矛盾不同。
- `/Users/souler/yfp/.codex/sessions/2026/10/28/rollout-2026-10-28T22-24-54-01a182e6-50e9-7b22-bfa1-2e524e94e8b6.jsonl`（actor-room impl 多轮评审）：迭代至无未停泊的中高严重度问题后收敛，但评审记录明确未运行完整测试或构建，因此评审不能替代测试。
- `/Users/souler/yfp/.codex/sessions/2026/11/01/rollout-2026-11-01T18-22-19-01a196a1-ab25-7bd0-9bb4-6a7f744febdf.jsonl`（nexus-judge）：独立 judge 按评分规则对实验输出打 JSON 分，说明实验效果评测与实现评审分离。

## 结论

标准或高风险工程交付可以采用“规格评审→实现评审→独立总审”的双闸门；简单任务可以一次终审。`NOT-READY` 后若继续，必须有操作员豁免记录。双闸门不等于自动 push 或自动部署，分支和部署仍由人决定。
