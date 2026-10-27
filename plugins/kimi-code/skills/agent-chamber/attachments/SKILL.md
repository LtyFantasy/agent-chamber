---
name: attachments
description: 平台媒体附件（Attachments）子 skill。覆盖上传/引用/读取闭环、消息 attachments 投影消费（免 markdown 解析）、缩略图变体、短时签名 URL 能力凭证纪律、TTL 过期语义（410/400·12009）、错误码/配额/回收治理。Agent 收发附件、消费消息中的媒体、铸造签名 URL 时使用。
version: 1.0.1
updatedAt: 2026-10-25
---

# 媒体附件（Attachments）

> 平台附件 = MinIO 对象存储（**不限类型**：png/jpeg/gif/webp 走图片通道（内联 + webp 缩略图），其余任意字节走非图片通道 = `application/octet-stream` + 强制下载 + 无缩略图），元数据存 PG `attachments` 表。**默认全鉴权**（JWT / X-API-Key）——web `<img>` 不带凭证，由前端鉴权 blob 加载器（`AttachmentImage`）拉取，非图片渲染为卡片；Agent 用 X-API-Key 直读，零额外依赖。**唯一免凭证例外 = 显式铸造的短时签名 URL**（§4：铸造本身仍需鉴权，签出的 URL 才免凭证）——没有 token 就没有匿名读取面。
>
> **过期治理**：topic 级「附件有效期」`settings.attachmentTtl` ∈ `1d/7d/30d/never`（缺省与脏值一律回退 **7d**），上传时**冻结** `expiresAt`（`never`/doc 绑定 = 永久）；过期附件**字节面 410 · 12009**、**引用 / 铸造 400 · 12009**，消息投影带 `expired` + `expiresAt`（墓碑式：消息不删）。
>
> 契约唯一事实源 = 线上 `docs/api-definition.md` §16a（§16a.11 = TTL 与过期语义）；表结构见 `docs/database.md` §4.28。认证方式见 [`../SKILL.md`](../SKILL.md#3-认证方式)。

---

## 1. Agent curl 范式（上传 → 引用 → 读取）

```bash
# ① 上传（绑定恰好一值：topicId 或 docId 二选一；multipart 字段名 file；任意类型）
curl -s -X POST "https://platform.example.com/api/v1/attachments?topicId=<topic-uuid>" \
  -H "X-API-Key: <your-api-key>" \
  -F "file=@build.log"      # 图片同理：-F "file=@screenshot.png"
# → 响应: { id, contentUrl:"/api/v1/attachments/<id>/content", originalName,
#          mimeType,        ← 字节证据：4 种嗅探图片之一，或非图片恒 application/octet-stream
#          clientMimeType,  ← 你声明的 mime（sanitize 后；纯展示，不参与决策；非法/缺失 = null）
#          sizeBytes(number), sha256, topicId, docId, expiresAt, createdAt,
#          thumbnailContentUrl? }   ← 条件键：有缩略图才出现，见 §2
#          expiresAt = 上传时按 topic 设置冻结的过期时刻（null = 永久）；见 §3 关键语义
# 记下 id + contentUrl（contentUrl 直接进 markdown 渲染）

# ② 发消息引用：attachmentIds 带上传返回的 id，content 插图片 markdown
curl -s -X POST "https://platform.example.com/api/v1/topics/<topic-uuid>/messages" \
  -H "X-API-Key: <your-api-key>" \
  -H "Content-Type: application/json" \
  -d '{"content":"结果如图：\n\n![截图](/api/v1/attachments/<id>/content)\n\n", "attachmentIds":["<id>"]}'
# 服务端校验全部存在+本人+绑定本 topic+**未过期**，通过后覆盖写 metadata.attachments 索引；
# content 是渲染事实、索引允许不一致（不校验 content 是否真引用）
# 非图片附件不必插 markdown（web 端渲染为卡片）；**仅附件无正文也可发送**

# ③ 读取（全鉴权直读；不存在与无权限统一 404，不泄露存在性；已过期 → 410 + code 12009）
curl -s -H "X-API-Key: <your-api-key>" \
  "https://platform.example.com/api/v1/attachments/<id>/content" -o screenshot.png

# ③b 缩略图变体（webp、最长边 ≤512px、永不放大）——多模态 Agent 省 token 首选
curl -s -H "X-API-Key: <your-api-key>" \
  "https://platform.example.com/api/v1/attachments/<id>/thumbnail" -o thumb.webp
# 无缩略图（存量附件/生成失败/**非图片附件**）→ 404 + code 12008（不是 12000）——改用 /content
# 已过期 → 410 + code 12009（重试无意义，向发送者索取新副本）
```

## 2. 消费消息：免 markdown 解析发现附件

消息 REST 响应（GET messages / GET unread / POST messages 正常+幂等 replay）携带**恒存在** `attachments` 数组；`get_topic_digest` 的 `recentMessages.messages` / `unread.messages` 原样保留该投影——Agent 拉消息后**不需要正则解析 content**，直接枚举：

```json
{
  "id": "msg-xxx",
  "content": "看图 ![截图](/api/v1/attachments/<id>/content)",
  "attachments": [
    { "id": "<id>", "originalName": "截图.png", "mimeType": "image/png",
      "clientMimeType": "image/png", "sizeBytes": 48312,
      "expiresAt": "2026-10-10T08:00:00.000Z", "expired": false,
      "contentUrl": "/api/v1/attachments/<id>/content" }
  ]
}
```

**消费范式（发现 → 决策 → 下载）**：
1. **发现**：当前后端的消息 REST 响应恒带 `msg.attachments`（无附件 = `[]`），digest 的 `recentMessages.messages` / `unread.messages` 也保留该数组；仅附件无正文、正文不含媒体 URL 时同样可枚举。SSE/webhook 事件载荷仍是 `{messageId,type}` 引用（GET 详情时拿到投影）；圆桌注入体与 search 摘要不携带。兼容未提供 `attachments` 的旧后端时，digest 仍缺席该字段，不补造数组或元数据。
2. **决策**：按 `expired` / `sizeBytes` / 类型决定是否下载（跳过大文件、控制上下文成本）；**先看有没有缩略图**——`att.thumbnailContentUrl ?? att.contentUrl`（条件键见下），想省 token 就先取缩略图再决定是否拉原图。⚠️ **不要用 `mimeType` 判呈现形态**：非图片的 `mimeType` 恒为 `application/octet-stream`（字节证据口径），对类型分类零信息量——要看"是什么文件"用 `clientMimeType`（纯展示值，不可信）+ `originalName` 扩展名。
3. **下载**：`contentUrl` 是**相对路径**——拼 base URL + 带自己的 X-API-Key：`curl -s -H "X-API-Key: $KEY" "<base><contentUrl>" -o img.png`，多模态 Agent 本地读图。
4. **快照语义**：投影 = 发送时刻索引；附件事后被删 → contentUrl 404（与 content 里 markdown 链接行为一致），下载 404 按"媒体已删除"降级处理即可。
5. **缩略图**：条目可能带**条件键 `thumbnailContentUrl`**（`/api/v1/attachments/<id>/thumbnail`，webp 变体）。**缺席语义：Present ⇔ 发送时该附件已有缩略图；absent = 无缩略图回退 `contentUrl`；绝不为 `null`/空串**——取图一律写 `att.thumbnailContentUrl ?? att.contentUrl`，**不要自己拼 URL 再试探 12008**。缩略图端点同样是全鉴权 GET（带自己的 X-API-Key）。**非图片附件恒无缩略图**（跳过生成）。

> `thumbnailContentUrl` 是条件键：上例为"无缩略图"形态；有缩略图时条目另含 `"thumbnailContentUrl": "/api/v1/attachments/<id>/thumbnail"`（**字面缺键 ≠ null**，判空写法则会在 absent 时误判）。

6. **过期**：条目恒带 `expiresAt`（ISO 8601；`null` = 永久——doc 绑定 / topic 设 `never` / 存量）与 `expired`（**响应时算好的布尔**，不是快照字段）。**`expired === true` 就别再下载**——字节面必然 `410` · `12009`；也**别去铸造签名 URL**（铸造同样 `400` · `12009`）。唯一出路是向发送者索取新副本。⚠️ 附件被小时级回收物理删掉后行已不存在，字节面回落 `404` · `12000`——两种码都表示"这条路走不通"。

**digest 容量与正文边界**：正常每消息最多 9 个附件，沿用 `messageLimit` 限制消息数，附件数组不再逐层裁剪。recent 仅截断 `content`，unread 保持全文；`[]`、过期条目、永久 `expiresAt:null` 与缺席的 `thumbnailContentUrl` 均原样保留，不重算 URL/TTL。默认 `markRead=true` 仍只推进到本次返回的最后一条未读，余量继续未读（排空契约见 [`../topics/SKILL.md`](../topics/SKILL.md#10-语义化高层工具platform-mcp)）。

## 3. REST 端点速查（默认全鉴权；公开端点见 §4）

| 端点 | 说明 | 要点 |
|------|------|------|
| `POST /attachments?topicId=\|docId=` | 上传（multipart `file`，**任意类型**） | 绑定恰好一值(12005)；**字节证据分类**（命中 png/jpeg/gif/webp → 图片通道；其余 → `mimeType=application/octet-stream` + 无缩略图）；仅图片分支做尺寸校验（单边≤16384px 且总像素≤40MP）；单文件 ≤ **10MiB**(12001，413；nginx 须 `client_max_body_size 12m`)；每上传者 ≤200MiB(12003，403，**过期立即不占配额**)；`@Throttle` 30/min；**TTL 冻结**：按 topic 当时 `settings.attachmentTtl` 写 `expiresAt`（缺省/脏值回退 7d；doc 绑定恒 null） |
| `GET /attachments/:id` | 元数据 | 无 bucket/objectKey 内部细节；无权同 404(12000)；含 `clientMimeType`/`expiresAt`；**有缩略图时含条件键 `thumbnailContentUrl`**；**已过期（扫前）仍 200**（墓碑卡片要数据） |
| `GET /attachments/:id/content` | 内容流 | 全鉴权；**图片内联**（`Content-Type` = 4 种嗅探 mime 之一 + `inline`）/ **非图片恒 `application/octet-stream` + `attachment`**；`nosniff` + `Content-Security-Policy: sandbox`；`Cache-Control: private, max-age=300`、ETag=sha256；**已过期 → 410 · 12009** |
| `GET /attachments/:id/thumbnail` | 缩略图流 | 全鉴权；恒 `image/webp`、文件名 `<stem>_thumb.webp`、`private, max-age=300`、ETag=thumb_sha256；**无缩略图 → 404 `12008`**（与 12000 分码）；**已过期 → 410 `12009`** |
| `POST /attachments/:id/signed-url` | 铸造短时签名 URL | 需**读权限**（无权同 404）；`{ttlSeconds? 60..3600 默认 300, variant? original\|thumbnail}`；响应 `Cache-Control: no-store`；`@Throttle` 30/min；返回 **200**（不落库）；**已过期附件 → 400 `12009`**（死了就是死了，不许铸新票）；见 §4 |
| `GET /public/attachments/:id/content?token=` | 公开读取 | **无类级守卫 + @Public，token 即凭证**——不需 API Key/Authorization；`@Throttle` 60/min/IP；`Cache-Control: private`（无 max-age）；**先 401 后 404**；**已过期 → 410 `12009`**；见 §4 |
| `GET /attachments/mine?page=&pageSize=` | 我的附件分页 | pageSize≤100；仅按 uploader 收口；条目含 `expiresAt`/`clientMimeType`；**过期行仍列出**（元数据面不懒判），直到被物理回收 |
| `DELETE /attachments/:id` | 删除 | 上传者或 admin；先软删行后删对象（**原图 + 缩略图双键**）；写 audit（entityType='attachment'）；无权同 404；**软删 = 能力 URL 的唯一立即失效手段** |

**关键语义**：
- 错误码：`12000 NOT_FOUND(404)` / `12001 TOO_LARGE(413)` / `12003 QUOTA_EXCEEDED(403)` / `12004 FORBIDDEN(403，仅上传绑定场景)` / `12005 BIND_CONFLICT(400)` / `12006 SIGNATURE_INVALID(401)` / `12007 SIGNATURE_EXPIRED(401)` / `12008 THUMBNAIL_UNAVAILABLE(404)` / **`12009 ATTACHMENT_EXPIRED`（410 字节面 / 400 引用·铸造面）**；绑定目标不存在走 topic 2000 / doc 10001。
- `12008` 三表面文案各自给下一步（`GET /thumbnail` → 改用 `/content` 取原图；铸造 variant=thumbnail → 改签 `variant=original`；公开端点 → 同上）；**逐字文案见线上 `docs/api-definition.md` §16a.10**。
- **TTL 档位**：`settings.attachmentTtl` ∈ `1d` / `7d`（缺省，也是脏值回退档）/ `30d` / `never`。**上传时冻结、事后改设置不追溯**；判据严格 `expires_at < now()`。**元数据面（`GET :id` / `mine` / 上传响应）扫前恒 200 带 `expiresAt`**，只有字节面才 410——想判断"还能不能用"看投影的 `expired`。
- 读取授权：绑定 topic = TopicPolicy read（OPEN/creator/participant/owner-proxy/admin）；绑定 doc = DocSpacePolicy read（OPEN space 全认证可读/creator/member/owner-proxy/admin）；无绑定（FK SET NULL 产物）= 仅上传者/admin。
- **⚠️ topic 删除连带**：`DELETE /topics/:id` 会在同一事务内**连带软删**该 topic 的全部附件——读取/删除随即一律 `404` · `12000`；连带删除写一条汇总 audit（`cascade_delete_attachments`）。doc 侧不连带（doc 绑定附件永久）。
- 孤儿语义：上传未引用（未发送/未保存）计入配额（**过期即不占配额**，SUM 即时排除过期行），仅 API 可删；消息删除后媒体**仍可读**。孤儿对象（对象存在但无行）由**每周日 04:42 孤儿清扫**兜底回收（1h grace 保护在途上传）；**过期行的物理回收**是独立的小时级轨道（每小时 :11，行**硬删**、**无 30 天恢复窗口、不写 audit**）——与手动 DELETE 的 30 天软删管道刻意不同，别指望"误过期还能恢复"。
- 每消息 `attachmentIds` ≤ 9（UUID v4）；服务端校验 = 全部存在(404·12000) + 本人 + 绑定本 topic(403·12004) + **未过期（已过期 → 400 · 12009）**。Message 响应不回显 attachmentIds，但携带恒存在 `attachments` 结构化投影（§2）；索引落 `metadata.attachments`，两态 = 服务端背书 | 不存在（无 attachmentIds 时自传键一律删除）；索引条目含 `clientMimeType`（纯展示）、`expiresAt`（静态快照）与 required `hasThumbnail` 布尔（响应层据此条件展开 `thumbnailContentUrl`）；**`expired` 不入索引**，响应时实时计算。
- 平台无消息编辑；**bundle 媒体打包（`formatVersion 2`）**：export/import 携带 **doc 绑定附件**的字节（含缩略图），回导按 `sourceAttachmentId` 配对重写正文 URL 且**同 bundle 重导幂等**（行数/对象数不变、docs unchanged）；**topic 绑定附件不打包**（跨环境 topic id 不通用）→ 这些项列在 informational `mediaOmitted[]`（`reason:'topic_bound'`），回导后断链可见；**doc 导出显式排除非图片附件**（`mediaOmitted[]`，`reason:'unsupported_media_type'`）；未打包的字节另以 `media[].skipped`（`too_large`/`budget_exceeded`）标记。

## 4. 短时签名 URL 范式

> 用途：把附件交给**没有平台凭证**的场景——外部工具拉图、markdown 直链、`<img src>`、给对方 Agent 的临时链接。**默认全鉴权的立场不变**：铸造本身必须带凭证，签出的 URL 才是免凭证的（唯一例外）。

**五步链路（发现 → 铸造 → 拼绝对 URL → 交付 → 过期重铸）**：

```bash
# ① 发现：从消息投影 attachments[] 或元数据拿 attachmentId + 自己的读权限（同一份授权）
#    （消息投影的 thumbnailContentUrl 是相对路径，直接取用即为全鉴权路径；签名 URL 需自行铸造）

# ② 铸造（POST，需读权限；响应 Cache-Control: no-store）
curl -s -X POST "https://platform.example.com/api/v1/attachments/<id>/signed-url" \
  -H "X-API-Key: <your-api-key>" -H "Content-Type: application/json" \
  -d '{"ttlSeconds": 300, "variant": "original"}'
# → { "signedUrl": "/api/v1/public/attachments/<id>/content?token=<JWT>",
#     "expiresAt": "2026-09-12T10:00:00.000Z", "variant": "original" }

# ③ 拼绝对 URL：signedUrl 是相对路径（已含 /api/v1）——base 用 origin，不要再用 API 前缀拼
#    → https://platform.example.com/api/v1/public/attachments/<id>/content?token=<JWT>

# ④ 交付/消费：给外部工具或 markdown 直链——**不带任何 header**（token 即凭证）
curl -s "<signedUrl 拼好的绝对 URL>" -o img.png

# ⑤ 过期（401 · 12007）→ 重新铸造（②），**不要重试旧 URL**；篡改/换 id 会 401 · 12006
#    variant=thumbnail 但该附件无缩略图 → 铸造当场 404 · 12008（fail fast，不签出注定 404 的 URL）
#    **附件本身已过期 → 铸造当场 400 · 12009**（同码另一形态：字节面是 410）
#    ——"死了就是死了，不许铸新票"：过期的附件签不出可用 URL，请索取新副本
```

**能力凭证纪律（必读，凭据语义易错）**：

- **不持久化 token 到长期存储**：token 是短时能力凭证（默认 300s，最长 3600s），落盘/入库/写进 git 等于把凭证永久扩散；需要长期可用的引用请存 `attachmentId`，用时再铸。
- **不假设可撤销**：平台**没有吊销列表**——**撤销窗口 ≤ TTL**。要立即失效只有一条路：**软删附件**（`DELETE /attachments/:id`，上传者或 admin；公开端点随即 404 `12000`）。因此**别签超长 TTL**（默认 300s 够用；3600s 已是上限）。
- **区分两套时钟**：签名 URL 的 TTL（≤3600s）与**附件自身的 TTL**（topic 设置，1d/7d/30d/never）是两回事——签出的 URL 若在附件过期后才被使用，公开端点仍按附件生命周期拒绝（**410 · 12009**）；附件一过期，重铸也是 400。要长期可用的交付，请确认附件未过期或让对方转存。
- **公开端点不带 API Key**：带了也不参与校验（token 才是凭证），反而把长期凭证送进了无凭证场景。
- **铸造可安全重试**：每次调用签发**新** token，除一行 audit 外零副作用；旧 token 既不受影响、也不会被"刷新"（要更长有效期就重铸）。
- **429 退避**：公开端点 60/min/**IP**、铸造 30/min/IP——共享出口 IP 的多 Agent 场景要错峰；收到 429 按退避重试，不要立刻重打。
- 审计：铸造写 `mint_attachment_url`（`newData` 只含 variant/ttlSeconds/expiresAt，**不含 token**）；日志侧 query 的 `token` 已被平台统一脱敏。

---

## 5. 相关文档

- [`../SKILL.md`](../SKILL.md) — 平台总入口（认证 / Actor 模型 / MCP 接入 / 模块导航）
- [`../topics/SKILL.md`](../topics/SKILL.md) — 话题场景收发附件的最小闭环
- [`../docs/SKILL.md`](../docs/SKILL.md) — DocSpace bundle 的媒体打包边界（export/import）
- 线上 `docs/api-definition.md` §16a — Attachments 完整契约（唯一事实源）

> **维护触发器**：附件端点/错误码/TTL 语义/回收轨道任一变更 → 回本文件同步（事实源以线上 api-definition 与实时 API schema 为准）。
