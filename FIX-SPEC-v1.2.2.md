# FIX-SPEC v1.2.2：累计失败标记（最后 1 个 BLOCKER）+ 2 条 NIT

## BLOCKER（引擎）

`lib/engine.js:351`：本轮多个 peer 依次合并 workspace 时，**后续成功合并会清除/覆盖先前失败的标记**。只读复现：第 1 次合并缺 `createdAt` 产生 error，第 2 次 peer 合并成功 → 最终 `errors` 非空，但 create/attach/archive/pin 仍各调用一次。

要求：
1. 每轮 cycle 引入 `workspaceMergeFailed`（仅本轮累计，不清除）：任何一次合并被拒、`merged:false`、或产生 errors → 置为 true。
2. registry 应用前检查该标记：为 true → **整轮零 registry mutation**，错误/警告保留，状态标注 `registrySkippedReason`。
3. `errors` 必须累计（不能因后续成功被覆盖）。
4. 新增测试：「先坏后好」：peer1 合并失败（缺 createdAt/坏条目）→ peer2 合并成功 → registry 四个 API 调用总数为 0，且 errors 包含 peer1 的错误。
5. 既有「合法合并后正常应用」用例保持通过。

## NIT 1：逐 API 故障注入补「首项失败、次项继续」

`tests/registry.test.mjs`：attach / archive / pin 各自补一个「第一个 ID 抛错、第二个 ID 成功」的用例，断言：
- 第一个错误进入 warnings/errors；
- 第二个的 API 调用发生（计数 +1）；
- 循环继续，不中断。

## NIT 2：文档与验收口径

- README / ACCEPTANCE：明确 `registryApplied.archived/pinned` 统计的是**成功调用的 API 次数**（即使宿主对已归档/已置顶是 no-op，applier 仍会调用并计数）；合并失败的轮次不计数。
- 补一个「重复轮」测试：带 archived/pinned 集合连续两轮应用，断言幂等（第二轮调用次数为 0 或与宿主 no-op 语义一致，按实现明确断言）。

## 验收

1. `node --check` 全部；
2. 七个测试文件 exit 0；
3. 交 Codex 复审，无 BLOCKER 后进入提交/重载/线上验证。
