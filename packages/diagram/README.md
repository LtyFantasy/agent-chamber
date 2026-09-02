# @agent-chamber/diagram

archify 渲染器的快照式 vendor 包（Diagram IR v1 Phase 0）。**零 npm 依赖、纯 `.mjs`、无构建步骤**——backend 以文件路径 spawn 子进程调用（`node renderers/<type>/render-<type>.mjs <input.json> <output.html>` + `node scripts/check-render-output.mjs <output.html>`），不经 import/构建。

## 目录结构

```
bin/                    # archify CLI 四命令（archify / preview / visual-check / open-artifact），保持 CLI 完整
renderers/              # 5 类型渲染器 + shared/（含 generated-validators.mjs、generated-brand-marks.mjs）
assets/template.html    # 自包含 viewer 模板（唯一补丁点，见 NOTICE）
schemas/                # 5+1 JSON Schema（契约文档 + 再生成源）
scripts/check-render-output.mjs  # 纯静态 HTML artifact 检查（无 Chrome 依赖）
brand-marks/catalog.json        # 品牌目录（文档源；运行时读 generated-brand-marks.mjs）
test/fixtures/          # 5 型各 1 个真实 IR（smoke / 未来 e2e fixture）
LICENSE                 # 上游 MIT 原样副本
NOTICE                  # vendored-from 声明 + 本地补丁清单（同步必读）
```

## 上游同步流程

1. 重拷：按 NOTICE「裁剪说明」从 `.agents/skills/archify/` 重拷全部 vendored 文件（保持目录结构）。
2. 重打补丁：按 NOTICE「本地补丁清单」逐条重打（当前唯一 = `assets/template.html:6` generator meta）。
3. 跑 smoke：`pnpm --filter @agent-chamber/diagram smoke`（5 型 render + check + 确定性断言全绿）。
4. 版本/commit 变更时同步更新 NOTICE 的版本与引入 commit。

## 裁剪注意

- **不拷 `examples/` 后，bin 的无参 render/demo 模式不可用**：`renderers/shared/cli.mjs:21` 缺省输入指向 `skillRoot/examples/<defaultExample>`。服务端 spawn 恒带显式路径参数，不受影响；本地想玩 demo 需自行提供输入文件。
- **再生成 validators**：`renderers/shared/generated-validators.mjs` 是 AJV standalone 预编译产物（运行时零 ajv 依赖）。如需再生成，临时沙箱 `npm i ajv` 后跑上游 `scripts/generate-validators.mjs`——v1 不引入 ajv 依赖。
- **安全收口（R3）**：服务端 spawn 渲染器时**永不设置** `ARCHIFY_REPO_ROOT`（否则 `verifyRepositoryEvidence` 会读仓库文件），且 env 合并时显式剔除该变量；含 `meta.repository` / `components[].sources`（非空）的 IR 由平台 validator 前置拒绝。

## 冒烟

```bash
pnpm --filter @agent-chamber/diagram smoke
```

`scripts/smoke.mjs`：对 5 个 fixture 逐一跑渲染器 + checker（exit 0 且 `ok=true`），并断言同一 fixture 连渲两次 HTML sha256 相等（"HTML 是 IR 的确定性编译产物"的机器验证）。非零退出码 = 失败。
