/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - Notifications 模块的**事件编排器**：订阅统一事件层的 `event.created`，把平台内事件翻译成
 *     "该不该给 Owner 发一条外部 IM"，并完成 节流 → 渲染 → 投递 → 终态落库 的全链路。
 *     本文件是"哪些事件值得打扰人类"的**唯一判据集合**（类别映射 + 完工跃迁判据）。
 *
 * [代码职责]
 *   - `@OnEvent('event.created', { async: true })` 订阅点（M1 圆桌 / 本模块共用同一挂点）
 *   - **六段管线（顺序即语义；编号与 `handleEvent()` 内注释一一对应）**：
 *     ① **总开关**：`enabled=false` ⇒ 不读库、不打日志、直接 return（真"一切静默"）
 *     ⓪ **写时失效钩子**：`resourceType=TOPIC ∧ eventType ∈ {AGENT_JOINED, AGENT_LEFT}`
 *        ⇒ 清 topic 参与缓存。**必须在 ② 之前**（它们不是通知类别，放后面永远走不到）
 *     ② **类别映射** `resolveNotificationCategory(event)`：eventType + payload → 细粒度 token
 *        （§5 表；含完工跃迁判据、`rechunked` 短路、`system` 消息排除）→ `NOTIFY_CATEGORIES` 过滤
 *     ③ **收件人解析** `resolveRecipients(event, category)`：**per-candidate 双层判据**
 *        （安全层 read ∧ 注意力层成员/归属）+ per-candidate 自回声 + 类别偏好；
 *        零候选 ⇒ 每类别一行 INFO（与"路由坏了"可分辨）
 *     ④ **L1 节流**：**逐收件人**的 TTL（`task:<taskId>:<userId>` / `topic:<topicId>:<userId>` /
 *        `doc:<docId>:<userId>`——**不含类别**、**含 userId**，见 `l1Key` 注释的三处取舍）；
 *        命中跳过打 INFO、**不落库**；检查前置、标记后置
 *     ⑤ **逐收件人**：check → 渲染（标题 + 正文 + 深链，**宽度分层**见 [关键不变量]）→ 占 L1 窗口
 *        → **部署级出境总闸** → L2 per-user 窗口（超额合并为一条摘要）→ 投递 → 终态落库
 *   - **收件人路由的唯一事实源 = `resolveRecipients`**（一期那个"部署级单 Owner"的接替者）
 *   - **对直发链路开放的复用面**（`NotifyDirectService` 是唯一消费者）：`resolveDirectTarget()`
 *     （直发的收件人解析：`ownerId` → 该用户的主投递渠道）、`reserveL2ForDirect()`（直发占额但
 *     永不合并）、`sendThroughProvider()`（端口 never-throw 的运行时兜底）——都刻意**只暴露判定
 *     与动作，不暴露内部集合**（集合一旦外泄，谁都能 `.add()` 一个 id 从而静默改掉判据）。
 *     ⚠️ **一期那两条（`isOwnerActor()` / `resolveRecipient()`）已随批 2 棒 B 整体删除**：
 *     直发的收件人不再是"部署级单 Owner"，而是"**调用 agent 的人类 owner**"。
 *     另加两条**写时失效的动作面**（都是幂等的纯内存删键，写路径无条件调用即可）：
 *     `invalidateUser(userId)`——清该用户的**缓存 + 在途重建**（5 个调用点：渠道 upsert /
 *     渠道解绑 / 类别偏好 PUT / 类别偏好 DELETE / 渠道测试），`invalidateTopic(topicId)`——
 *     清话题参与集合（1 个调用点：`AGENT_JOINED`/`AGENT_LEFT` 事件钩子）。
 *   - **系统告警端口（路线 B，2026-10-23）**：`sendSystemAlert()`——memory 引擎健康 tracker 的
 *     唯一投递出口。收件人 = **admin 账号绑定的渠道**（≠ `NOTIFY_OWNER_USERNAMES` 播种账号）；
 *     量控**按臂分桶**、不做应用层重投（at-least-once）；`onApplicationBootstrap` 打一行启动自检。
 *     ⚠️ `system_alert` **不进 `NOTIFY_CATEGORIES`**（运维类别、用户不可静音）。
 *   - 启动：`onModuleInit` 把 `NOTIFY_OWNER_USERNAMES` 解析成 actorId 缓存（未命中逐个 warning +
 *     一行 INFO `owner actors resolved n/N`）→ D4 播种 → 启动诊断 → L2 兜底扫描
 *
 * [权威文档]
 *   - 一期: plan `nightcrawler-black-hawk-devil-dinosaur.md` §3 架构（管线 + fail-open 代价）/
 *     §5 类别→事件映射表 / §2 现状关键事实（fire-and-forget rejection 致命性）
 *   - **二期（多用户路由）**: 线上 `docs/api-definition.md` §20.3（双层判据 / 逐类别判据 /
 *     deliveryEligible 谓词 / 自回声例外）/ §20 头（配置分层）；播种语义见 skill
 *     `notifications/feishu-setup.md` §4
 *
 * [关键不变量]
 *   - **每个 `void` promise 必须自带 `.catch`**（本文件最硬的一条）：Nest 的 `@OnEvent` loader
 *     只对**回调本身** try/catch（`suppressErrors ?? true` 默认吞），`{async:true}` 走 setImmediate
 *     ——回调内 fire-and-forget 的 promise rejection **不受任何包装保护**；本仓无全局
 *     `unhandledRejection` 处理器，Node 22 默认 throw ⇒ **进程死**（plan §2 探针实证）。
 *     故本文件一律经 `fireAndForget()` 派发，禁止裸写 `void somePromise()`。
 *   - **禁读 ALS（AsyncLocalStorage）**：`{async:true}` 用 setImmediate 派发，会**继承写入方的
 *     请求上下文**——在监听器里读 ALS 拿到的是"触发事件的那个请求"的身份，不是本模块的身份。
 *     一切身份取自 `event.actorId`（事件行自身携带的事实）。
 *   - **handler 全包 try/catch**：本 handler 的**任何**失败都只记日志。⚠️ **订正（notifications
 *     一期 S7）**：旧立论"listener 抛错同步冒泡污染 `EventService.create()` 热路径"已被证伪
 *     ——Nest 的 @OnEvent loader 对回调本身就是 try/catch（`suppressErrors` 默认吞）+ `{async:true}`
 *     走 setImmediate，冒泡不出 `emit()`。全包 try/catch 仍是良好卫生（await 链上的异常自吞只记
 *     日志），但**崩进程的真实风险不在这里**（见上一条 `void` promise 硬规则）。
 *   - **双层判据 = 安全层 ∧ 注意力层**（Notifications 二期批 2，plan §D3）：
 *     **安全层**（`readableUserIds`，来自 `AccessQueryService` 的实时 profile）防**越权**——把私有
 *     看板/空间的标题推到无权读的人手机上；**注意力层**（成员 / creator∈{我,我的 agents} / 被指派）
 *     防**噪音**——open 资源全网可见，但只有"这件事跟我有关"的人才该被打扰。
 *     ⚠️ **两层都过才推，注意力层命中不豁免安全层**（被移出私有看板的 assignee 不再有权读 ⇒ 不推）。
 *     ⚠️ **禁止在本文件自建一份近似读权限推断**（那是越权外发的唯一入口）；判据只来自
 *     `AccessQueryService`（单源）与 topic 参与集合。
 *   - **快照只存用户自改配置，`role` 与权限集合永不进快照**（`NotifyUserSnapshot`）：
 *     `{channels（仅 deliveryEligible 行）, prefs, agentIds}` 三者都是用户可自改的配置，
 *     失效路径 = **显式失效钩子 + TTL 兜底**。而权限（谁能读哪个资源）与 role **每个事件定向
 *     查询**才有零陈旧——把 `readableUserIds` 或 role 放进 60s 快照，就等于给"admin 被降权"
 *     "成员被移出"开一条最长 60s 的越权旁路。
 *   - **single-flight 的在途表：清位要判"是不是我这一份"，落地写缓存也要判**。两条缺一不可：
 *     ① **必须 finally 清位**（含 rejected promise）：留在表里的失败 promise 会把该用户
 *        **永久**钉在失败结果上（后续事件不再重建 ⇒ "一次 DB 抖动 = 该用户从此静默"）；
 *     ② **落地前必须重判 `snapshotInFlight.get(userId) === pending`**（MAJOR-1，2026-10-13
 *        复核）：一份被 `invalidateUser` 摘过牌的重建读的是**写前**的事实，无条件写缓存会把
 *        陈旧值留 60-70s ⇒ "解绑 = 通知立即停止"被绕开一分钟（详见 `invalidateUser` 的注释）。
 *     先例：`feishu.notify-provider.ts` 的 in-flight tenant-token 模式（同款 finally 清位）。
 *   - **失效钩子必须早于类别过滤**：订阅的 `AGENT_JOINED` / `AGENT_LEFT` **不是通知类别**
 *     （`resolveNotificationCategory` 对它们返回 null），放在类别过滤之后就永远走不到；
 *     而 topic 参与集合变了却不清缓存 ⇒ "刚被移出话题的人"在 TTL 内继续收到该话题通知。
 *     **不看 `actorType`**：人类参与者发的是同一对事件（topic.service.ts 三处 emit 共用）。
 *   - **`seedOwnerActorIds`（原 `ownerActorIds`）只服务 D4 播种**：它就是"`NOTIFY_OWNER_USERNAMES`
 *     解析出的 actor 集合"，批 2 棒 B 收敛后**唯一消费方 = `seedFromEnv`**（直发链路的
 *     `isOwnerActor` 已删除，事件管线的自回声早已改 per-candidate）。一期的
 *     "owner 解析数为 0 ⇒ 整个 topic 类别跳过"对策随之退役——多用户模型下"谁参与"由
 *     per-candidate 判据回答，不需要一份全局名单。
 *   - **缓存残留（显式接受，写进 plan §5）**：agent 被删（owner 关系变化）≤60s、topic 加入
 *     ≤60s 由 TTL 自愈；board 成员变更**不接事件**（本编排器没有任何 board 成员缓存可失效
 *     ——权限每事件定向查询，接了就是一条永不生效的死线）。
 *     ⚠️ **in-flight 竞争（MAJOR-1 之后剩下的那一半）**：写路径的 DB 提交与内存摘牌之间没有
 *     可以跨越的事务边界 ⇒ **正在处理的那一次路由**可能仍读到写前的事实（一次事件的窗口，
 *     不是 60s）。`invalidateUser` 摘牌 + 落地守卫关掉的是"陈旧值被缓存 60-70s"那一半；
 *     下一次 `loadUserSnapshot` 一定重建、拿新事实。要消掉这一半只能把缓存与写路径放进同一个
 *     事务/分布式失效通道——与"单实例内存缓存"的前提冲突，**显式接受**。
 *   - **单实例部署是内存态缓存的前提**（同 L1/L2）：进程内快照 / topic 参与 / 节流窗口
 *     每实例独立、重启清零、多副本各自一份（`docker-compose.yml` 无 replicas）。扩容后
 *     陈旧窗口 = TTL、重建放大 = 副本数；**这是缓存不是配额**（无共享存储）。
 *     ⚠️ L1 / L2 的键在批 2 棒 B 之后都**含 `userId`**（见下两条），但"单实例"这个前提没变：
 *     多副本下同一个人会在 N 份内存里各有一份窗口 ⇒ 实际额度 × 副本数。
 *   - **性能承诺（分层可证伪）**：事件处理的路由查询数与**候选人数 N 无关**——
 *     `topic` 缓存命中 0 条（未命中 1 条）、`task_*` = 候选 1 + task 行 1 + 看板剖面 1 次调用；
 *     `doc_*` = 候选 1 + doc 行 1 + 空间剖面 1 次调用。**冷路径** = 候选 1 **+ 4N**（每用户
 *     快照四条：渠道绑定 1 / 用户偏好 **2**（`User.actor` eager 关系多发一条）/ 我的 agent 1），
 *     由 single-flight 去重。**候选集合本身一条查询**
 *     （`deliveryEligibleWhere()` + 关系上的 `actors.deleted_at IS NULL`）。
 *     ⚠️ **L2 摘要的 flush 不在"每事件固定条数"这条承诺内**：它是 `setInterval` 兜底 + 超额
 *     时的即时 flush，**每条 flush 会在快照过期时补一次快照重建**（≤4 条查询/人）——
 *     与事件数无关，与"窗口结束的收件人数"相关。
 *   - **`direct` 不经 `resolveRecipients`**（返回空数组）：直发的收件人 = **调用 agent 的
 *     `ownerId`**，路由在直发链路里（`resolveDirectTarget()`：取该用户的主投递渠道；无
 *     `deliveryEligible` 绑定 ⇒ `recipient_not_bound`）。且 `direct` **不适用"我的 agent"
 *     自回声泛化**——直发唯一的自回声是"**人类** JWT 调用者就是收件人本人"；否则 agent 通过
 *     直发端点给它的人类 owner 发消息会被"这是我自己 agent 触发的"吞掉（调用方拿到 200
 *     却没人收到）。
 *   - **完工判据 = 状态跃迁，不是"当前状态"**：`toStatus ∈ {done, blocked} && fromStatus !== toStatus`。
 *     载荷缺跃迁信息（如 `patchDescription` 的 `{action:'updated', fieldName:'description'}`）时
 *     两值都是 undefined ⇒ 判据为假 ⇒ 落 `task_updated`——**改一个已完成任务的描述不会推"完工"**
 *     （plan §11 的"完工误报"对策）。
 *   - **L1 是"检查前置、标记后置"**（抄 hint-dedup 纪律）：先查表过滤，**渲染成功后再标记**
 *     ——渲染失败（资源已被删的幻影事件）不该占用窗口。⚠️ 两段式**不是原子的**：并发事件可能
 *     都通过检查 ⇒ 偶发多投一条；这是有意接受的代价（手机场景无害，兜底是 L2）。
 *     ⚠️ 批 2 棒 B 起渲染在**收件人循环里**、窗口也是**逐收件人**的（见下一条）。
 *   - **L1 键 = `<资源分量>:<userId>`**（`task:<taskId>:<uid>` / `topic:<topicId>:<uid>` /
 *     `doc:<docId>:<uid>`）：
 *     ① 资源分量**按类别取**——`NEW_MESSAGE` 的 `event.resourceId` 是**消息 id**，用它会让
 *     topic 的键恒唯一、永不命中；② **不含类别**——plan §5 的字面语义是 "per-task 300s"，
 *     按类别分段会让 `PATCH {assigneeId}` 双发；③ **含 userId**（批 2 棒 B 的泛化，plan §D3）
 *     ——"别刷屏"是对**每个人**说的，共享一个窗口会让"先看到的人"把"后面那批人"的通知压掉
 *     （同一个资源在一场批量事件里打给 10 个人 ⇒ 只有 1 个人收到）。详见 `l1Key` 注释。
 *     ⚠️ **`L1_MAX_ENTRIES` 被用户数稀释**：加了 userId 分量后，一万条容量 ≈
 *     "100 用户 × 100 资源"（或"1000 用户 × 10 资源"）——它仍是**防爆**上限而不是精确预算
 *     （见其字段注释：单条 ≈ 百字节）。
 *   - **L2 窗口键 = `userId`**，投递地址 = 该用户快照的 `channels[0].recipientAddress`——批 2
 *     棒 B 的点名改造三处：`consumeL2` / `flushDigestIfNeeded` / `reserveL2ForDirect`，
 *     外加 `L2Window` 携带 `recipientUserId`（窗口的账要能自己说清"这是谁的"）。
 *     **`direct` 不经 L1**（plan §5）：直发没有资源分量，
 *     强行加只会让不同人的直发互相串行。
 *   - **flush 摘要前必须重判 `deliveryEligible`**：缓冲（记账）与 flush（投递）之间用户可能
 *     已经解绑 / 静音，而 flush 走的是定时器与超额两条**与"当前绑定"无关**的路径——
 *     不重判就等于给"**解绑 = 通知立即停止**"留一条时间缝（plan §D3 点名的 V6 风险）。
 *     重判不通过 ⇒ **丢弃 + INFO**（`digest dropped [recipient_unbound]`），不投递。
 *   - **出境总闸先于 per-user L2 生效**（N ≥ 5 个活跃绑定用户时，plan §D3/§5 的关系声明）：
 *     总闸是**部署级**的一个窗口（挡"整个部署的外部配额被打穿"），per-user L2 是"某个人的手机
 *     别被刷爆"。当 `platformRateLimit < perUserL2 × enabledBindings` 时**总闸先丢**，
 *     per-user 摘要机制被架空（摘要正是总闸丢弃的补偿信号，此时它自己也只是总闸的**豁免**放行
 *     对象）。这条关系由启动自洽 WARN 显式报出；**别指望调大 L2 去解决总闸**（两个不同量纲）。
 *   - **总闸丢弃要"看得见"**：超额时被丢的候选**计入该用户 L2 的 suppressed 分布**（于是它会以
 *     "另有 N 条（类别分布）"的形式出现在那个人的摘要里）+ 一条带 `eventId` 的 INFO +
 *     **按窗口限频的 WARN（带累计条数）**。三者缺一：少计 suppressed ⇒ 摘要撒谎（少了条目）；
 *     少 INFO ⇒ 逐条对账断链；不限频 WARN ⇒ 一个刷屏窗口打出几千行 WARN。
 *   - **摘要自身豁免总闸**（plan §m-9）：摘要**不经过 `consumePlatformGate()`**——否则总闸一
 *     触发，被丢掉的候选永远等不到"另有 N 条"的补偿信号，用户与运维都失去"发生过丢弃"的证据。
 *   - **L2 只压"事件链路"，摘要自身永不合并**（plan §11）：摘要 `category='digest'`、
 *     **不占额度**（不经过 `consumeL2`）、**窗口内最多 1 条**（`summarySent` 闸）。
 *   - **缓冲只存计数**：L2 缓冲里只有 `Map<category, count>`，**不存通知正文**——积压 10 分钟
 *     的几百条通知不占内存，摘要只报"另有 N 条（类别分布）"。
 *   - **`NOTIFY_ENABLED=false` ⇒ 本文件不读库、不打日志、直接 return**（真"一切静默"）。
 *   - **出境面只在 `RenderedNotification`**：本文件是唯一构造它的地方（`render()`），
 *     加字段 = 扩大出境面，必须同 commit 更新 config 的 `NOTIFY_EGRESS_FIELDS`（单源）。
 *     **v2 起出境面含归属名**：看板名 / 空间名 / actor 显示名（见 config 声明的对应三行）。
 *   - **归属信息一律"降级不丢弃"**（v2）：看板名 / 空间名 / 显示名取不到即兜底 `?`，
 *     **绝不 return null**。理由：归属是旁挂信息，而 return null 的语义是"丢弃这条通知"——
 *     把"boardId 缺键"升级成"Owner 完全看不到这件事"是拿小问题换大问题。
 *   - **正文宽度分四层**（各自服务不同语义，别互相借用）：
 *     ① **topic = `NOTIFICATION_SUMMARY_MAX_LENGTH`（100）**：正文是消息 excerpt，**预览语义**
 *        ——够看出"有人在你参与的话题里说了什么"即可，点进去读全文是常态，短是刻意；
 *     ② **task / doc = `NOTIFICATION_BODY_MAX_LENGTH`（200）**：正文是**消息本体**（归属信息 +
 *        文档标题），截掉尾巴等于这条通知失去存在意义 ⇒ **完整性优先于紧凑**；
 *     ③ **direct = agent 自填 ≤2000**（不在本文件，见 notify-direct.service.ts）；
 *     ④ **system_alert = `SYSTEM_ALERT_BODY_MAX_LENGTH`（1000）**：正文是诊断 + 「处置：」/
 *        「恢复：」指引，**复用 200 会切掉那两行**——而它们正是告警唯一可执行的出口。
 *     四者都**不是数据库约束**（`notification_deliveries.body` 是 `text`），改宽度 = 改产品语义，
 *     必须同 commit 同步 config 的 `NOTIFY_EGRESS_FIELDS` 与 `.env.example`。
 *
 * [关联代码]
 *   - ../../common/services/access-query.service.ts — **双层判据的判据源**：`resolveBoardAccess` /
 *     `resolveSpaceAccess`（`{visibility, creatorActorId, memberUserIds, readableUserIds}`；
 *     签名只收 userIds，内部实时读 role + owner-proxy）。**禁止在本文件自建第二份读权限推断**
 *   - ../../common/services/actor-profile.service.ts — **v2 归属**：操作者 / 发言人显示名的
 *     唯一解析入口（`resolveProfiles`，由 `@Global()` 的 CommonModule 提供，本模块不 import）
 *   - ../../database/entities/user-notification-channel.entity.ts — 候选集合与快照的**数据源**
 *     （deliveryEligible 谓词单源见 notification-channel-eligibility.ts）
 *   - ./dto/notification-settings.dto.ts — `normalizeNotificationCategories`（偏好读取归一：
 *     白名单 10 类 ∩ 严格布尔覆盖，基座 = `DEFAULT_NOTIFY_CATEGORIES`）
 *   - ../../database/entities/board.entity.ts / doc-space.entity.ts — **v2 归属**：看板名 / 空间名
 *     （`name` 列；两个实体只被本文件的归属解析读，`forFeature` 在 notifications.module.ts）
 *   - ../../config/notifications.config.ts — 全部旋钮 / 类别值域 / 出境声明单源
 *   - notifications-provider.factory.ts — `NOTIFY_PROVIDER_LIST`（本文件遍历投递）与配置兜底
 *   - notify-provider.interface.ts — `RenderedNotification`（出境面）/ `DeliveryOutcome`
 *   - notify-delivery.repository.ts — 终态落库的唯一入口（永不抛）
 *   - ../event/event.service.ts — `emit('event.created', saved)` 的唯一发出方（落库后、事务外）
 *   - ../topic/topic.service.ts — `AGENT_JOINED` / `AGENT_LEFT` 的发出方（**人类参与者也发**，
 *     失效钩子不得按 actorType 过滤）
 *   - notifications.module.ts — 本服务的装配点（含 forFeature 清单）
 *   - notification-settings.service.ts — **本服务的下游**：渠道/偏好写路径调用
 *     `invalidateUser()` 做写时失效（方向单向，禁反向依赖）
 *   - notify-direct.service.ts — **直发链路**：复用本文件的收件人解析（`resolveDirectTarget`）/
 *     L2 占额（`reserveL2ForDirect`）/ provider 兜底（`sendThroughProvider`）三个入口
 *     （见 [代码职责] 的复用面一条）
 *   - ../memory/engine-health-tracker.service.ts — **系统告警的调用方**（`sendSystemAlert()` 的
 *     唯一消费者；单链 `.then().catch()` 形态见其 alert dispatch）
 *
 * [持久踩坑]
 *   NOTIFY-FIRE-AND-FORGET-CRASH(裸 void promise 崩进程): 监听器内 `void doWork()` 的 rejection
 *     不受 Nest 包装保护 ⇒ Node 22 未捕获 rejection ⇒ **整个后端进程退出**（不是"这条通知没发
 *     出去"，是"平台挂了"）。安全方向: 一律 `fireAndForget()`，禁止裸 `void`。
 *   NOTIFY-ALS-CONTEXT-LEAK(监听器里读 ALS): `{async:true}` 的 setImmediate 继承写入方上下文，
 *     在监听器里读"当前 actor"会拿到**触发事件的那个请求**的身份。安全方向: 只用 `event.actorId`。
 *   NOTIFY-SNAPSHOT-FAIL-POISON(一次抖动 = 该用户永久静默): single-flight 的在途表若不在
 *     `finally` 清位，一个失败（被拒绝）的 promise 会**留在表里**，后续每个事件都直接拿到那条
 *     失败结果、永不再重建 ⇒ 该用户从那一刻起收不到任何通知，且**没有任何报错**。
 *     安全方向: `.finally(() => this.snapshotInFlight.delete(userId))`（含 rejected）。
 *   NOTIFY-SNAPSHOT-PERMISSION-STALE(权限进快照 = 越权旁路): 把 `readableUserIds` / role 放进
 *     60s 快照，等于给"admin 被降权""成员被移出私有看板"开一条最长 60s 的**越权出境**窗口
 *     （期间被移出的人仍会收到私有资源标题）。安全方向: 快照只存用户自改配置，权限每事件定向查询。
 *   NOTIFY-L1-MARK-ON-FAILURE(渲染失败却占了窗口): 先标记后渲染 ⇒ 一次幻影事件会压掉后续
 *     真实的同一资源通知。安全方向: 检查前置、标记后置（抄 hint-dedup）。
 *   NOTIFY-DIGEST-UNBOUND(摘要绕开"解绑即停"): L2 缓冲只存计数、flush 在**窗口结束**（或超额
 *     那一刻）才投递；若 flush 不重判 `deliveryEligible`，一个在缓冲期解绑/静音的用户仍会收到
 *     那条摘要 ⇒ "解绑 = 通知立即停止"被绕开一条时间缝（plan §D3 的 V6）。
 *     安全方向: flush 前重判（见 [关键不变量]），不通过即丢弃 + INFO。
 *   NOTIFY-ATTRIBUTION-DROP(归属取不到就丢通知): v2 的归属查询（board / DocSpace / actor 名）
 *     各有"查不到"的常态分支（`boardId` 是可省键、actor 可能已软删、space 行可能缺失）。
 *     把这些分支写成 `return null` 会让**归属残缺升级成整条静默**——Owner 连"有这件事"都
 *     看不到。安全方向: 归属一律兜底 `ATTRIBUTION_FALLBACK`，return null 只留给"资源行真的
 *     不存在"（幻影事件）这一种语义。
 *   NOTIFY-SYSTEM-ALERT-QUOTA(auth recovery 免额 = 反刷屏被架空): B 臂 flap 可被**任何登录用户**
 *     诱发（5×403 + 1 次成功循环）；若 recovery 免额，攻击者能用"恢复通知"绕过每小时上限。
 *     安全方向: `auth` 桶 **alert + recovery 都计额**；只有 `availability` 的 recovery 免额
 *     （A 臂恢复有探针 2 连胜 ≥4min 迟滞）。见 `consumeSystemAlertQuota`。
 *   ⚠️ **已退役条目**：`NOTIFY-TOPIC-OWNER-MISSING`（"owner 解析数为 0 ⇒ 跳过 topic 类别"）
 *     随单 Owner 模型二期退役——多用户路由下不存在"一个全局 owner 参与不参与"这个问题，
 *     该对策的实现（`topicSkipWarned`）已随代码删除，**不要照它排查**。
 *
 * [铁律关联] #11(注释强制) #17(测试契约) #18(不变量检查)
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 新增类别 token 必须同步 §5 映射表 + config 值域 + 单测矩阵（枚举一致性断言会红）
 *   □ 新增 `void promise` 必须经 `fireAndForget()`（见 [关键不变量] 第一条）
 *   □ 新增出境字段必须同 commit 更新 config 的 `NOTIFY_EGRESS_FIELDS`
 *   □ 改路由判据（`resolveRecipients` 一族）必须同步安全矩阵（`test/notify-routing.e2e-spec.ts`）
 *     与「查询数与候选人数无关」的计数断言
 *   □ 改 L1 / L2 的**键语义**必须同步三处点名（`consumeL2` / `flushDigestIfNeeded` /
 *     `reserveL2ForDirect`）+ `L2Window.recipientUserId` + `test/notifications-pipeline.e2e-spec.ts`
 *     的 `l2Windows` 复位助手（键换了，助手里的断言也可能要换）
 *   □ 新增用户可自改配置进快照 ⇒ 必须同 commit 接上写时失效钩子（`invalidateUser`）
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';
import {
  ActivityAction,
  AgentStatus,
  EventType,
  MessageType,
  ParticipantStatus,
  ResourceType,
  TaskStatus,
  UserRole,
} from '@agent-chamber/shared';
import { ActorProfileService } from '../../common/services/actor-profile.service';
import { AccessQueryService } from '../../common/services/access-query.service';
import {
  NOTIFICATIONS_CONFIG_FALLBACK,
  NOTIFY_CATEGORY,
  type NotifyCategory,
  type NotificationsConfig,
} from '../../config/notifications.config';
import {
  normalizeNotificationCategories,
  type NotificationCategoryPrefs,
} from './dto/notification-settings.dto';
import { Agent } from '../../database/entities/agent.entity';
import { Board } from '../../database/entities/board.entity';
import { Event } from '../../database/entities/event.entity';
import { Doc } from '../../database/entities/doc.entity';
import { DocSpace } from '../../database/entities/doc-space.entity';
import { Message } from '../../database/entities/message.entity';
import { Task } from '../../database/entities/task.entity';
import { Topic } from '../../database/entities/topic.entity';
import { TopicParticipant } from '../../database/entities/topic-participant.entity';
import { User } from '../../database/entities/user.entity';
import {
  DIGEST_DELIVERY_CATEGORY,
  SYSTEM_ALERT_DELIVERY_CATEGORY,
  type NotificationDeliveryCategory,
} from '../../database/entities/notification-delivery.entity';
import { UserNotificationChannel } from '../../database/entities/user-notification-channel.entity';
import { sanitizeLogValue } from '../../config/judgment.config';
import { deliveryEligibleWhere } from './notification-channel-eligibility';
import { resolveNotificationsConfig } from './notifications-provider.factory';
import {
  NOTIFY_PROVIDER_LIST,
  type DeliveryOutcome,
  type NotifyProvider,
  type NotifySendOptions,
  type RenderedNotification,
} from './notify-provider.interface';
import { NotifyDeliveryRepository } from './notify-delivery.repository';

/** L1 节流表的容量上限（满则插前删最旧）。rationale 同 hint-dedup：单条 ≈ 百字节，一万条约 MB 级。 */
export const L1_MAX_ENTRIES = 10_000;

/** topic 参与判定缓存的 TTL（60s）。rationale：参与关系变化远低于消息频率，缓存省掉每条消息一次查询。 */
export const TOPIC_PARTICIPATION_TTL_MS = 60_000;

/**
 * topic 参与缓存（topicId → **active 参与者 id 集合**）的容量上限（满则插前删最旧；同 L1 纪律）。
 *
 * ⚠️ **Notifications 二期重估过**：值从一期的"boolean"变成"参与者集合"，单条体量放大到
 * `参与者数 × ~40B`（一个 20 人的话题 ≈ 1KB）。5000 条 × 1KB ≈ 5MB 上界——话题总数在可预见
 * 的部署规模下远低于 5000（每进程只缓存**本进程近期见过的事件所涉话题**，且 TTL 60s 惰性回收），
 * 故维持 5000 不变：这个上限的作用是"防爆"而不是"精确预算"。
 */
export const TOPIC_PARTICIPATION_MAX_ENTRIES = 5_000;

/**
 * per-user 通知快照的 TTL（毫秒）与抖动幅度。
 *
 * 60s 是"缓存省查询"与"配置变更可见延迟"的折中：快照里只有**渠道绑定 / 类别偏好 / 我的 agent**
 * 三类**用户可自改**的配置（权限集合与 role **刻意不进快照**，见文件头不变量），而这三类的
 * 每次写入路径都会**显式失效**（`invalidateUser`）——TTL 只是**兜底自愈窗口**（覆盖"失效钩子
 * 没覆盖到的写路径"，例如 admin 直接改库）。
 *
 * 抖动（±10s）的理由：一次部署里所有用户的快照若在同一秒集体到点，就会出现"每个事件都重建
 * 全部候选快照"的同步 stampede（N 个用户 × **4 条查询**同时打库）。抖动把它们摊开。
 */
export const USER_SNAPSHOT_TTL_MS = 60_000;

/** 快照 TTL 的抖动幅度（见 {@link USER_SNAPSHOT_TTL_MS} 的 rationale；实际 TTL ∈ [60s, 70s)） */
export const USER_SNAPSHOT_TTL_JITTER_MS = 10_000;

/** per-user 快照缓存的容量上限（满则插前删最旧；单条 ≈ 数百字节，见文件头单实例部署声明） */
export const USER_SNAPSHOT_MAX_ENTRIES = 10_000;

/** 连续投递失败达到该条数即打一行周期 warn（plan §3：fail-open 的补偿观测点）。 */
export const CONSECUTIVE_FAILURE_WARN_THRESHOLD = 5;

/**
 * D4 播种用的 **PostgreSQL advisory lock 键**（`pg_advisory_xact_lock`，事务级、随事务释放）。
 *
 * rationale：播种是"启动期一次性的 INSERT"，但在**多副本同时启动**或**同进程重复初始化**的
 * 窗口里，两个执行流可能都通过了"该 user 无 feishu 行"的读判据、然后各插一行。唯一的
 * `(user_id, provider)` 约束会挡住第二行，但**先读后写**的窗口仍值得用一把锁关掉（代价近零，
 * 收益是"要么播种成功要么明确 no-op"，不留一个靠约束兜底的模糊态）。键值是任意固定常量，
 * 只要**全仓唯一**（不与其它模块的 advisory lock 撞）即可。
 */
export const NOTIFY_SEED_ADVISORY_LOCK_KEY = 918_273_645;

/**
 * D4 播种的 **outcome 枚举**（plan §D4；throw 纪律见 `seedFromEnv`）。
 *
 * - `seeded`：真的插入了一行（+ 回填了台账）；
 * - `already_seeded`：该 user 已有 feishu 行（含 tombstone）/ 并发窗口内 ON CONFLICT no-op；
 * - `skipped_no_source`：有地址但无唯一归属 ⇒ **throw**（补救 = 改 env）；
 * - `skipped_ambiguous`：`NOTIFY_OWNER_USERNAMES` 多于一人 ⇒ ERROR 不 throw（应用内可补救）；
 * - `skipped_address_taken`：该地址已属于别人 ⇒ ERROR 不 throw（换人拒绝）。
 * - `failed`（执行错误）不在此枚举里：它**直接 throw**，没有"返回值"这一态。
 */
export type SeedOutcome =
  | 'seeded'
  | 'already_seeded'
  | 'skipped_no_source'
  | 'skipped_ambiguous'
  | 'skipped_address_taken';

/** 摘要正文的截断长度（plan §3：摘要截断 100 字符）——**预览语义**的宽度（见下方 200 的取舍） */
export const NOTIFICATION_SUMMARY_MAX_LENGTH = 100;

/**
 * 正文截断长度上限（**归属信息完整**语义；v2 起 task / doc 四类别用它）。
 *
 * 为什么与 {@link NOTIFICATION_SUMMARY_MAX_LENGTH} 分成两个常量（2026-10-13 主脑拍板）：
 * `notification_deliveries.body` 是 `text` 列（**无**数据库宽度约束），100 纯粹是渲染策略。
 * - **topic 用 100**：它的正文是消息 excerpt，**预览语义**——"有人在你参与的话题里说了什么"
 *   只需要够看出是哪条消息，点进去读全文是常态，短是刻意。
 * - **task / doc 用 200**：它们的正文是**消息本体**（看板名 / 操作者 / 空间名 + 文档标题）。
 *   归属信息被截掉尾巴 ≈ 这条通知失去存在意义（"哪个项目的看板？"正是本类通知要回答的问题），
 *   宽度换不回来 —— **归属信息完整性优先于长度紧凑**。
 * - 上限仍有意义：超长文档标题 / 超长看板名不得把通知撑成一段读不完的文本。
 */
export const NOTIFICATION_BODY_MAX_LENGTH = 200;

/** 标题长度上限（与 `notification_deliveries.title` 列宽一致） */
const TITLE_MAX_LENGTH = 200;

/**
 * 系统告警正文的长度上限（**新常量，禁止复用 200 的 `NOTIFICATION_BODY_MAX_LENGTH`**）。
 *
 * rationale：告警正文实测 239-331 字符（`[engine alert] ...` + 多行诊断 + 「处置：」行 /
 * `[engine recovered] ...` + 「恢复：」行）。200 会把**处置与恢复指引**这两行切掉——而这两行
 * 恰恰是运维唯一可执行的出口，切掉后通知退化成"平台病了，自己查"。
 * 1000 是"够装完整诊断 + 留余量"的预算（正文仍由生产方拼装，不是自由文本）。
 */
export const SYSTEM_ALERT_BODY_MAX_LENGTH = 1000;

/**
 * 系统告警量控窗口（1 小时，固定）。上限本身 = `NOTIFY_SYSTEM_ALERT_MAX_PER_HOUR`
 * （缺省 12），见 {@link NotifyOrchestrator.sendSystemAlert} 的分桶语义。
 *
 * 为什么窗口是固定常量而不是 env：语义是"每小时最多几条"，改窗口长度会让名字对不上；
 * 需要调松紧时调上限即可。
 */
export const SYSTEM_ALERT_RATE_WINDOW_MS = 3_600_000;

/**
 * 系统告警的来源（**闭集联合类型**：新增来源必须同时改生产方与本类型）。
 *
 * 今天只有 memory 引擎的健康 tracker——闭集让"谁在往运维手机上发东西"在编译期可枚举。
 */
export type SystemAlertSource = 'memory-engine';

/** 系统告警的种类（`alert` = 异常；`recovery` = 恢复；`heartbeat` = 周期性心跳） */
export type SystemAlertKind = 'alert' | 'recovery' | 'heartbeat';

/**
 * 系统告警的量控分桶键（**按臂分桶**，见 plan D6-4 的安全裁决）：
 * - `auth` 桶：`alert + recovery` **都计额**——B 臂 flap 可被普通用户诱发（5×403 + 1 次成功
 *   循环），recovery 免额会把反刷屏整体架空；
 * - `availability` 桶：**只计 alert**，recovery 免额——A 臂恢复有探针 2 连胜 ≥4min 迟滞，
 *   天然有界。
 */
export type SystemAlertArm = 'availability' | 'auth';

/**
 * `sendSystemAlert()` 的入参（**生产方组装，notify 只负责投递**）。
 *
 * ⚠️ `title` / `body` 必须是**编译期闭集文案**（生产方 tracker 的固定模板）——禁止拼 URL /
 * endpoint / credentialRef / requestId / 上游响应原文等运行期自由文本。本端不做内容审查，
 * 只做控制字符剥离与长度截断；出境面的安全由生产方的模板与净化保证。
 */
export interface SystemAlertInput {
  /** 来源（闭集；今天只有 `memory-engine`） */
  source: SystemAlertSource;
  /** 种类（决定量控是否计额） */
  kind: SystemAlertKind;
  /** 量控分桶键（见 {@link SystemAlertArm}） */
  arm: SystemAlertArm;
  /** 标题（生产方文案的**首行**；≤200 字符由渲染层截断） */
  title: string;
  /** 正文（生产方文案的余下各行；多行保留 `\n`，≤{@link SYSTEM_ALERT_BODY_MAX_LENGTH}） */
  body: string;
  /** 发生时刻（ISO 8601）。**只进 outcome 日志行**（`at=<iso>`，供生产方与自己的状态机对账），
   *  不进正文、不进投递表；不是可选的装饰字段——调用方必须给。 */
  occurredAt: string;
  /** 连续异常次数（可选；同上，不进出境面） */
  consecutive?: number;
  /** 引擎 workspace 标识（生产方**已净化**；本端只校验/透传，不改写标识符） */
  workspaceId?: string;
}

/**
 * `sendSystemAlert()` 的**九态闭集**结果（never-throw：异常一律折成 `failed`）。
 *
 * 语义区分（排障动作完全不同）：
 * - `delivered` / `failed`：真的走到 provider 并落终态行（失败原因看投递记录）；
 * - `disabled`：部署级总开关关（`NOTIFY_ENABLED=false`）——**不计额**，证据只在日志；
 * - `no_admin` / `admin_soft_deleted`：收件人解析断（无 admin 账号 / admin 的 actor 已软删）；
 * - `no_channel` / `channel_ineligible`：admin 没绑渠道 / 绑了但不可投递（未验证、静音、解绑过）；
 * - `no_provider`：收件人渠道存在但该 provider 未装配；
 * - `rate_limited`：本次被量控丢弃（见分桶语义）。
 * 除 `delivered` / `failed` 外的六态**都不落投递记录**（本表的语义是"出境审计"，见实体文件头）。
 */
export type SystemAlertOutcome =
  | 'delivered'
  | 'failed'
  | 'disabled'
  | 'no_admin'
  | 'admin_soft_deleted'
  | 'no_channel'
  | 'channel_ineligible'
  | 'no_provider'
  | 'rate_limited';

/**
 * 系统告警收件人解析结果（`resolveSystemAlertTarget()` 的判别联合）。
 *
 * 为什么不用 `null`：`resolveDirectTarget()` 把两种成因（无绑定的用户态 vs 用户态之外）压成
 * 同一个 null，导致直发端点只能给一个笼统 reason；本端需要**六种断态的精确区分**（运维动作
 * 分别为"建 admin / 恢复账号 / 绑渠道 / 去点测试 / 启用 provider / 什么都不用做"），
 * 故用判别联合承载。
 */
type SystemAlertTarget =
  | { status: 'no_admin' }
  | { status: 'admin_soft_deleted'; adminUsername: string }
  | { status: 'no_channel' }
  | { status: 'channel_ineligible' }
  | { status: 'no_provider' }
  | {
      status: 'ok';
      adminUsername: string;
      userId: string;
      provider: string;
      recipient: string;
    };

/**
 * 归属信息（看板名 / 空间名 / 显示名）缺失时的占位（v2）。
 *
 * ⚠️ 存在的意义是**降级而不丢弃**：多项目 / 多 agent 场景下归属是"这条通知是谁的事"的唯一线索，
 * 但它终究是**旁挂信息**——boardId 缺键、board/space 行缺失、actor 已删都不该让 Owner
 * **完全看不到**这件事本身。故一律兜底成 `?`，绝不 return null。
 */
const ATTRIBUTION_FALLBACK = '?';

/**
 * L2 窗口兜底扫描间隔（毫秒）。
 *
 * rationale：窗口结束时的摘要 flush 需要一个定时兜底（事件触发只覆盖"还有事件进来"的情况；
 * 一批事件打完后窗口静静结束，摘要会一直躺在缓冲里）。60s 的扫描粒度让摘要最迟晚窗口
 * 1 分钟到达——对"批量刷屏后的汇总"完全够用，且开销可忽略（只看几个内存对象）。
 */
export const L2_SWEEP_INTERVAL_MS = 60_000;

/**
 * 带 TTL + 容量上限的内存映射（L1 节流与 topic 参与缓存共用一个实现）。
 *
 * 形态抄 `modules/hints/hint-dedup.service.ts`：**Map 迭代序 = 插入序**，故"插前删最旧"只需删
 * 首个键；过期条目**读时惰性回收**（不引入独立的清理定时器）。
 *
 * 导出供单测直接断言 TTL / 淘汰语义（生产只在本文件内使用）。
 */
export class TtlMap<V> {
  private readonly entries = new Map<string, { value: V; expiresAt: number }>();

  constructor(private readonly maxEntries: number) {}

  /**
   * 读一个键（过期即惰性删除）。
   *
   * @param key 键
   * @param now 当前时刻（epoch ms；单测注入）
   * @returns 值，或 undefined（不存在 / 已过期）
   */
  get(key: string, now: number = Date.now()): V | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= now) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  /**
   * 写一个键（容量满且是新键 ⇒ 先删最旧）。
   *
   * @param key 键
   * @param value 值
   * @param ttlMs 生存时间
   * @param now 当前时刻（epoch ms；单测注入）
   */
  set(key: string, value: V, ttlMs: number, now: number = Date.now()): void {
    if (!this.entries.has(key) && this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    this.entries.set(key, { value, expiresAt: now + ttlMs });
  }

  /** 当前条目数（单测断言容量淘汰用） */
  get size(): number {
    return this.entries.size;
  }

  /**
   * 删除一个键（**写时失效钩子的动作面**；幂等——键不存在时静默返回 false）。
   *
   * 为什么不直接暴露内部 Map：本类的淘汰/过期语义（插入序 + 惰性回收）是它的不变量，
   * 让调用方拿到裸 Map 就能绕过它们（例如只 `map.get` 而不触发过期回收）。
   *
   * @param key 键
   * @returns true = 确实删掉了一条（单测断言失效钩子真的生效用）
   */
  delete(key: string): boolean {
    return this.entries.delete(key);
  }

  /** 清空（单测隔离用；生产无调用点） */
  clear(): void {
    this.entries.clear();
  }
}

/**
 * 一条 **deliveryEligible 渠道绑定**的快照投影（Notifications 二期 per-user 快照的成员）。
 *
 * 为什么不直接存实体行：快照刻意**只保留"投递所需的字段"**（provider + 地址）。
 * 快照里多一个字段就多一份"与 DB 不一致"的可能，而它唯一的消费方（L2 投递地址 / provider
 * 选择）只需要这两个。
 */
export interface NotifyChannelSnapshot {
  /** 出口 provider（`NOTIFY_PROVIDER_TOKENS` 值域） */
  provider: string;
  /** 收件地址（飞书 = open_id） */
  recipientAddress: string;
}

/**
 * **per-user 通知快照**（`TtlMap` 缓存；plan §D3「缓存与失效」）。
 *
 * ⚠️ **只存三类用户自改配置**（`channels` / `prefs` / `agentIds`），
 * **刻意不存权限集合、不存 role**：权限（谁能读哪个 board/space）必须**每个事件定向查询**
 * 才有零陈旧——把 `readableUserIds` 或 role 放进 60s 快照，就等于给"admin 被降权""成员被移出"
 * 开了一个最长 60s 的越权出境旁路。这三类字段的失效路径是**显式失效钩子**（写路径）+ TTL 兜底。
 */
export interface NotifyUserSnapshot {
  /** 绑定所属用户（`users.id` = `actors.id`） */
  userId: string;
  /** **仅 deliveryEligible 的绑定行**（禁投/未验证/tombstone 行不进快照；创建序） */
  channels: NotifyChannelSnapshot[];
  /** 类别偏好（已归一：白名单 10 类、键恒在；缺省基座 = `DEFAULT_NOTIFY_CATEGORIES`） */
  prefs: NotificationCategoryPrefs;
  /** 该用户拥有的 agent id 集合（owner-proxy 语义：自回声与注意力层的"我的 agent"分量） */
  agentIds: ReadonlySet<string>;
}

/**
 * **一个通过路由判据的收件人**（`resolveRecipients` 的返回元素）。
 *
 * 为什么返回这个复合体而不是"收件地址字符串数组"：投递链路后续需要的不止地址——
 * ① **L2 窗口键与投递地址**要 `channels[0].recipientAddress`（plan §D3 节流泛化的点名改造）；
 * ② **投递台账归属列**要 `userId`（`RecordDeliveryInput.recipientUserId`）；
 * ③ **投递时重判**要能再取一次快照事实。
 * 把三者一起交出去，消费方就不必回头再查一次"这个地址是谁的"（那是又一次可能不一致的查询）。
 */
export interface NotifyRecipient {
  /** 收件人的平台用户 id */
  userId: string;
  /** **仅 deliveryEligible** 的绑定行（创建序；`channels[0]` = 当前主投递地址） */
  channels: NotifyChannelSnapshot[];
  /** 该用户拥有的 agent id 集合（自回声 / 后续判据输入） */
  agentIds: ReadonlySet<string>;
}

/**
 * **该用户此刻没有任何 `deliveryEligible` 绑定**（快照构建的**唯一**"正常失败"）。
 *
 * 为什么要有这个专用类型（而不是让 `buildUserSnapshot` 抛一句普通 Error）：直发链路必须把
 * 两种截然不同的失败分开——
 *   - **这个**（用户状态：没绑定 / 刚解绑 / 刚静音）⇒ 200 降级 `recipient_not_bound`，
 *     文案让 agent 去提醒它的 creator 去绑；
 *   - **其它任何错**（DB 抖动 / 连接池耗尽）⇒ 基础设施故障，必须**冒泡成 5xx**，绝不能被
 *     说成"你的 creator 没绑渠道"（那是把一次运维故障伪装成用户的持久状态——最难排的一类假象）。
 * 事件链路不区分两者（`loadSnapshots` 一律跳过该候选、下一个事件重试），消费差异只在直发。
 */
export class NotifyNoEligibleChannelError extends Error {}

/**
 * L2 滑动窗口的一个**收件人**窗口（批 2 棒 B：窗口维度 = `userId`）。
 *
 * ⚠️ **缓冲只存计数**（见文件头不变量）：`suppressed` 是"被压制了几条"的账，不是待发通知队列。
 */
interface L2Window {
  /**
   * 窗口归属的用户 id（`users.id`）。
   *
   * ⚠️ **它与 `l2Windows` 的 Map 键是同一个事实，但仍然必须有**（MINOR-4，2026-10-13 复核）：
   * 窗口对象会**脱离键单独旅行**——`consumeL2` 把它交出来、`flushDigestIfNeeded` 收下它、
   * `startSweep` 只迭代值，而投递台账的 `recipient_user_id` 列与"该用户的主投递渠道"都必须
   * 由**窗口自己**说出"这是谁的"。靠调用方"记得键"是一个可以被重构悄悄打破的隐式契约。
   * 写入点唯一：`windowFor`（每次建/滚动重建窗口时写）。
   */
  recipientUserId: string;
  /** 窗口起点（epoch ms） */
  startedAt: number;
  /** 本窗口已放行（已投递）的条数 */
  delivered: number;
  /** 本窗口被压制的条数（按类别计数；**只存计数不存正文**） */
  suppressed: Map<NotifyCategory, number>;
  /** 本窗口是否已发过摘要（窗口内 ≤1 条；摘要不占额度） */
  summarySent: boolean;
}

/**
 * 通知类别映射（**纯函数**，§5 表；单测直接断言全 token 矩阵）。
 *
 * 判据顺序即语义（`task_done` 先于 `task_created`；但 create() 路径的载荷没有跃迁字段，
 * 跃迁判据天然为假，故"创建即完工"的任务仍落 `task_created`）：
 * - `TASK_UPDATE` + 跃迁判据成立 → `task_done`（含 move() 的 autoStatus 跃迁）
 * - `TASK_UPDATE` + `action='created'` → `task_created`
 * - `TASK_UPDATE` 其余 → `task_updated`（含 `patchDescription`——**不判完工**）
 * - `TASK_ASSIGNED` → `task_assigned`
 * - `NEW_MESSAGE` 且 `payload.type !== 'system'` → `topic`
 * - `DOC_CREATED/DELETED/MOVED` → 同名 token
 * - `DOC_UPDATED` 且 `payload.rechunked !== true` → `doc_updated`（**纯重切短路**）
 *
 * @param event 事件行（只读 eventType 与 payload）
 * @returns 类别 token，或 null（本事件不产生通知）
 */
export function resolveNotificationCategory(
  event: Pick<Event, 'eventType' | 'payload'>,
): NotifyCategory | null {
  const payload = (event.payload ?? {}) as Record<string, unknown>;

  switch (event.eventType) {
    case EventType.TASK_UPDATE:
      if (isCompletionTransition(payload)) return NOTIFY_CATEGORY.TASK_DONE;
      if (payload.action === ActivityAction.CREATED) return NOTIFY_CATEGORY.TASK_CREATED;
      return NOTIFY_CATEGORY.TASK_UPDATED;
    case EventType.TASK_ASSIGNED:
      return NOTIFY_CATEGORY.TASK_ASSIGNED;
    case EventType.NEW_MESSAGE:
      // system 消息（圆桌回执 / 安全阀公告等）不产生通知：它们是机器噪音，不是"有人说话"
      return payload.type === MessageType.SYSTEM ? null : NOTIFY_CATEGORY.TOPIC;
    case EventType.DOC_CREATED:
      return NOTIFY_CATEGORY.DOC_CREATED;
    case EventType.DOC_UPDATED:
      // 纯重切（DOC_UPDATED 的唯一已知来源之一）短路：内容没变，通知它只是噪音
      return payload.rechunked === true ? null : NOTIFY_CATEGORY.DOC_UPDATED;
    case EventType.DOC_DELETED:
      return NOTIFY_CATEGORY.DOC_DELETED;
    case EventType.DOC_MOVED:
      return NOTIFY_CATEGORY.DOC_MOVED;
    default:
      return null;
  }
}

/**
 * 完工跃迁判据（**纯函数**，单测直接断言；见文件头 [关键不变量]）。
 *
 * `toStatus ∈ {done, blocked} && fromStatus !== toStatus`。
 * ⚠️ **载荷缺跃迁信息时两值都是 undefined ⇒ `undefined !== undefined` 为假**——这正是
 * "改一个已完成任务的描述不推完工"的机制（`patchDescription` 路径的载荷没有 status）。
 *
 * @param payload 事件载荷
 * @returns true = 本次是一次真实的完工/阻塞跃迁
 */
export function isCompletionTransition(payload: Record<string, unknown>): boolean {
  const toStatus = payload.toStatus;
  const fromStatus = payload.fromStatus;
  if (toStatus !== TaskStatus.DONE && toStatus !== TaskStatus.BLOCKED) return false;
  return fromStatus !== toStatus;
}

/**
 * 文本截断（**上限由调用方给定**——本函数自己不持任何档位）。
 *
 * 档位的**单源**是本文件的两个导出常量：`TITLE_MAX_LENGTH`(200) /
 * `NOTIFICATION_SUMMARY_MAX_LENGTH`(100：topic 与 digest) /
 * `NOTIFICATION_BODY_MAX_LENGTH`(200：task 与 doc)；`direct` 的 2000 在
 * `notify-direct.service.ts`。分层语义见文件头 [关键不变量] 的「正文宽度分三层」。
 *
 * @param text 原文（可空）
 * @param max 上限（由调用方按档位传入，见上）
 * @returns 截断后的字符串（null/undefined → 空串——列是 NOT NULL）
 */
function truncateText(text: string | null | undefined, max: number): string {
  if (!text) return '';
  return text.length > max ? text.slice(0, max) : text;
}

/**
 * 错误名（**只打 name，不打 message**）：仓储/驱动的 message 可能夹带 SQL 片段或用户数据，
 * 而告警链路的日志会进运维视野。与 `engine-health-tracker` 的同名工具同口径。
 *
 * @param err 未知异常
 * @returns 短名称（非 Error 时为 typeof）
 */
function errorName(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}

/**
 * 系统告警文案的**控制字符剥离**（渲染前）：去掉 `\r` 与全部 C0/C1 控制字符，**保留 `\n`**。
 *
 * rationale：告警正文是多行结构（首行进 title、余下进 body），换行是语义的一部分；
 * 而 `\r` 会在不同客户端造成覆盖写（进度条式覆盖 = 关键诊断行被吞），其余控制字符没有
 * 正当用途。⚠️ 本函数只做"渲染卫生"，**不做内容审查**——出境面的安全由生产方模板保证
 * （见 {@link SystemAlertInput} 的约定）。
 *
 * @param text 原文
 * @returns 剥离控制字符后的文本
 */
function stripControlChars(text: string): string {
  // 保留 \n（U+000A）；其余 C0（含 \r、\t）与 C1 控制字符一律移除
  return text.replace(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/g, '');
}

/**
 * 通知编排器（**default-scope 单例**：Nest provider 缺省单例，见 notifications.module.ts）。
 *
 * ⚠️ 生命周期 = 进程；内存态节流/缓存不持久（重启清零），多副本各自独立（见文件头不变量）。
 */
@Injectable()
export class NotifyOrchestrator implements OnModuleInit, OnModuleDestroy, OnApplicationBootstrap {
  private readonly logger = new Logger(NotifyOrchestrator.name);

  /** 生效配置（构造期解析一次；含缺省兜底——e2e 未 load 工厂时的形状保证） */
  private readonly settings: NotificationsConfig;

  /**
   * **D4 播种用的 owner actorId 集合**（启动解析；见 `resolveOwners`）。
   *
   * ⚠️ **唯一消费方 = `seedFromEnv`**（批 2 棒 B 收敛后）：`NOTIFY_OWNER_USERNAMES` 恰好解析出
   * 1 人时，把 `FEISHU_RECIPIENT_OPEN_ID` 预绑给那个 user（升级日平滑迁移）。
   * 历史消费方**已全部退役**：① 事件管线的"owner 自回声 / 参与判定"（二期批 2 棒 A 改
   * per-candidate）；② 直发链路的 `isOwnerActor`（棒 B 改"收件人 = 调用 agent 的 owner"）。
   * 故 `resolveOwners()` 保留（**不是死代码**），但"owner 未解析出来 ⇒ 整个 topic 类别跳过"
   * 那条一期对策**已随单 Owner 模型退役**（多用户模型下"谁参与"由 per-candidate 判据回答）。
   */
  private readonly seedOwnerActorIds = new Set<string>();

  /** 请求解析的 owner username 个数（`owner actors resolved n/N` 的分母） */
  private seedOwnerRequested = 0;

  /** 连续投递失败计数（达阈值打一行周期 warn 后清零） */
  private consecutiveFailures = 0;

  /** L1 节流表（`<资源分量>:<userId>` → 窗口到期时刻；键语义见 `l1Key`） */
  private readonly l1 = new TtlMap<true>(L1_MAX_ENTRIES);

  /**
   * topic 参与缓存（topicId → **active 参与者 id 集合**；TTL 60s）。
   *
   * ⚠️ 二期从一期的 `TtlMap<boolean>`（"owner 参与吗"）改成集合形态：多用户模型下同一个话题
   * 要对**一批候选**同时回答"你在不在"，集合形态让"一次查询喂饱全部候选"成为可能
   * （否则每个候选一次 count ⇒ 查询数与候选人数线性相关）。
   */
  private readonly topicParticipation = new TtlMap<ReadonlySet<string>>(
    TOPIC_PARTICIPATION_MAX_ENTRIES,
  );

  /**
   * **per-user 快照缓存**（userId → 快照；TTL 60s + 抖动）。
   *
   * 只覆盖"能投递的人"的**配置事实**（渠道 / 偏好 / 我的 agent），**不含任何权限事实**
   * （见 {@link NotifyUserSnapshot} 的不变量）。
   */
  private readonly snapshots = new TtlMap<NotifyUserSnapshot>(USER_SNAPSHOT_MAX_ENTRIES);

  /**
   * **single-flight 在途表**（userId → 正在构建的快照 promise）。
   *
   * 为什么需要：一场批量事件（例如看板里连点几次）会在极短时间内为同一批用户反复解析快照，
   * 冷缓存下 N 个并发事件会各自打一遍同一批 **4 条查询**。让并发请求**共享同一个 promise**，
   * 重建次数从 O(并发数 × 用户数) 降回 O(用户数)。
   *
   * ⚠️ **清位与落地都判"是不是我这一份"**（MAJOR-1，2026-10-13 复核）：
   *   ① `finally` 里判 `snapshotInFlight.get(userId) === pending` 再删——无条件删会把
   *      `invalidateUser` 之后**新起**的那一份从表里误删（它的等待者还在等着复用）；
   *   ② `.then` 里判同一个条件再写缓存——一份被摘过牌的重建读的是**写前**的事实，写进去
   *      就是把陈旧值留 60-70s（"解绑 = 通知立即停止"被绕开一分钟，见 `invalidateUser`）。
   * 另：**在途表必须回到空位**（含 rejected promise）：一个被拒绝的 promise 若留在表里，
   * 这个用户就会**永久**拿到那条失败结果（后续事件不再重建——"一次 DB 抖动 = 该用户从此静默"）。
   * 先例：`feishu.notify-provider.ts` 的 in-flight tenant-token 模式（同款 finally 清位）。
   */
  private readonly snapshotInFlight = new Map<string, Promise<NotifyUserSnapshot>>();

  /** 零候选类别（once-per-category INFO——运维要能区分"没人该收"与"路由坏了"） */
  private readonly zeroCandidateNoted = new Set<NotifyCategory>();

  /**
   * L2 滑动窗口（**per-user**：`userId` → 窗口；批 2 棒 B 起键 = `userId`）。
   *
   * 键从"投递地址"换成"用户 id"的理由：地址会变（改绑 / 解绑），而"某个人的手机别被刷爆"
   * 这件事的主体始终是**人**；地址在 `deliveryEligible` 下虽然 `(provider, address)` 唯一、
   * 与 userId 一一对应，但那是**当下**的对应关系——换地址后新地址会拿到一个全新的空窗口
   * （额度被"重置"），而旧地址的残留窗口再也不会被消费。
   */
  private readonly l2Windows = new Map<string, L2Window>();

  /**
   * **部署级出境总闸**窗口（Notifications 二期；全局一个窗口，不按用户分）。
   *
   * 与 per-user L2 是**两种粒度**：L2 挡"别把某个人的手机刷爆"，总闸挡"别把整个部署的外部
   * 配额/账单打穿"。`consumePlatformGate()` 是它的唯一消费入口（test 端点与事件路径都用它）。
   * ⚠️ **摘要豁免它**（见文件头 [关键不变量]）。
   */
  private platformWindow: { startedAt: number; delivered: number } | null = null;

  /**
   * 总闸丢弃的**限频 WARN** 状态：距上次 WARN 的间隔达到一个总闸窗口、且这期间确有丢弃时，
   * 打一行带累计条数的 WARN。
   *
   * 为什么必须限频：总闸触发时丢弃往往成批（一次批量事件可能瞬掉几十个候选），逐条 WARN
   * 会把日志冲垮、把真正的信号埋掉。逐条的**证据**由带 `eventId` 的 INFO 承担（可 grep 对账），
   * WARN 只负责"这件事正在发生、规模多大"。
   */
  private platformGateDropped = 0;

  /** 上次总闸丢弃 WARN 的时刻（epoch ms；0 = 尚未报过 ⇒ 第一次丢弃立刻报） */
  private platformGateWarnedAt = 0;

  /** L2 兜底扫描定时器（`onModuleInit` 起、`onModuleDestroy` 清） */
  private sweepTimer: NodeJS.Timeout | null = null;

  /**
   * **系统告警量控桶**（key = `SystemAlertArm`；1 小时窗口，进程内、重启清零）。
   *
   * 为什么是"按臂分桶"而不是一个总桶（plan D6-4 的 security 裁决）：
   * - `auth` 桶的 flap 可被**任何登录用户诱发**（5×403 + 1 次成功），所以 `alert + recovery`
   *   都要计额——recovery 免额会让"恢复通知"成为反刷屏的旁路；
   * - `availability` 桶的恢复有探针 2 连胜 ≥4min 迟滞，天然有界 ⇒ 只计 alert。
   * 心跳不建桶（自带 60/240min 节律）。
   *
   * `dropped` / `warnedAt` 是**窗口聚合 WARN** 的状态：超限丢弃往往成批（一次 flap 循环），
   * 逐条 WARN 会冲垮日志；这里与部署总闸同款（一个窗口最多一行 WARN，带累计条数）。
   */
  private readonly systemAlertBuckets = new Map<
    SystemAlertArm,
    { startedAt: number; used: number; dropped: number; warnedAt: number }
  >();

  constructor(
    private readonly config: ConfigService,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectRepository(Task)
    private readonly taskRepo: Repository<Task>,
    @InjectRepository(Message)
    private readonly messageRepo: Repository<Message>,
    @InjectRepository(Topic)
    private readonly topicRepo: Repository<Topic>,
    @InjectRepository(Doc)
    private readonly docRepo: Repository<Doc>,
    @InjectRepository(TopicParticipant)
    private readonly topicParticipantRepo: Repository<TopicParticipant>,
    // v2 归属信息：看板名（任务通知"是哪张看板的事"）与空间名（文档通知"是哪个空间的事"）
    @InjectRepository(Board)
    private readonly boardRepo: Repository<Board>,
    @InjectRepository(DocSpace)
    private readonly docSpaceRepo: Repository<DocSpace>,
    // Notifications 二期：渠道绑定表——D4 播种写路径 / 零绑定锚点计数 / 批 2 的候选查询
    @InjectRepository(UserNotificationChannel)
    private readonly channelRepo: Repository<UserNotificationChannel>,
    // Notifications 二期：agent creator 的 direct 无绑定预警（agents.owner_id）
    @InjectRepository(Agent)
    private readonly agentRepo: Repository<Agent>,
    @Inject(NOTIFY_PROVIDER_LIST)
    private readonly providers: NotifyProvider[],
    private readonly deliveryRepo: NotifyDeliveryRepository,
    /**
     * v2 归属信息的**唯一**显示名解析入口（任务操作者 / 话题发言人）。
     *
     * 为什么不自己 join `actors`/`agents` 取名字：本仓的名字回退链（agent 名以 `agents.name`
     * 为准、软删 actor 名字仍保留）已经收口在 `ActorProfileService`（见 `topic.service.ts` 的
     * `senderName` 注入，同一份事实）——自建第二份必然与它分叉。
     *
     * ⚠️ 由 `@Global()` 的 `CommonModule` 提供（本模块不 import 任何他域模块，见
     * notifications.module.ts 的依赖方向不变量）。
     */
    private readonly actorProfiles: ActorProfileService,
    /**
     * **权限判据的唯一事实源**（Notifications 二期双层判据的安全层 + 注意力层）。
     *
     * 为什么必须复用它而不是自己 join `boards`/`board_members` 判一遍：读权限规则（open ∪
     * creator(含 owner-proxy) ∪ member ∪ admin）在本仓只有一份真相；通知模块自建一份近似推断
     * = **越权外发**（把私有看板/空间的标题推到用户手机上）。
     *
     * ⚠️ 由 `@Global()` 的 `PermissionModule` 提供（同 `ActorProfileService` 一族的基建依赖，
     * 不在"不 import 他域模块"约束内，见 notifications.module.ts 文件头）。
     * 它自己的 `forFeature` 覆盖 `BoardMember` / `DocSpaceMember`——**本模块不重复注册**。
     */
    private readonly accessQuery: AccessQueryService,
  ) {
    this.settings = resolveNotificationsConfig(config);
  }

  // ─────────────────────────────── 生命周期 ───────────────────────────────

  /**
   * 启动钩子：总开关关闭 ⇒ **什么都不做**（不读库、不起定时器）；开启 ⇒ 解析 owner →
   * **D4 播种**（升级日平滑）→ **启动诊断**（零绑定锚点 / 总闸自洽 / direct 无绑定预警）→
   * 起 L2 兜底扫描。
   *
   * ⚠️ 播种与诊断的顺序不可换：零绑定锚点必须**把刚播种的那一条算进去**（否则升级日会打一条
   * 与事实相反的 ERROR）。
   */
  async onModuleInit(): Promise<void> {
    if (!this.settings.enabled) return;
    await this.resolveOwners();
    await this.seedFromEnv();
    await this.runStartupDiagnostics();
    this.startSweep();
  }

  // ─────────────────── D4 播种（升级日平滑迁移） ───────────────────

  /**
   * **D4 播种**：把部署级单 Owner（`FEISHU_RECIPIENT_OPEN_ID` + 唯一的 `NOTIFY_OWNER_USERNAMES`）
   * 预绑成一条 `source='env_seed'` 的渠道，让升级日存量用户不至于静默断流。
   *
   * 判据（全部**单调事实**，不含会被业务动作覆写的字段）：
   *   ① 总开关开 ∧ providers 含 feishu ∧ 飞书凭据齐 ∧ `RECIPIENT_OPEN_ID` 非空（前提，缺则静默跳过）；
   *   ② `NOTIFY_OWNER_USERNAMES` **恰好 1 人且解析成功**（0 人 ⇒ `skipped_no_source` throw；≥2 ⇒
   *      `skipped_ambiguous` ERROR 不 throw）；
   *   ③ 该 user **无任意 feishu 行（含 tombstone）**——单调事实，故**解绑过的用户永不复活**；
   *   ④ **全表无该 `recipient_address` 行**——换人拒绝（A 已占 `ou_alice` ⇒ 拒给 B 播种）。
   *
   * throw 纪律（模块两条红线之一）：**throw 的唯一判据 = 补救动作在进程之外**。
   * `skipped_no_source`（有地址无归属，补救 = 改 env）与 `failed`（DB/迁移故障）**抛**；
   * `skipped_ambiguous` / `skipped_address_taken` / `already_seeded` 都是"应用内可补救"
   * ——**打 ERROR 但不阻断启动**（"配错不该让平台起不来"）。
   *
   * 写入：advisory lock 包事务 + `INSERT ... ON CONFLICT DO NOTHING ... RETURNING id`，
   * **只有真的插入**才回填台账（`recipient_user_id` 按 recipient 地址归属）。ON CONFLICT no-op
   * （并发窗口）补一行 INFO。
   *
   * @returns 播种 outcome；前提不满足（未启用 / 无凭据 / 无地址）返回 null（不报错）
   * @throws Error `skipped_no_source`（有地址但无唯一归属）与 `failed`（执行错误）
   */
  async seedFromEnv(): Promise<SeedOutcome | null> {
    const settings = this.settings;
    const recipient = settings.feishuRecipientOpenId;

    // ① 前提（缺任一 ⇒ 静默跳过：这是"没配"，不是"配错"——配置矩阵与 warnings 另有其位）
    if (!settings.enabled) return null;
    if (!settings.providers.includes('feishu')) return null;
    if (!settings.feishuAppId || !settings.feishuAppSecret) return null;
    if (!recipient) return null;

    // ② 归属：**恰好 1 人且解析成功**
    if (settings.ownerUsernames.length === 0) {
      // 有地址无归属 ⇒ 补救动作在进程之外（改 env）⇒ **throw**（.env.example 已写明这个陷阱）
      throw new Error(
        'notify env seed aborted [skipped_no_source]: FEISHU_RECIPIENT_OPEN_ID is set but ' +
          'NOTIFY_OWNER_USERNAMES is empty, so the seeded binding would have no owner. Set ' +
          'NOTIFY_OWNER_USERNAMES to exactly one platform username (or clear ' +
          'FEISHU_RECIPIENT_OPEN_ID to skip seeding). No notification has been lost — existing ' +
          'channel bindings keep working.',
      );
    }
    if (settings.ownerUsernames.length > 1) {
      // 多人 ⇒ 应用内可补救（删掉多余 username）⇒ ERROR 不 throw
      this.logger.error(
        `notify env seed skipped [skipped_ambiguous]: NOTIFY_OWNER_USERNAMES has ` +
          `${settings.ownerUsernames.length} entries; seeding is only attempted when exactly one ` +
          'owner can be attributed to FEISHU_RECIPIENT_OPEN_ID. Seed manually (Settings → ' +
          'Notifications) or reduce the list to one. Startup continues.',
      );
      return 'skipped_ambiguous';
    }
    if (this.seedOwnerActorIds.size !== 1) {
      throw new Error(
        'notify env seed aborted [skipped_no_source]: NOTIFY_OWNER_USERNAMES has exactly one ' +
          `entry but it did not resolve to a live actor (see the warnings above). Fix the ` +
          'username (or clear FEISHU_RECIPIENT_OPEN_ID to skip seeding).',
      );
    }
    const userId = [...this.seedOwnerActorIds][0];

    try {
      // ③ 该 user 无任意 feishu 行（**含 tombstone**）：单调事实 ⇒ 解绑过就永不重播
      const rowsForUser = await this.channelRepo.count({
        where: { userId, provider: 'feishu' },
      });
      if (rowsForUser > 0) {
        this.logger.log(
          `notify env seed skipped [already_seeded]: user ${userId} already has a feishu channel ` +
            'row (including tombstoned ones — an unbound channel is never re-bound silently).',
        );
        return 'already_seeded';
      }

      // ④ 全表无该地址行：换人拒绝（地址是不可枚举的归属证明）
      const rowsForAddress = await this.channelRepo.count({
        where: { provider: 'feishu', recipientAddress: recipient },
      });
      if (rowsForAddress > 0) {
        this.logger.error(
          'notify env seed skipped [skipped_address_taken]: FEISHU_RECIPIENT_OPEN_ID is already ' +
            'bound to another platform account (a different user owns that address). Seeding ' +
            'would cross-wire two people — refused. Unbind it there first (Settings → ' +
            'Notifications) or point the env key at a different address. Startup continues.',
        );
        return 'skipped_address_taken';
      }

      // 播种（advisory lock + 事务 + ON CONFLICT DO NOTHING；仅真插入才回填台账）
      const result = await this.channelRepo.manager.transaction(async (manager) => {
        // 单实例部署下这条锁保护的是"同进程内并发初始化"与"多副本同时启动"两种窗口
        await manager.query('SELECT pg_advisory_xact_lock($1)', [NOTIFY_SEED_ADVISORY_LOCK_KEY]);
        const inserted = (await manager.query(
          `INSERT INTO user_notification_channels
             (user_id, provider, recipient_address, enabled, last_test_status, last_test_address, source)
           VALUES ($1, 'feishu', $2, TRUE, 'seeded', $2, 'env_seed')
           ON CONFLICT DO NOTHING
           RETURNING id`,
          [userId, recipient],
        )) as Array<{ id: string }>;
        if (inserted.length === 0) return { inserted: 0, backfilled: 0 };
        // 回填台账：把历史上发给该地址、尚未归属的行认领到这个用户（只补 NULL，不覆盖已有归属）
        const backfilled = (await manager.query(
          `UPDATE notification_deliveries
              SET recipient_user_id = $1
            WHERE recipient = $2 AND recipient_user_id IS NULL
            RETURNING id`,
          [userId, recipient],
        )) as Array<{ id: string }>;
        return { inserted: 1, backfilled: backfilled.length };
      });

      if (result.inserted === 0) {
        this.logger.log(
          'notify env seed: no-op (a concurrent seed already created the binding) — nothing to do.',
        );
        return 'already_seeded';
      }
      this.logger.log(
        `notify env seed: seeded 1 binding + backfilled ${result.backfilled} deliveries ` +
          `(source=env_seed, user=${userId})`,
      );
      return 'seeded';
    } catch (err) {
      // failed ⇒ 补救在进程之外（DB / 迁移链故障）⇒ throw（红线：启动期解析失败不得**静默**阻断，
      // 但"环境级故障"必须显式暴露——它不可能靠应用内动作修复）
      throw new Error(`notify env seed failed: ${String(err)}`);
    }
  }

  // ─────────────────── 启动诊断（零绑定锚点 / 总闸自洽 / direct 预警） ───────────────────

  /**
   * 启动诊断（plan §D3 配置校验矩阵末段）：**全部不阻断启动**，只留下**可 grep 的锚点**。
   *
   * ① **零绑定锚点**：`ENABLED ∧ providers 非空 ∧ categories 非空 ∧ deliveryEligible 绑定数==0`
   *    ⇒ ERROR + `bound channels: 0`（零绑定是多用户模型**合法的第一天状态**，绝不该崩）；
   * ② **出境总闸自洽 WARN**：`platformLimit < perUserL2 × enabledBindings` ⇒ WARN（关系声明：
   *    N≥5 活跃绑定用户时总闸先于 per-user L2 生效，摘要机制被架空）；
   * ③ **direct 无绑定预警**：direct 开 ∧ **任一** agent creator 无 deliveryEligible 绑定 ⇒ WARN
   *    （数量 + 名单截断）——接替已退役的 `warnDirectWithoutOwner()`（一期那个只在"Owner 名单
   *    解析数为 0"时报；多用户模型下"有些 agent 的人类 owner 根本没绑渠道"才是真实的故障面）。
   */
  private async runStartupDiagnostics(): Promise<void> {
    const settings = this.settings;

    let boundCount: number;
    try {
      // deliveryEligible 谓词**单源**（实体导出的 `deliveryEligibleWhere()`）——
      // 与 GET channels / 批 2 候选查询共用同一份判据，禁止在这里手写第二份
      boundCount = await this.channelRepo.count({ where: deliveryEligibleWhere() });
    } catch (err) {
      // 启动期读库失败不得阻断启动（同 resolveOwners 的红线）
      this.logger.error(`failed to count delivery-eligible channel bindings: ${String(err)}`);
      return;
    }

    if (settings.providers.length > 0 && settings.categories.length > 0 && boundCount === 0) {
      this.logger.error(
        `notifications are ENABLED (${settings.providers.length} provider(s), ` +
          `${settings.categories.length} categor(ies)) but ZERO delivery-eligible channel bindings ` +
          `exist, so no notification can be delivered. bound channels: ${boundCount}. Remedy: bind ` +
          'a channel in Settings → Notifications (or set FEISHU_RECIPIENT_OPEN_ID + exactly one ' +
          'NOTIFY_OWNER_USERNAMES to seed one). Startup is NOT blocked — zero bindings is a legal ' +
          'first-day state of the multi-user model.',
      );
    }

    if (boundCount > 0 && settings.platformRateLimit < settings.globalRateLimit * boundCount) {
      this.logger.warn(
        `NOTIFY_PLATFORM_RATE_LIMIT (${settings.platformRateLimit} per ` +
          `${settings.platformRateWindowSeconds}s) is below the combined per-user L2 capacity ` +
          `(${settings.globalRateLimit} per user × ${boundCount} enabled binding(s)); at this ` +
          'scale the deployment gate fires before the per-user window, so the suppression digest ' +
          'is effectively bypassed. Raise NOTIFY_PLATFORM_RATE_LIMIT or lower ' +
          'NOTIFY_GLOBAL_RATE_LIMIT.',
      );
    }

    if (settings.categories.includes(NOTIFY_CATEGORY.DIRECT)) {
      await this.warnDirectCreatorsWithoutBinding();
    }
  }

  /**
   * `direct` 类别开着、却有 agent 的人类 creator **没有任何 deliveryEligible 绑定** ⇒ WARN
   * （数量 + 名单截断）。
   *
   * 为什么需要它：直发的收件人 = agent 的 `ownerId`（二期批 2 的路由）。若某个 owner 从未绑定
   * 渠道，他名下所有 agent 的直发都会静默降级（批 2 的 `recipient_not_bound`）——启动时把它
   * **点名报出来**，比等用户来问"我的 agent 发的通知去哪了"便宜得多。
   *
   * @returns 无（只打日志；读库失败自吞——启动期红线）
   */
  private async warnDirectCreatorsWithoutBinding(): Promise<void> {
    try {
      // 用 `find({select})` 而不是 queryBuilder+`distinct`：语义相同（去重在 JS 侧做），
      // 且**不依赖 mock 环境提供 distinct**（test-setup 的仓储替身没有它——曾经让本方法在
      // 每个 e2e 里都打一行被自吞的 ERROR，属噪声缺陷）。
      const agents = await this.agentRepo.find({ select: { ownerId: true } });
      const ownerIds = [
        ...new Set(agents.map((agent) => agent.ownerId).filter((id): id is string => Boolean(id))),
      ];
      if (ownerIds.length === 0) return;

      // deliveryEligible 谓词复用同一份单源（`deliveryEligibleWhere()` 展开 + 候选 owner）
      const boundRows = await this.channelRepo.find({
        where: { ...deliveryEligibleWhere(), userId: In(ownerIds) },
        select: { userId: true },
      });
      const bound = new Set(boundRows.map((row) => row.userId));
      const missing = ownerIds.filter((id) => !bound.has(id));
      if (missing.length === 0) return;

      // 名单截断：启动日志不该被一屏人名刷满（数量是主信息，名单只是可定位样本）
      const MAX_NAMES = 10;
      const nameRows = await this.userRepo.find({
        where: { id: In(missing.slice(0, MAX_NAMES)) },
        relations: { actor: true },
      });
      const names = nameRows.map((user) => user.displayName || user.username);
      const suffix = missing.length > MAX_NAMES ? ` …(+${missing.length - MAX_NAMES} more)` : '';
      this.logger.warn(
        `NOTIFY_CATEGORIES enables "direct" but ${missing.length} agent creator(s) have no ` +
          `delivery-eligible channel binding: ${names.join(', ')}${suffix}. Agents owned by them ` +
          'cannot reach them through the direct endpoint until those users bind (and verify) a ' +
          'channel in Settings → Notifications.',
      );
    } catch (err) {
      this.logger.error(`failed to evaluate the direct-without-binding warning: ${String(err)}`);
    }
  }

  /**
   * 消费一次**部署级出境总闸**额度（全局滑动窗口，不按用户分；plan §D3）。
   *
   * 与 `reserveL2ForDirect` 同形（返回"是否放行 / 还要等多久"），但**窗口是全局一个**：
   * 它挡的是"整个部署的外部配额/账单被打穿"，而 L2 挡的是"某个人的手机被刷爆"。
   * ⚠️ 摘要（digest）**豁免总闸**——它是总闸丢弃的补偿信号，被总闸一起吞掉就没人知道发生过丢弃
   * （批 2 接线事件路径时按此纪律）。
   *
   * @returns `{allowed:true}`（已占额）/ `{allowed:false, retryAfterSeconds}`（未占额）
   */
  consumePlatformGate(): { allowed: true } | { allowed: false; retryAfterSeconds: number } {
    const now = Date.now();
    const windowMs = this.settings.platformRateWindowSeconds * 1000;
    let window = this.platformWindow;
    if (!window || now - window.startedAt >= windowMs) {
      window = { startedAt: now, delivered: 0 };
      this.platformWindow = window;
    }
    if (window.delivered < this.settings.platformRateLimit) {
      window.delivered += 1;
      return { allowed: true };
    }
    // 未占额：等窗口滚动后重试即可（额度不被这次失败的尝试吃掉）
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((window.startedAt + windowMs - now) / 1000)),
    };
  }

  /** 停机钩子：清掉 L2 兜底定时器（否则 jest 会因句柄未释放而告警） */
  onModuleDestroy(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  // ─────────────────────────────── 事件挂点 ───────────────────────────────

  /**
   * 统一事件层挂点（`EventService.create` 落库后 emit；见该文件挂点注释）。
   *
   * listener 纪律：① `{async: true}` 不阻塞 `create()` 热路径；② 异常全包自吞只记日志
   * （Nest loader 对回调本就有 try/catch；**真正的崩进程风险是回调内 fire-and-forget 的
   * `void` promise rejection**——见文件头不变量）；③ 一切身份取自事件行（**禁读 ALS**）。
   *
   * @param event 已落库的事件行（`EventService.create` 的 saved 对象）
   */
  @OnEvent('event.created', { async: true })
  async onEventCreated(event: Event): Promise<void> {
    try {
      await this.handleEvent(event);
    } catch (err) {
      // await 链上的异常自吞只记日志（订正后的立论见 event.service.ts 挂点注释）。
      // 这里能兜住的只有"await 链上的异常"；fire-and-forget 分支由 fireAndForget 各自兜。
      this.logger.error(`onEventCreated failed (swallowed): ${String(err)}`);
    }
  }

  /**
   * 管线主体（编号与下方注释一一对应；见文件头 [代码职责]）。
   *
   * @param event 事件行
   */
  private async handleEvent(event: Event): Promise<void> {
    const settings = this.settings;
    // ① 总开关：false ⇒ 一切静默（连日志都不打——"没开"不该在日志里制造噪音）
    if (!settings.enabled) return;

    // ⓪ **写时失效钩子**（Notifications 二期批 2）——**必须早于 ② 的类别过滤**。
    //    理由：订阅的是 `AGENT_JOINED` / `AGENT_LEFT`，它们**不是通知类别**（
    //    `resolveNotificationCategory` 对它们返回 null）⇒ 放在 ② 之后就永远走不到；
    //    而 topic 参与集合变了却不清缓存，会让"刚被移出话题的人"在 ≤60s 内继续收到该话题的通知。
    //    ⚠️ **不看 `actorType`**：人类参与者也发同名事件（topic.service.ts 的 join/leave 两条路径
    //    共用同一对事件），按 actorType 过滤会漏掉人类加入/退出的失效。
    this.invalidateCachesForEvent(event);

    // ② 类别映射（含 §5 的细分判据）→ 白名单过滤
    const category = resolveNotificationCategory(event);
    if (category === null) return;
    if (!settings.categories.includes(category)) return;

    // ③ 收件人解析（**per-candidate 双层判据**：安全层 read ∧ 注意力层；含自回声与类别偏好）。
    //    一期这里是"owner 集合自回声 + owner 是否参与话题 + 单一收件人"三步，现已整体由
    //    `resolveRecipients` 接替（多用户模型的唯一收件人来源）。
    const recipients = await this.resolveRecipients(event, category);
    if (recipients.length === 0) {
      // 每个类别只报一次：零候选既可能是"这个部署还没人绑渠道"，也可能是"路由判据把所有人
      // 都拦掉了"——两者的处置完全不同，运维需要这一行来分辨（且不该每条事件刷一行）。
      if (!this.zeroCandidateNoted.has(category)) {
        this.zeroCandidateNoted.add(category);
        this.logger.log(
          `no recipient [zero_candidates] category=${category} eventId=${event.id} — nobody ` +
            'passed the two-layer routing criteria (readable ∧ interested) for this event. ' +
            'Reported once per category.',
        );
      }
      return;
    }

    // ④ L1 节流（**逐收件人**：键 = `<资源分量>:<userId>`，见 `l1Key` 的三处取舍）。
    //    ⚠️ TTL 按类别取一次即可（窗口长度与收件人无关），**键在循环内按人拼**。
    //    ⚠️ **检查与标记是两段式的（非原子）**：循环里只做"查"，真正的"标记"在该收件人**渲染
    //    成功之后**（见下方 ⑤）。并发事件可能都通过检查 ⇒ 偶发多投一条；这是有意接受的代价，
    //    真正的兜底是 **L2 per-user 窗口**（多投的那条仍受它约束）。
    const l1TtlMs = this.l1TtlMs(category);

    // ⑤ 逐收件人：check → 渲染（回库取出境字段）→ 占 L1 窗口 → 总闸 → L2 记账 → 投递。
    //    顺序即语义（plan §D3「节流泛化」的字面顺序），三处不能换：
    //    ① **check 在渲染前**：命中就不必为一无所获的渲染回库（L1 是"省事"的那道闸）；
    //    ② **mark 在渲染后**：渲染失败（资源已被删的幻影事件）不该占用窗口（NOTIFY-L1-MARK-ON-FAILURE）；
    //    ③ **总闸在 L2 前**：总闸是**部署级**的更外层的闸（plan §5 的关系声明：N≥5 个活跃绑定用户时
    //       总闸先于 per-user L2 生效），先过它就等于"整个部署的额度没被打穿，才轮到算某个人的账"。
    //    ⚠️ **资源缺失（渲染返回 null）= 幻影事件 ⇒ 直接结束整条事件**（不是"这个收件人跳过"）：
    //    资源行不存在是事件本身的属性，与收件人无关，且此刻**不占 L1 窗口**（检查前置、标记后置）。
    for (const recipient of recipients) {
      const l1Key = l1TtlMs === null ? null : this.l1Key(category, event, recipient.userId);
      if (l1Key !== null && l1TtlMs !== null && this.l1.get(l1Key) !== undefined) {
        this.logger.log(
          `suppressed [l1_throttle] category=${category} eventId=${event.id} ` +
            `recipient=${recipient.userId} l1Key=${l1Key}`,
        );
        continue;
      }

      const address = recipient.channels[0].recipientAddress;
      const rendered = await this.render(category, event, address);
      // ⚠️ **`rendered === null` ⇒ 结束整条事件（不是跳过这个收件人）**，前提是 `render()` 的
      //    null 语义**只取决于资源行与 category**（资源行不存在 = 幻影事件），而**与收件人无关**
      //    ——它虽然把 `recipient` 写进出境面（地址是 per-user 的），但"返回 null 还是返回通知"
      //    这一点不由地址决定。故第一个人拿到 null 时后面的人必然也是 null，提前 return 不会
      //    漏投。**若将来 render 对某个收件人返回 null**（例如按人做静音/降级渲染），这里必须
      //    改成 `continue`。
      if (rendered === null) return;
      // ⚠️ **L1 标记在总闸之前 ⇒ 总闸丢弃会白占一次 L1 窗口**（MINOR-5，显式声明）：这一条
      //    candidate 刚被记进 L1 窗口、随即被总闸丢掉（它没投出去，而窗口已占 ⇒ 同一资源、
      //    同一个人在这个窗口内的**下一条**通知会被 L1 压掉）。
      //    为什么可以接受：① 它**不是无声的**——被丢的那条已计入该用户的 L2 suppressed，摘要里
      //    有它的计数；② 换成"总闸过了再标 L1"会让"同一份渲染结果在标记前被两次不同事件重复
      //    消费"（L1 的两段式本来就非原子，见文件头），代价更大；③ 总闸持续超额的场景下
      //    （N≥5 绑定用户）本来就该调大 NOTIFY_PLATFORM_RATE_LIMIT，而不是靠 L1 的语义去救。
      if (l1Key !== null && l1TtlMs !== null) this.l1.set(l1Key, true, l1TtlMs);

      // ⑤' **部署级出境总闸**（plan §D3）：超额 ⇒ 这个候选被丢弃，但要"看得见"——
      //     计入**该用户**的 L2 suppressed 分布（于是它会出现在那个人的摘要里）+ 带 eventId 的
      //     INFO + 按窗口限频的 WARN（见 `notePlatformGateDrop`）。
      //     ⚠️ **摘要本身豁免总闸**（它不经过这里，也不经过 `consumePlatformGate`）：它是总闸
      //     丢弃的**补偿信号**，被总闸一起吞掉就没人知道发生过丢弃。
      //     ⚠️ **总闸在 L2 之前**（plan §5 的关系声明：N≥5 个活跃绑定用户时总闸先于 per-user L2
      //     生效）。代价显式声明：额度在"这一次决定投递"时就被占掉，**即使紧随其后的 L2 把这
      //     条缓冲进摘要**（那次预算没换来一次真实出境）。这是刻意的顺序选择——反过来（先 L2
      //     后总闸）会让"总闸"变成对 L2 放行量的二次裁剪，而 plan 把总闸定义为**更外层的闸**
      //     （"整个部署的额度有没有被打穿"先于"某个人的手机别被刷爆"）。
      const gate = this.consumePlatformGate();
      if (!gate.allowed) {
        this.notePlatformGateDrop(event, category, recipient.userId, gate.retryAfterSeconds);
        continue;
      }

      // L2 per-user 窗口（键 = **userId**；投递地址取自该用户快照的 `channels[0]`——批 2 棒 B
      // 的点名改造）。`direct` 不在这里（不经 L1，也不经事件链路的 L2 合并语义）。
      // ⚠️ `consumeL2` 把**窗口本身**交出来（不只是判决）：后续的 flush 与台账归属都从窗口
      // 对象上取事实，不再靠"调用方记得刚才用的是哪个 userId"（MINOR-4）。
      const { verdict, window: l2Window } = this.consumeL2(recipient.userId, category);
      if (verdict === 'buffered') {
        this.logger.log(
          `suppressed [l2_window] category=${category} eventId=${event.id} ` +
            `recipient=${recipient.userId} — buffered into the digest`,
        );
        this.fireAndForget(this.flushDigestIfNeeded(l2Window, false), 'l2 digest flush');
        continue;
      }
      // 台账归属列（`notification_deliveries.recipient_user_id`）由 `recipient.userId` 供给；
      // 出口按该收件人绑定的渠道收窄（`channels[0].provider`，见 `deliver` 的注释）
      await this.deliver(rendered, recipient.userId, recipient.channels[0].provider);
    }
  }

  /**
   * 总闸超额丢弃一个候选时的**记账与观测**（三件事缺一不可，见文件头 [关键不变量]）。
   *
   * ① **计入该用户的 L2 suppressed 分布**：总闸丢的条目若不进摘要，那个人的摘要就会撒谎
   *    （"另有 N 条"少算了总闸丢掉的这批）；而摘要是总闸丢弃**唯一的补偿信号**。
   * ② **一条带 `eventId` 的 INFO**：投递表只落终态、抑制类不落表 ⇒ 逐条对账只能靠它
   *    （`grep "dropped \[platform_gate\]"`）。
   * ③ **按窗口限频的 WARN（带累计条数）**：总闸触发往往成批丢弃，逐条 WARN 会把日志冲垮
   *    （见 `platformGateDropped` 的字段注释）。
   *
   * @param event 事件行（日志对账锚点）
   * @param category 类别（进 suppressed 分布的桶）
   * @param userId 被丢弃候选的收件人
   * @param retryAfterSeconds 总闸窗口剩余秒数（窗口何时再开）
   */
  private notePlatformGateDrop(
    event: Event,
    category: NotifyCategory,
    userId: string,
    retryAfterSeconds: number,
  ): void {
    const window = this.windowFor(userId, Date.now());
    window.suppressed.set(category, (window.suppressed.get(category) ?? 0) + 1);

    this.logger.log(
      `dropped [platform_gate] category=${category} eventId=${event.id} recipient=${userId} ` +
        `retryAfter=${retryAfterSeconds}s`,
    );

    this.platformGateDropped += 1;
    const now = Date.now();
    if (now - this.platformGateWarnedAt >= this.settings.platformRateWindowSeconds * 1000) {
      this.logger.warn(
        `deployment egress gate is DROPPING notifications: ${this.platformGateDropped} candidate(s) ` +
          `dropped in the last ${this.settings.platformRateWindowSeconds}s (NOTIFY_PLATFORM_RATE_LIMIT ` +
          `= ${this.settings.platformRateLimit} per window). Those events are counted into each ` +
          'recipient\u2019s suppression digest (they will arrive as "另有 N 条"). Raise ' +
          'NOTIFY_PLATFORM_RATE_LIMIT or lower NOTIFY_GLOBAL_RATE_LIMIT if this is not intended.',
      );
      this.platformGateWarnedAt = now;
      this.platformGateDropped = 0;
    }
  }

  // ─────────────────────── 写时失效钩子（Notifications 二期批 2） ───────────────────────

  /**
   * 事件驱动的缓存失效（**唯一订阅点**；由 `handleEvent` 在类别过滤之前调用）。
   *
   * 订阅面刻意只有一条：`resourceType = TOPIC ∧ eventType ∈ {AGENT_JOINED, AGENT_LEFT}`
   * （topic 参与集合正是被它改变的）。**board 成员变更事件不接**——本编排器没有任何
   * "board 成员集合"缓存可失效（权限每事件定向查询，零缓存），接了就是一条**永不生效的死线**。
   *
   * ⚠️ **不看 `actorType`**：人类加入/退出话题走的是同一对事件（`topic.service.ts` 三处 emit
   * 共用），按 actorType 过滤会漏掉人类参与者的失效。
   *
   * 残留（显式接受，见文件头）：agent 被删（owner 关系变化）≤60s、topic 加入 ≤60s 由 TTL 自愈。
   *
   * @param event 事件行
   */
  private invalidateCachesForEvent(event: Event): void {
    if (event.resourceType !== ResourceType.TOPIC) return;
    if (event.eventType !== EventType.AGENT_JOINED && event.eventType !== EventType.AGENT_LEFT) {
      return;
    }
    const topicId = event.resourceId;
    if (!topicId) return;
    this.invalidateTopic(topicId);
  }

  /**
   * **失效某个用户的快照**（写路径的动作面：渠道绑定 / 类别偏好 / 测试态变更后调用）。
   *
   * 幂等且廉价（纯内存删键）——写路径可以无条件调用，不必先判断"这一行有没有进过快照"。
   *
   * ⚠️ **在途那一份也必须摘牌**（MAJOR-1，2026-10-13 复核）。只删缓存键会漏掉这条时序：
   *   ① 事件 A 触发快照重建（在途，正在读的是**写前**的事实）；
   *   ② 写路径把用户解绑 / 改偏好，然后调本方法；
   *   ③ 此刻缓存里**还没有**这个键 ⇒ `snapshots.delete` 是 no-op；
   *   ④ 重建落地，把"写前"的快照写回缓存并带上 60-70s 的 TTL
   *   ⇒ **解绑后仍按旧绑定继续投递**，一直到 TTL 过期（"解绑 = 通知立即停止"被绕开一分钟）。
   *   摘牌后，落地守卫（见 `loadUserSnapshot`）就认得出"这一份已经作废"，不写缓存。
   *
   * ⚠️ **等待者仍会拿到那份 promise 的值**：single-flight 的语义是"共享同一次重建"，不是
   *   "可取消"——把它从等待者手里抽走会造出一个**永不落地**的 promise（先例见字段注释）。
   *   故本方法只做"摘牌"，不做"作废"。
   *
   * ⚠️ **本修复关掉的只是"陈旧值被缓存 60-70s"这一半**：正在处理的那一次事件自己读到的
   *   仍是写前的事实（in-flight 竞争不可避免——写路径的 DB 提交与内存缓存的摘牌之间没有
   *   可以跨越的事务边界）。下一次 `loadUserSnapshot` 会重新重建、拿到新事实。这条残留
   *   窗口已声明进文件头 [关键不变量] 的"缓存残留"一条。
   *
   * @param userId 平台用户 id
   */
  invalidateUser(userId: string): void {
    this.snapshots.delete(userId);
    this.snapshotInFlight.delete(userId);
  }

  /**
   * **失效某个话题的参与集合**（topic join/leave 事件与人工干预的动作面）。
   *
   * @param topicId 话题 id
   */
  invalidateTopic(topicId: string): void {
    this.topicParticipation.delete(topicId);
  }

  // ─────────────────────────────── owner 解析 ───────────────────────────────

  /**
   * 解析 `NOTIFY_OWNER_USERNAMES` → actorId（**启动一次，冻结**；批 2 棒 B 起只服务 D4 播种）。
   *
   * 判据：`users.username IN (...)` **且** `actors.deleted_at IS NULL`（"未软删 actor"）。
   * `users.id` 即 `actors.id`（PK = FK），故 username 命中的用户 id 就是 actorId。
   * ⚠️ 这里用 `innerJoin('user.actor')` + 显式 `actor.deleted_at IS NULL`：`User` 实体本身
   * **没有** `@DeleteDateColumn`（只有 delegating getter），软删事实在 `actors` 行上；
   * 显式写条件比依赖 ORM 对 join 的软删过滤更可靠（且不触碰 ActorProfileService 的
   * `withDeleted + addSelect('actor.deletedAt')` 收口纪律——那是"读出 deletedAt"，这里是"过滤"）。
   *
   * ⚠️ **这份名单唯一的用途是 D4 播种**（见 `seedOwnerActorIds` 的注释）：它**不参与**收件人
   * 路由（那由 `resolveRecipients` 的 per-candidate 判据回答），也**不参与**直发收件人
   * （那由 `agent.ownerId` 决定）。
   *
   * 未命中的 username 逐个 warning（拼错与软删两态合并——对运维而言正确动作相同）；
   * 收尾打一行 INFO `owner actors resolved n/N`（**可 grep 的启动自检锚点**）。
   */
  async resolveOwners(): Promise<void> {
    this.seedOwnerRequested = this.settings.ownerUsernames.length;
    if (this.seedOwnerRequested === 0) return;

    try {
      const rows = await this.userRepo
        .createQueryBuilder('user')
        .innerJoin('user.actor', 'actor')
        .where('user.username IN (:...usernames)', { usernames: this.settings.ownerUsernames })
        .andWhere('actor.deleted_at IS NULL')
        .select(['user.id AS id', 'user.username AS username'])
        .getRawMany<{ id: string; username: string }>();

      const resolved = new Map<string, string>();
      for (const row of rows) resolved.set(row.username, row.id);

      for (const username of this.settings.ownerUsernames) {
        const actorId = resolved.get(username);
        if (actorId) {
          this.seedOwnerActorIds.add(actorId);
        } else {
          this.logger.warn(
            `NOTIFY_OWNER_USERNAMES: "${username}" did not resolve to a live actor (unknown ` +
              'username or soft-deleted) — env seeding will be skipped for it. This list is ' +
              'used ONLY by env seeding; recipient routing is per-candidate and the direct ' +
              'endpoint routes to the calling agent\u2019s owner.',
          );
        }
      }

      // 启动自检锚点（`.env.example` 的生效自检按这一行筛）
      this.logger.log(
        `owner actors resolved ${this.seedOwnerActorIds.size}/${this.seedOwnerRequested}`,
      );
    } catch (err) {
      // 启动期解析失败**不得阻断启动**（通知是可选出口；fail-fast 只在 config 的 production 矩阵）
      this.logger.error(
        `failed to resolve NOTIFY_OWNER_USERNAMES (notifications stay enabled but env seeding ` +
          `will not run): ${String(err)}`,
      );
    }
  }

  /**
   * 读某个话题的 **active 参与者 id 集合**（per-topic 缓存 60s；一条查询喂饱全部候选）。
   *
   * 口径对齐 `roundtable.service.ts` 的座位过滤：`status = ParticipantStatus.ACTIVE`
   * （`invited` / `left` 都不算"参与"）。**注意这里同时是 topic 类别的安全层**——
   * 比 read 权限更严（"参与"是比"可读"更高的门槛），有意为之。
   *
   * 缓存失效走两条路：① 写时钩子（topic join/leave 事件，见 `invalidateCachesForEvent`）；
   * ② TTL 60s 兜底（覆盖 `invalidateTopic` 未触达的路径，例如直接改库）。
   *
   * @param topicId 话题 ID
   * @returns active 参与者 id 集合（**含 agent 与人类**——候选侧再过一次 userId 交集即可）
   */
  private async loadTopicParticipants(topicId: string): Promise<ReadonlySet<string>> {
    const cached = this.topicParticipation.get(topicId);
    if (cached !== undefined) return cached;

    const rows = await this.topicParticipantRepo.find({
      where: { topicId, status: ParticipantStatus.ACTIVE },
      select: { participantId: true },
    });
    const participants: ReadonlySet<string> = new Set(rows.map((row) => row.participantId));
    this.topicParticipation.set(topicId, participants, TOPIC_PARTICIPATION_TTL_MS);
    return participants;
  }

  // ───────────────── 收件人解析（Notifications 二期双层判据） ─────────────────

  /**
   * **收件人解析**（plan §D3 的核心；一期那个"部署级单 Owner"的唯一接替者）。
   *
   * 三层过滤，顺序即成本（便宜的先做，贵的后做）：
   *   ① **候选集合**：所有"有 deliveryEligible 绑定 ∧ actor 未软删"的人类用户（**一条查询**）；
   *   ② **人的维度**（纯内存，零查询）：自回声（自己 / 自己的 agent 触发）与**类别偏好**
   *      （用户关掉的类别不推）——先砍掉人，后面的资源判据只需对剩下的人算；
   *   ③ **资源维度**（每事件固定条数，**与候选人数无关**）：
   *      - `topic`：active 参与者集合命中（缓存命中 0 查询）；
   *      - `task_*`：安全层 `resolveBoardAccess.readableUserIds`（orphan task 免判）∧ 注意力层
   *        （成员 ∪ creator ∈ {me, 我的 agents} ∪ assignee 命中）；
   *      - `doc_*`：安全层 `resolveSpaceAccess.readableUserIds`（`doc_deleted` 用 withDeleted
   *        变体）∧ 注意力层（space creator/member ∪ doc creator ∈ {me, 我的 agents}）。
   *
   * ⚠️ **`direct` 不经本方法**（返回空数组）：直发的收件人 = agent 的 `ownerId`，路由在直发
   * 链路里（批 2 棒 B）；事件管线根本不会以 `direct` 调到这里（它没有事件类别映射）。
   *
   * ⚠️ **双层判据的语义**：安全层挡**越权**（把私有看板的标题推到无权读的人手机上），
   * 注意力层挡**噪音**（open 资源全网可见 ⇒ 只对"成员/归属/被指派"的人推）。
   * 两层都过才推；**注意力层命中不豁免安全层**（assignee 被移出私有看板后无权读 ⇒ 不推）。
   *
   * @param event 事件行
   * @param category 已解析的类别（non-null；调用方保证）
   * @returns 通过判据的收件人列表（空 = 本事件无人该收）
   */
  async resolveRecipients(event: Event, category: NotifyCategory): Promise<NotifyRecipient[]> {
    if (category === NOTIFY_CATEGORY.DIRECT) return [];

    // ① 候选集合（一条查询；见 `loadCandidateUserIds`）
    const candidateIds = await this.loadCandidateUserIds();
    if (candidateIds.length === 0) return [];

    // ② 人的维度：快照（single-flight）+ 自回声 + 类别偏好
    const snapshots = await this.loadSnapshots(candidateIds);
    const pool = snapshots.filter(
      (snapshot) => !this.isSelfEcho(event.actorId, snapshot) && snapshot.prefs[category] === true,
    );
    if (pool.length === 0) return [];

    // ③ 资源维度（每类别各一次，条数与 pool.length 无关）
    switch (category) {
      case NOTIFY_CATEGORY.TOPIC:
        return this.routeTopic(event, pool);
      case NOTIFY_CATEGORY.TASK_DONE:
      case NOTIFY_CATEGORY.TASK_CREATED:
      case NOTIFY_CATEGORY.TASK_UPDATED:
      case NOTIFY_CATEGORY.TASK_ASSIGNED:
        return this.routeTask(event, pool);
      case NOTIFY_CATEGORY.DOC_CREATED:
      case NOTIFY_CATEGORY.DOC_UPDATED:
      case NOTIFY_CATEGORY.DOC_DELETED:
      case NOTIFY_CATEGORY.DOC_MOVED:
        return this.routeDoc(event, category, pool);
      default:
        // `direct` 已在上方返回；其余 token 不在事件映射值域内（防御性）
        return [];
    }
  }

  /**
   * 候选用户集合：**有 deliveryEligible 绑定 ∧ actor 未软删**（一条查询）。
   *
   * 为什么把"软删过滤"写进查询而不是查完再过滤：`resolveBoardAccess` 一族的候选集合**由调用方
   * 保证已过滤软删 actor**（见 access-query.service.ts 文件头的义务声明）——软删用户的旧绑定
   * 若被当活候选，就是"给一个已经不存在的账号推通知"（且它的 role/成员关系可能仍然残留）。
   *
   * ⚠️ **必须是 INNER JOIN，不能用 `find` 的关系 where**（2026-10-13 实测踩坑）：
   * `find({ where: { ...predicate, user: { actor: { deletedAt: IsNull() } } } })` 生成的 SQL 是
   * `LEFT JOIN actors a ON a.id = u.id AND (a.deleted_at IS NULL) WHERE ... AND a.deleted_at IS NULL`
   * —— 关系条件被折叠进 **ON 子句**，而 LEFT JOIN 未命中时 `a.*` 全为 NULL ⇒ **WHERE 那半永远成立**
   * ⇒ 软删用户照样是候选（`NOTIFY-CANDIDATE-SOFTDELETED-LEAK`）。INNER JOIN 让 ON 子句的过滤
   * 变成**排他**的（这正是我们想要的语义）。
   *
   * 谓词仍是**单源**：`where(deliveryEligibleWhere())` 展开的正是 `find` 内部用的同一个对象
   * （TypeORM 的 `find` 本身就是"造一个 QB 再 where 这个对象"），故这里没有第二份三元组。
   *
   * @returns 去重后的候选用户 id 列表（无候选 = 空数组，不是错误）
   */
  private async loadCandidateUserIds(): Promise<string[]> {
    const rows = await this.channelRepo
      .createQueryBuilder('channel')
      // INNER：关系未命中即整行出局（见上方 ⚠️）
      .innerJoin('channel.user', 'user')
      .innerJoin('user.actor', 'actor')
      // 谓词单源（禁手写第二份 `enabled ∧ unbound_at ∧ last_test_status`）
      .where(deliveryEligibleWhere())
      // 软删过滤：`users` 表本身**没有** deleted_at（软删事实在 actors 行上），必须显式写
      .andWhere('actor.deleted_at IS NULL')
      .select('channel.user_id', 'userId')
      .getRawMany<{ userId: string }>();
    return [...new Set(rows.map((row) => row.userId))];
  }

  /**
   * 批量取快照（single-flight；**单个候选重建失败只跳过该候选**，不拖垮整条事件）。
   *
   * 为什么失败要跳过而不是整体失败：一次 DB 抖动不该让"这一个类别下所有人的通知"全灭；
   * 而该用户的快照既没进缓存（构建抛错就不写）也没留在途表（finally 清位），**下一个事件会
   * 重新尝试**——这正是"暂时不可用"而非"永久静默"的语义。
   *
   * @param userIds 候选用户 id
   * @returns 成功构建的快照（失败的被丢弃；顺序与入参一致）
   */
  private async loadSnapshots(userIds: string[]): Promise<NotifyUserSnapshot[]> {
    const settled = await Promise.all(
      userIds.map(async (userId) => {
        try {
          return await this.loadUserSnapshot(userId);
        } catch (err) {
          this.logger.warn(
            `failed to build the notification snapshot for user ${userId} (this event skips ` +
              `them; the next event retries): ${String(err)}`,
          );
          return null;
        }
      }),
    );
    return settled.filter((snapshot): snapshot is NotifyUserSnapshot => snapshot !== null);
  }

  /**
   * 取（或重建）一个用户的快照 —— **single-flight**（并发共享同一次重建）。
   *
   * 三段：命中缓存 → 命中在途 promise → 起一次重建并登记在途。⚠️ 在途表**必须 finally 清位**
   * （含 rejected，且必须判"是不是我这一份"）——否则一次失败的构建会把该用户永久钉在失败
   * 结果上（见字段注释）。
   *
   * ⚠️ **落地前必须重判"这一份还在途表里吗"**（MAJOR-1，2026-10-13 复核）：`.then` 无条件写缓存
   * 会让一份被 `invalidateUser` 摘过牌的重建（它读的是**写前**的事实）把陈旧值写回缓存并保留
   * 60-70s——"解绑 = 通知立即停止"被绕开一分钟。判据 `snapshotInFlight.get(userId) === pending`
   * 同时覆盖两种情形：① 已被摘牌（写前数据，**不写**）；② 已过期被新的重建顶替
   * （同样不写，让新的那一份落地）。
   *
   * 缓存 TTL 带抖动：`USER_SNAPSHOT_TTL_MS + rand × JITTER`（防全量快照同秒到点引发的
   * 重建 stampede）。
   *
   * @param userId 用户 id
   * @returns 快照（**不返回 null**：channels 为空时抛错，由 `loadSnapshots` 跳过该候选）
   */
  private async loadUserSnapshot(userId: string): Promise<NotifyUserSnapshot> {
    const cached = this.snapshots.get(userId);
    if (cached !== undefined) return cached;

    const inFlight = this.snapshotInFlight.get(userId);
    if (inFlight) return inFlight;

    const ttlMs = USER_SNAPSHOT_TTL_MS + Math.floor(Math.random() * USER_SNAPSHOT_TTL_JITTER_MS);
    // `pending` **自引用**（两个回调都要问"在途表里还是不是我这一份"）。const 自引用在此合法：
    // 闭包内的引用由 promise 回调承载（永不同步执行，最早也是赋值完成后的微任务），
    // 只有"初始化表达式内立即求值"才会触发 TDZ——本处无此路径。
    const pending: Promise<NotifyUserSnapshot> = this.buildUserSnapshot(userId)
      .then((snapshot) => {
        if (this.snapshotInFlight.get(userId) === pending) {
          this.snapshots.set(userId, snapshot, ttlMs);
        }
        return snapshot;
      })
      .finally(() => {
        // single-flight 契约的闭合点：无论成功/失败，**在途表必须回到空位**。
        // ⚠️ 但要判"是不是我这一份"：否则会把 `invalidateUser` 之后**新起**的那一份从表里
        //    误删（那一份的等待者还在等着复用同一次重建）。
        if (this.snapshotInFlight.get(userId) === pending) {
          this.snapshotInFlight.delete(userId);
        }
      });
    this.snapshotInFlight.set(userId, pending);
    return pending;
  }

  /**
   * 重建一个用户的快照（**4 条查询/用户**；**冷路径**的唯一 O(N) 来源，见性能承诺）。
   *
   * ⚠️ **是 4 条不是 3 条**（2026-10-13 复核实测订正）：`channelRepo.find`（1）+
   * `userRepo.findOne`（**2**——`User.actor` 是 `{eager:true}` 的 `@OneToOne`，TypeORM 会为
   * 这条 eager 关系**再发一条** join 查询）+ `agentRepo.find`（1）。这条账要写准，否则
   * "查询数"类的断言会按错的基数去推（先例：`test/notify-routing.e2e-spec.ts` 的计数用例）。
   *
   * ⚠️ 四条都是"用户可自改的配置"，**没有一条是权限**（权限集合与 role 刻意不进快照）。
   *
   * @param userId 用户 id
   * @returns 快照
   * @throws NotifyNoEligibleChannelError 该用户**此刻没有任何 deliveryEligible 绑定**
   *   （候选资格在快照构建期间丢掉了——用户刚解绑 / 刚静音）；事件链路按"这个候选跳过本事件"
   *   处置，直发链路按 `recipient_not_bound` 处置
   */
  private async buildUserSnapshot(userId: string): Promise<NotifyUserSnapshot> {
    const [channelRows, user, agents] = await Promise.all([
      // ① deliveryEligible 绑定（**谓词单源**；禁投/未验证/tombstone 行不进快照）
      this.channelRepo.find({
        where: { ...deliveryEligibleWhere(), userId },
        order: { createdAt: 'ASC' },
      }),
      // ② 类别偏好（`users.preferences.notificationCategories`；读取归一含缺省基座）
      this.userRepo.findOne({ where: { id: userId } }),
      // ③ 我的 agent（owner-proxy：自回声与注意力层的"我的 agent"分量）。不做 partial select
      //    （Agent 带 eager actor 关系，见 owner-proxy.service.ts 的同款取舍）
      this.agentRepo.find({ where: { ownerId: userId } }),
    ]);

    if (channelRows.length === 0) {
      // 专用类型（不是普通 Error）：直发链路要把它与"库读不到"分开（见该类的注释）
      throw new NotifyNoEligibleChannelError(
        `user ${userId} has no delivery-eligible channel binding`,
      );
    }

    const preferences = (user?.preferences ?? {}) as Record<string, unknown>;
    return {
      userId,
      channels: channelRows.map((row) => ({
        provider: row.provider,
        recipientAddress: row.recipientAddress,
      })),
      prefs: normalizeNotificationCategories(preferences['notificationCategories']),
      agentIds: new Set(agents.map((agent) => agent.id)),
    };
  }

  /**
   * per-candidate 自回声：**自己触发的事件不通知自己**。
   *
   * 判据 = `event.actorId === 我` ∪ `event.actorId ∈ 我的 agents`（owner-proxy 语义：agent 是
   * 我的人在平台上做事的身份）。一期"human 自回声依赖 `NOTIFY_OWNER_USERNAMES`"的缺口在这里
   * **天然闭合**——判据不再需要一份全局 owner 名单，而是"谁在收，就按谁的身份判"。
   *
   * ⚠️ **`direct` 不适用"我的 agent"泛化**（那是直发链路的例外语义，见 plan §D3）：否则 agent
   * 通过直发端点给自己的人类 owner 发消息会被"我的 agent 触发"吞掉——调用方拿到 200 却没人收到。
   * 本方法只服务事件管线（`direct` 类别在 `resolveRecipients` 开头就返回）。
   *
   * @param actorId 事件行的 actorId（可空）
   * @param snapshot 候选用户快照
   * @returns true = 这是"我自己做的事"，跳过
   */
  private isSelfEcho(actorId: string | null | undefined, snapshot: NotifyUserSnapshot): boolean {
    if (!actorId) return false;
    return actorId === snapshot.userId || snapshot.agentIds.has(actorId);
  }

  /**
   * `topic` 类别的路由：**候选 ∩ active 参与者**（参与即注意力，见 plan §D3 逐类别表）。
   *
   * 安全层与注意力层在 topic 上是**同一个判据**且比 read 更严：只有"参与了这场讨论"的人才被
   * 打扰——这是刻意的（话题是讨论场，不是文档库；旁观者不该被推）。故这里不调
   * `resolveTopicAccess` 一类的方法（本仓也没有）。
   *
   * @param event 事件行
   * @param pool 已过自回声与偏好的候选快照
   * @returns 收件人
   */
  private async routeTopic(event: Event, pool: NotifyUserSnapshot[]): Promise<NotifyRecipient[]> {
    if (!event.topicId) return [];
    const participants = await this.loadTopicParticipants(event.topicId);
    return pool
      .filter((snapshot) => participants.has(snapshot.userId))
      .map((snapshot) => this.toRecipient(snapshot));
  }

  /**
   * `task_*` 类别的路由（双层判据；plan §D3 逐类别表逐字）。
   *
   * 安全层：`resolveBoardAccess.readableUserIds`；**orphan task（无 board）按 public 免判**
   * （`task.policy.ts` 的 `if (!task.listId) return true` 同口径）。
   * 注意力层：`memberUserIds ∋ me` ∪ `creatorActorId ∈ {me, 我的 agents}` ∪ assignee 命中
   * （`assignee_id ∈ {me} ∪ 我的 agents`）——**assignee 命中仍须先过安全层**。
   *
   * 查询形状（每事件固定条数，与候选人数无关）：task 行 1（带 list 关系取 boardId）+
   * 看板剖面 1 次调用（其内部 3 条：行 + role + members）。
   *
   * @param event 事件行（resourceId = taskId）
   * @param pool 已过自回声与偏好的候选快照
   * @returns 收件人
   */
  private async routeTask(event: Event, pool: NotifyUserSnapshot[]): Promise<NotifyRecipient[]> {
    if (!event.resourceId) return [];
    // 带 `list` 关系取 boardId：不能信 `event.boardId`（task.service.ts 明写它是**可选键**，
    // "拿不到就省键" ⇒ 依赖它会让一批任务通知静默漏判）
    const task = await this.taskRepo.findOne({
      where: { id: event.resourceId },
      relations: { list: true },
    });
    if (!task) return []; // 幻影事件（行已硬删 / 事务回滚）

    const boardId = task.list?.boardId ?? null;
    const poolIds = pool.map((snapshot) => snapshot.userId);
    const profile = boardId ? await this.accessQuery.resolveBoardAccess(boardId, poolIds) : null;
    // 板行不存在（已硬删）⇒ 与 orphan 同处置（按 public 免安全层），而不是整条丢弃
    const safety = profile === null ? null : profile.readableUserIds;

    return pool
      .filter((snapshot) => {
        if (safety !== null && !safety.has(snapshot.userId)) return false; // 安全层
        if (profile !== null) {
          if (profile.memberUserIds.has(snapshot.userId)) return true; // 成员
          if (this.isCreatorHit(profile.creatorActorId, snapshot)) return true; // creator（含 owner-proxy）
        }
        return this.isAssigneeHit(task.assigneeId, snapshot); // 被指派者
      })
      .map((snapshot) => this.toRecipient(snapshot));
  }

  /**
   * `doc_*` 类别的路由（双层判据；plan §D3 逐类别表逐字）。
   *
   * 安全层：`resolveSpaceAccess.readableUserIds`——**`doc_deleted` 用 `withDeleted` 变体**：
   * 整空间删除时空间行也已软删，不带 withDeleted 会让"读权限"判成全灭（该通知本意正是告诉
   * 人们这个空间的东西没了）。
   * 注意力层：`space.creator ∈ {me, 我的 agents}` ∪ `space_members ∋ me` ∪
   * `docs.created_by ∈ {me, 我的 agents}`（**doc 行 1 次 withDeleted 查询**：`doc_deleted` 的行
   * 已被软删，不带 withDeleted 取不到 `spaceId` / `createdBy`）。
   *
   * @remarks 为什么 doc 也用 withDeleted 读行：与渲染层"只信事件载荷"**不冲突**——渲染层不查行是
   * 为了不改动出境字段的取值来源；路由需要的是"这条 doc 属于哪个空间、谁建的"，而那是**历史事实**
   * （行软删不改变它，同 `resolveDocSpaceName` 的口径）。
   *
   * @param event 事件行（resourceId = docId）
   * @param category 类别（决定空间剖面的 withDeleted 变体）
   * @param pool 已过自回声与偏好的候选快照
   * @returns 收件人
   */
  private async routeDoc(
    event: Event,
    category: NotifyCategory,
    pool: NotifyUserSnapshot[],
  ): Promise<NotifyRecipient[]> {
    if (!event.resourceId) return [];
    const doc = await this.docRepo.findOne({
      where: { id: event.resourceId },
      withDeleted: true,
    });
    if (!doc) return []; // 幻影事件（连软删行都没有）

    const poolIds = pool.map((snapshot) => snapshot.userId);
    const profile = await this.accessQuery.resolveSpaceAccess(doc.spaceId, poolIds, {
      withDeleted: category === NOTIFY_CATEGORY.DOC_DELETED,
    });
    if (profile === null) return []; // 空间行不存在（未软删也没有）⇒ 无判据可用

    return pool
      .filter((snapshot) => {
        if (!profile.readableUserIds.has(snapshot.userId)) return false; // 安全层
        if (this.isCreatorHit(profile.creatorActorId, snapshot)) return true; // 空间 creator
        if (profile.memberUserIds.has(snapshot.userId)) return true; // 空间成员
        // doc 的创建者（含其 owner-proxy：agent 建的文档，它的人类 owner 视同创建者）
        return this.isCreatorHit(doc.createdBy, snapshot);
      })
      .map((snapshot) => this.toRecipient(snapshot));
  }

  /** creator 语义命中：`creatorActorId` 是候选本人，或其名下 agent（owner-proxy，见 plan §D3） */
  private isCreatorHit(
    creatorActorId: string | null | undefined,
    snapshot: NotifyUserSnapshot,
  ): boolean {
    if (!creatorActorId) return false;
    return creatorActorId === snapshot.userId || snapshot.agentIds.has(creatorActorId);
  }

  /** assignee 命中：被指派者是候选本人或其名下 agent（**仍须先过安全层**，由调用方保证） */
  private isAssigneeHit(
    assigneeId: string | null | undefined,
    snapshot: NotifyUserSnapshot,
  ): boolean {
    if (!assigneeId) return false;
    return assigneeId === snapshot.userId || snapshot.agentIds.has(assigneeId);
  }

  /** 快照 → 收件人投影（快照只在编排器内部流动，对外只交出投递所需的三项事实） */
  private toRecipient(snapshot: NotifyUserSnapshot): NotifyRecipient {
    return {
      userId: snapshot.userId,
      channels: snapshot.channels,
      agentIds: snapshot.agentIds,
    };
  }

  // ─────────────────────────────── owner 解析 ───────────────────────────────

  /**
   * L1 键（**不是** plan §3 字面的 `category:resourceId`；三处取舍都是 review 定稿的修正）。
   *
   * ① **资源分量按类别取**：`NEW_MESSAGE` 的 `event.resourceId` 是**消息 id**
   *    （`topic.service.ts` 的 emit 用 `saved.id`）——直接用它会让 topic 的键恒唯一、
   *    L1 **永不命中**（同一话题被刷屏时完全失效）。故 topic 取 `event.topicId`
   *    （调用点已保证非空）。
   * ② **task 四类共用一个键**（`task:<taskId>:<userId>`，**不含类别**）：plan §5 的字面语义是
   *    "per-task 300s"。若按类别分段，`PATCH {assigneeId}` 这类**同时**产生
   *    `task_updated` + `task_assigned` 的请求会双发两条通知（两个键都不命中）。
   *    同理 doc 四类共用 `doc:<docId>:<userId>`。
   * ③ **含 `userId`**（批 2 棒 B 的泛化，plan §D3"逐收件人 check→渲染→mark→consume→deliver"）：
   *    窗口的语义是"**别往这个人的手机上重复推同一个资源**"，而"这个资源"是否已经推过**对每个人
   *    是独立的事实**。共享一个键的症状很隐蔽——同一场批量事件打给 10 个人，**只有第一个**
   *    收到（其余 9 个的"通知"被第一人的窗口吃掉，且日志上表现为正常的 l1_throttle）。
   *
   * @param category 类别
   * @param event 事件行（资源分量从这里取，见上）
   * @param userId 收件人用户 id（窗口的**主体**，见上 ③）
   * @returns 键；null = 该类别不经 L1 或资源分量缺失（调用点跳过节流）
   */
  private l1Key(category: NotifyCategory, event: Event, userId: string): string | null {
    switch (category) {
      case NOTIFY_CATEGORY.TOPIC:
        return event.topicId ? `topic:${event.topicId}:${userId}` : null;
      case NOTIFY_CATEGORY.TASK_DONE:
      case NOTIFY_CATEGORY.TASK_CREATED:
      case NOTIFY_CATEGORY.TASK_UPDATED:
      case NOTIFY_CATEGORY.TASK_ASSIGNED:
        return event.resourceId ? `task:${event.resourceId}:${userId}` : null;
      case NOTIFY_CATEGORY.DOC_CREATED:
      case NOTIFY_CATEGORY.DOC_UPDATED:
      case NOTIFY_CATEGORY.DOC_DELETED:
      case NOTIFY_CATEGORY.DOC_MOVED:
        return event.resourceId ? `doc:${event.resourceId}:${userId}` : null;
      case NOTIFY_CATEGORY.DIRECT:
        // 直发无资源分量（plan §5：强行加 L1 会让不同人的直发互相串行）
        return null;
      default:
        return null;
    }
  }

  /**
   * 类别 → L1 窗口长度（毫秒）；`null` = 不经 L1（`direct`）。
   *
   * per-task 窗口四类共用一个配置值（`task_*` 都是"同一任务"的粒度）；doc 四类共用 doc 窗口；
   * topic 单独一个。
   *
   * @param category 类别
   * @returns 窗口毫秒数，或 null（不节流）
   */
  private l1TtlMs(category: NotifyCategory): number | null {
    const settings = this.settings;
    switch (category) {
      case NOTIFY_CATEGORY.TASK_DONE:
      case NOTIFY_CATEGORY.TASK_CREATED:
      case NOTIFY_CATEGORY.TASK_UPDATED:
      case NOTIFY_CATEGORY.TASK_ASSIGNED:
        return settings.taskThrottleSeconds * 1000;
      case NOTIFY_CATEGORY.TOPIC:
        return settings.topicThrottleSeconds * 1000;
      case NOTIFY_CATEGORY.DOC_CREATED:
      case NOTIFY_CATEGORY.DOC_UPDATED:
      case NOTIFY_CATEGORY.DOC_DELETED:
      case NOTIFY_CATEGORY.DOC_MOVED:
        return settings.docThrottleSeconds * 1000;
      case NOTIFY_CATEGORY.DIRECT:
        // 直发无资源分量（plan §5：强行加 L1 会让不同人的直发互相串行）
        return null;
      default:
        return null;
    }
  }

  /**
   * 取（或滚动重建）某个**收件人**（= 用户）的 L2 窗口。
   *
   * 事件链路（`consumeL2`）与直发链路（`reserveL2ForDirect`）**共用同一份窗口账**——这正是
   * "直发占 L2 额度"的实现（plan §7.1）：两条链路的放行数相加不得超过 `globalRateLimit`。
   *
   * ⚠️ **窗口维度 = `recipientUserId`**（批 2 棒 B 的点名改造）：
   * 键是**人**，不是地址——地址会变（改绑 / 解绑），而"某个人的手机别被刷爆"这件事的主体始终
   * 是人。用地址当键的隐蔽症状：用户换绑后**新地址拿到一个全新的空窗口**（额度被悄悄重置），
   * 而旧地址的残留窗口再也不会被消费（泄漏一条永远过期的账）。
   *
   * 窗口过期则重置（`delivered` / `summarySent` 归零；**未 flush 的 suppressed 计数刻意
   * 保留**——它们会被下一次 flush 报出去，不丢信息）。
   *
   * @param recipientUserId 收件人用户 id（窗口维度）
   * @param now 当前时刻（epoch ms）
   * @returns 该收件人的当前窗口（已写回 `l2Windows`）
   */
  private windowFor(recipientUserId: string, now: number): L2Window {
    const windowMs = this.settings.globalRateWindowSeconds * 1000;
    let window = this.l2Windows.get(recipientUserId);
    if (!window || now - window.startedAt >= windowMs) {
      window = {
        // 窗口自己携带归属（flush / 直发占额只拿到窗口对象；见 L2Window 的字段注释）
        recipientUserId,
        startedAt: now,
        delivered: 0,
        // 跨窗口保留未 flush 的计数（否则"窗口结束时被压制的最后几条"会永久丢失）
        suppressed: window?.suppressed ?? new Map<NotifyCategory, number>(),
        summarySent: false,
      };
      this.l2Windows.set(recipientUserId, window);
    }
    return window;
  }

  /**
   * 消费一次 L2 额度（**per-user** 滑动窗口）。
   *
   * 语义：窗口内 `delivered < globalRateLimit` ⇒ 放行并计数；否则**只记账**（按类别 +1）返回
   * `'buffered'`。
   *
   * ⚠️ **连同窗口对象一起返回**（MINOR-4）：调用方拿到"判决"之后往往紧接着要用这个窗口
   * （flush 摘要 / 台账归属），让它同时拿到窗口本身就不必再 `get(recipientUserId)` 一次、也
   * 不必"记得刚才那个 userId"——归属由 `window.recipientUserId` 自己说。
   *
   * ⚠️ 本方法**只记账**（不投递、不知道投递地址）：地址由 `flushDigestIfNeeded` 在真正投递前
   * 从该用户的快照现取（并**重判 deliveryEligible**，见该方法的注释）。
   *
   * @param recipientUserId 收件人用户 id（窗口维度）
   * @param category 类别（只用于记 suppressed 的分布）
   * @returns `verdict` = `'deliver'` 直发 / `'buffered'` 计入摘要；`window` = 该收件人的窗口
   */
  private consumeL2(
    recipientUserId: string,
    category: NotifyCategory,
  ): { verdict: 'deliver' | 'buffered'; window: L2Window } {
    const window = this.windowFor(recipientUserId, Date.now());
    if (window.delivered < this.settings.globalRateLimit) {
      window.delivered += 1;
      return { verdict: 'deliver', window };
    }
    window.suppressed.set(category, (window.suppressed.get(category) ?? 0) + 1);
    return { verdict: 'buffered', window };
  }

  /**
   * 直发链路的 L2 额度占位（**占额但永不合并**，plan §7.1 / §11）。
   *
   * 与 `consumeL2` 有两点**刻意不同**（这是"直发被 L2 合并改写"风险的落地对策）：
   * ① 超额**不入摘要**（`suppressed` 不记账）——直发是调用方显式要求的一条消息，把它改写成
   *    "另有 N 条通知"会让 agent 拿到 200 却没人收到那条消息（违背调用意图）；
   * ② 返回**窗口剩余秒数**而不是 `'buffered'`——直发端点必须把"等多久"告诉调用方
   *    （429 的 `Retry-After` 头与 `data.retryAfterSeconds` 都是它）。
   *
   * ⚠️ 本方法**只占额，不做任何投递**；超额时调用方（直发 service）负责抛 429。
   *
   * @param recipientUserId 收件人用户 id（= 调用 agent 的 `ownerId`；与事件链路共用的窗口维度）
   * @returns `{ allowed: true }`（已占额）/ `{ allowed: false, retryAfterSeconds }`（未占额）
   */
  reserveL2ForDirect(
    recipientUserId: string,
  ): { allowed: true } | { allowed: false; retryAfterSeconds: number } {
    const now = Date.now();
    const windowMs = this.settings.globalRateWindowSeconds * 1000;
    const window = this.windowFor(recipientUserId, now);
    if (window.delivered < this.settings.globalRateLimit) {
      window.delivered += 1;
      return { allowed: true };
    }
    // 未占额、不记账：等窗口滚动后重试即可（额度不会被这次失败的尝试吃掉）
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((window.startedAt + windowMs - now) / 1000)),
    };
  }

  /**
   * flush L2 摘要（**per-user**；窗口内 ≤1 条；摘要**不占额度**、**豁免总闸**）。
   *
   * 两处顺序都是语义（别换）：
   * ① **先重判后清账**：重判（见下）不通过时不能把账留着——否则它会随窗口轮转被反复重判、
   *    永远报不出去；但**必须先判再清**，否则"这一批被压制了多少"就从日志里消失了（丢弃的
   *    INFO 里带总数，是唯一的证据）。
   * ② **清账在 `await` 之前**：投递是 fire-and-forget，期间再来事件不该重复计入本条摘要。
   *
   * ⚠️ **投递前必须重判 `deliveryEligible`**（plan §D3 点名，V6）：缓冲（记账）与 flush（投递）
   * 之间用户可能已经解绑 / 静音。flush 走的是**定时器**与**超额**两条与"当前绑定"无关的路径，
   * 不重判就等于给"**解绑 = 通知立即停止**"留一条最长一个窗口的时间缝——用户已经解绑了，
   * 还在收"另有 N 条通知"。不通过 ⇒ 丢弃 + INFO（**不投递**）。
   *
   * ⚠️ **摘要不发往"旧的地址"**：地址在这里从该用户的快照现取（`channels[0]`），与 L2 的窗口
   * 维度（userId）配成一对——窗口按人记，地址按人当时的绑定取。
   *
   * ⚠️ **入参是窗口对象本身，不是 userId**（MINOR-4）：归属（"这是谁的摘要"）由
   * `window.recipientUserId` 给出，快照查询 / 日志 / 台账列三处同源，调用方不需要（也不该）
   * 再传一遍 id —— 传两次就多一个可能传错的地方。
   *
   * @param window 该收件人的 L2 窗口（`consumeL2` 交出来的那一个 / sweep 迭代到的那个）
   * @param force true = 窗口边界上的强制 flush（绕过 `summarySent` 闸；窗口切换时调用）
   */
  private async flushDigestIfNeeded(window: L2Window, force: boolean): Promise<void> {
    if (window.suppressed.size === 0) return;
    if (window.summarySent && !force) return;
    const recipientUserId = window.recipientUserId;

    const total = [...window.suppressed.values()].reduce((sum, count) => sum + count, 0);
    const distribution = [...window.suppressed.entries()]
      .map(([category, count]) => `${category}×${count}`)
      .join(', ');

    // ① 重判投递资格（快照走写时失效 + TTL 兜底；`loadUserSnapshot` 在"无合格绑定"时抛
    //    NotifyNoEligibleChannelError）。⚠️ **只吞这一种**：库抖动之类的异常照旧冒泡给
    //    fire-and-forget 的 catch（那是"这次没投出去"，不是"这个人不该收"）。
    let target: NotifyChannelSnapshot;
    try {
      const snapshot = await this.loadUserSnapshot(recipientUserId);
      target = snapshot.channels[0];
    } catch (err) {
      if (!(err instanceof NotifyNoEligibleChannelError)) throw err;
      // 丢弃也要闭合窗口的账：清 suppressed + 记 summarySent，否则这批计数会随窗口轮转被
      // 反复重判（且每轮都再打一行 INFO）
      window.suppressed.clear();
      window.summarySent = true;
      this.logger.log(
        `digest dropped [recipient_unbound] recipient=${recipientUserId} — this user has no ` +
          `delivery-eligible channel binding any more (unbound or muted), so the ${total} ` +
          `suppressed notification(s) are NOT sent. "Unbind = notifications stop immediately" ` +
          'outranks the digest.',
      );
      return;
    }

    // ② 清账（在 await 之前，见上）
    window.suppressed.clear();
    window.summarySent = true;

    const body = truncateText(
      `另有 ${total} 条通知（${distribution}）`,
      NOTIFICATION_SUMMARY_MAX_LENGTH,
    );
    await this.deliver(
      {
        category: DIGEST_DELIVERY_CATEGORY,
        eventId: null,
        title: truncateText('[通知汇总]', TITLE_MAX_LENGTH),
        body,
        // "根链接"= web 基址本身（摘要聚合多个资源，没有单一资源可指向）
        link: this.settings.webBaseUrl,
        recipient: target.recipientAddress,
      },
      recipientUserId,
      // 同一条事实源：地址与渠道都取自这次重判读到的那一行快照
      target.provider,
    );
  }

  /** 起 L2 兜底扫描（窗口结束时的强制 flush；`unref` 不阻止进程退出） */
  private startSweep(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => {
      const now = Date.now();
      const windowMs = this.settings.globalRateWindowSeconds * 1000;
      // 快照迭代（回调里会删条目；`[...values()]` 是副本，迭代期间删 Map 是安全的）。
      // ⚠️ **只迭代值**：删键用的 `window.recipientUserId` 来自窗口自身（MINOR-4）——
      //    "哪个键对应哪个窗口"不再需要调用方维护。
      for (const window of [...this.l2Windows.values()]) {
        if (now - window.startedAt < windowMs) continue;
        // 窗口边界：强制 flush 未报的计数（force 绕过 summarySent 闸——此刻已跨窗口，
        // 不违反"窗口内 ≤1 条"）。⚠️ 调用顺序固定：flush 的同步段会先清账，随后才回收条目
        // （consumeL2 在下一个事件到来时重建窗口）。
        // ⚠️ flush 的**异步段**（重判资格 + 投递）在本轮 `delete` 之后才跑完：它读的是**这个
        //    窗口对象**（闭包捕获），不是 Map 里的位置，故删除条目不会让它读不到自己的账。
        //    ⚠️ 循环体是**同步**的（fireAndForget 立即返回）⇒ 从"迭代副本"到"删键"之间没有
        //    await，不存在"删掉的是同一个人新起的窗口"这种交错。
        this.fireAndForget(this.flushDigestIfNeeded(window, true), 'l2 sweep flush');
        this.l2Windows.delete(window.recipientUserId);
      }
    }, L2_SWEEP_INTERVAL_MS);
    // 定时器不该成为进程退出的阻碍（jest 也不会因它挂住）
    this.sweepTimer.unref?.();
  }

  // ────────────────────────── 直发收件人解析（批 2 棒 B） ──────────────────────────

  /**
   * **直发链路的收件人解析**：`agent.ownerId` → 该用户的**主投递渠道**（plan §D3 的 `direct` 行）。
   *
   * 为什么与 `resolveRecipients` 分开：直发**没有资源可判**（没有 board / space / topic 可问
   * "这个人有没有权读、关不关心"），它的唯一判据就是"这个人此刻有没有一个 deliveryEligible
   * 绑定"。硬把它塞进资源判据的 switch 只会写出一堆 `case DIRECT: return []` 的噪声。
   *
   * 地址与 L2 是**同一份事实源**（per-user 快照的 `channels[0]`）：换地址 / 解绑走写路径的
   * `invalidateUser` ⇒ 下一个直发立刻看到新事实（TTL 只是兜底）。
   *
   * @param userId 收件人（= 调用 agent 的 `ownerId`）
   * @returns 主投递渠道（provider + 地址）；**无任何 deliveryEligible 绑定** ⇒ null
   * @throws Error 快照重建遇到**非"无绑定"**的故障（DB 抖动 / 连接池耗尽）——这类必须冒泡成
   *   5xx。**绝不能**把它降级成 `recipient_not_bound`：那会把一次运维故障伪装成"你的人类 owner
   *   没绑渠道"这一**用户的持久状态**，是最难排的一类假象（见 {@link NotifyNoEligibleChannelError}）。
   */
  async resolveDirectTarget(userId: string): Promise<NotifyChannelSnapshot | null> {
    try {
      const snapshot = await this.loadUserSnapshot(userId);
      // `channels` 非空由 `buildUserSnapshot` 保证（空即抛 NotifyNoEligibleChannelError）；
      // `?? null` 只是让"将来有人放宽那条保证"时退化成降级而不是 `undefined` 穿透
      return snapshot.channels[0] ?? null;
    } catch (err) {
      if (err instanceof NotifyNoEligibleChannelError) return null;
      throw err;
    }
  }

  // ─────────────────────── 系统告警（运维出口，路线 B） ───────────────────────

  /**
   * **系统告警端口**：把一条运行期告警投递到 **admin 账号绑定的渠道**（plan D1/D6）。
   *
   * 设计要点（逐条都有代价记录，改动前先读 plan §D6）：
   * - **收件人 = admin 账号**（`users.role='admin'`），不是 `NOTIFY_OWNER_USERNAMES` 播种账号
   *   ——后者是升级日平滑迁移的输入，不是"运维负责人"这个概念；
   * - **不进 `NOTIFY_CATEGORIES` / 不上设置页 / 用户不可静音**：告警是运维类别，
   *   唯一治理面是部署级 `NOTIFY_ENABLED`；
   * - **不做应用层重投**：`failureKind='transport'` 含 timeout（响应丢失时消息可能已送达），
   *   "确定未出境才重投"是假承诺。可靠性 = provider 内部 3 次尝试（≈3s 包络）+ 下一次心跳；
   *   at-least-once 口径下"provider 故障 >3s ⇒ 本条丢失，等下一次心跳"。
   * - **结构性 never-throw**：调用方（memory tracker）以 `void … .then().catch()` 单链调用，
   *   但未来的消费者未必记得兜底；方法体全包 try/catch，异常一律折成 `'failed'`。
   *
   * 链路顺序固定（见 plan D6 的清单）：总开关 → 收件人解析 → 量控（**紧贴 deliver**）→
   * 渲染 → 单次 deliver → 终态。任何"没有投递路径"的分支都**不吃额度**。
   *
   * @param input 告警入参（生产方已净化；见 {@link SystemAlertInput}）。⚠️ `occurredAt`
   *   **进 outcome 日志行**（`at=<iso>`，经 `sanitizeLogValue`）——生产方靠它与自己的状态机
   *   对账"这一条是何时的事件、为什么没出去"；它不进正文、也不是投递表字段。
   * @returns 九态之一（见 {@link SystemAlertOutcome}）；**永不 reject**
   */
  async sendSystemAlert(input: SystemAlertInput): Promise<SystemAlertOutcome> {
    try {
      // ① 总开关（部署级唯一闸）：关 ⇒ 不读库、不计额、只留一行 reason（可 grep 对账）。
      if (!this.settings.enabled) {
        this.logger.log(
          `system_alert skipped [disabled] source=${input.source} kind=${input.kind} ` +
            `arm=${input.arm} at=${sanitizeLogValue(input.occurredAt)} — NOTIFY_ENABLED=false`,
        );
        return 'disabled';
      }

      // ② 收件人解析（与启动自检**共用同一个**解析器——两处判据分叉 = 启动说 ok、运行期丢）
      const target = await this.resolveSystemAlertTarget();
      if (target.status !== 'ok') {
        // 日志只打 outcome/source/kind/arm/at：**不打 admin 地址、不打 title/body**
        this.logger.log(
          `system_alert skipped [${target.status}] source=${input.source} kind=${input.kind} ` +
            `arm=${input.arm} at=${sanitizeLogValue(input.occurredAt)}`,
        );
        return target.status;
      }

      // ③ 量控（按臂分桶；放在 deliver 紧前方 —— 上面所有断态都不吃额度）
      if (!this.consumeSystemAlertQuota(input.arm, input.kind)) {
        // 逐条证据在这里（`grep "system_alert dropped \[rate_limited\]"` 可对账）；
        // 规模的聚合信号由 consumeSystemAlertQuota 里那个窗口限频 WARN 承担。
        this.logger.log(
          `system_alert dropped [rate_limited] source=${input.source} kind=${input.kind} ` +
            `arm=${input.arm} at=${sanitizeLogValue(input.occurredAt)}`,
        );
        return 'rate_limited';
      }

      // ④ 渲染 → **单次** deliver（终态落库在 deliver 内；不重投，见方法头）
      const rendered = this.renderSystemAlert(input, target.recipient);
      const outcome = await this.deliver(rendered, target.userId, target.provider);
      if (outcome === null) {
        // 防御性分支：`resolveSystemAlertTarget` 已校验 provider 装配，正常不可达。
        // 保留它是为了让"将来有人重排链路顺序"时不会把 null 误报成 delivered。
        return 'no_provider';
      }
      // switch 而非字面量比较（本仓 ESLint no-magic-string-compare；同 noteDeliveryOutcome）
      let result: SystemAlertOutcome = 'failed';
      switch (outcome.status) {
        case 'success':
          result = 'delivered';
          break;
        default:
          result = 'failed';
      }
      this.logger.log(
        `system_alert ${result} source=${input.source} kind=${input.kind} arm=${input.arm} ` +
          `at=${sanitizeLogValue(input.occurredAt)}`,
      );
      return result;
    } catch (err) {
      // 日志卫生：只打 error name（message 可能夹带 SQL / 上游原文）
      this.logger.error(`system_alert dispatch failed (swallowed): ${errorName(err)}`);
      return 'failed';
    }
  }

  /**
   * 启动自检（S2）：一行说明"系统告警此刻能不能出去"。
   *
   * 为什么必须存在：告警是**静默失败**的典型面——没有配置时"一条都没收到"和"平台一直健康"
   * 在外部完全同形。启动时把收件人解析结果打出来，是运维唯一能提前发现"告警通道断了"的时机。
   *
   * 分级（plan D6-S2）：
   * - 总开关关 ⇒ `log`（这是正常缺省态，不是故障）；
   * - `ok` ⇒ `log`（含 admin username 与 provider token，**不打印地址全值**）；
   * - 启动期 `no_admin` ⇒ **降级为 log**：bootstrap 钩子顺序是 Nest 实现细节（architect B3），
   *   首启此刻 admin 行可能还没被 seed 出来——若按 warn 报，每次首启都会吓人一跳；
   * - 其余断态（admin 软删 / 无渠道 / 渠道不可投递 / provider 未装配）⇒ **warn + 修复指引**。
   *
   * ⚠️ 整段 try/catch：启动钩子抛出 = **中止启动**，而告警通道只是可选运维能力——
   * DB 抖动不该让平台起不来（同 seedFromEnv 的"配错不该让平台起不来"纪律）。
   */
  async onApplicationBootstrap(): Promise<void> {
    try {
      if (!this.settings.enabled) {
        this.logger.log('system_alert target: disabled (NOTIFY_ENABLED=false)');
        return;
      }
      const target = await this.resolveSystemAlertTarget();
      switch (target.status) {
        case 'ok':
          // username 过 sanitizeLogValue：用户名由用户自填，日志行不得被换行/控制字符打散
          this.logger.log(
            `system_alert target: ok admin=${sanitizeLogValue(target.adminUsername)} ` +
              `channel=${target.provider}`,
          );
          return;
        case 'no_admin':
          this.logger.log(
            'system_alert target: admin account not found at boot — if it persists after ' +
              'bootstrap, alerts will only be logged',
          );
          return;
        case 'admin_soft_deleted':
          this.logger.warn(
            'system_alert target: the admin account exists but its actor is soft-deleted — ' +
              'alerts will only be logged until DB ops restore it (the unique admin index slot ' +
              'is NOT released by a soft delete).',
          );
          return;
        case 'no_channel':
          this.logger.warn(
            'system_alert target: the admin account has no notification channel bound — alerts ' +
              'will only be logged. Bind one under Settings → Notifications (or seed it via ' +
              'FEISHU_RECIPIENT_OPEN_ID + NOTIFY_OWNER_USERNAMES).',
          );
          return;
        case 'channel_ineligible':
          this.logger.warn(
            'system_alert target: the admin account has a channel binding that is NOT delivery-' +
              'eligible (disabled / unverified / failed last test) — alerts will only be logged. ' +
              'Re-run the channel test under Settings → Notifications.',
          );
          return;
        case 'no_provider':
          this.logger.warn(
            'system_alert target: the admin channel exists but its provider is not assembled in ' +
              `this deployment (NOTIFY_PROVIDERS=${this.settings.providers.join(',') || '<empty>'}). ` +
              'Alerts will only be logged.',
          );
          return;
        default:
          return;
      }
    } catch (err) {
      // 启动自检失败**不得中断启动**：平台可用性优先于"告警通道可用性"的观测
      this.logger.error(`system_alert target self-check failed (ignored): ${errorName(err)}`);
    }
  }

  /**
   * 解析系统告警的收件人：**admin 账号 → 其主投递渠道 → 已装配的 provider**。
   *
   * 为什么不复用 `resolveDirectTarget()`：它走 per-user 快照，并把"从没绑过"与"绑了但不可投递"
   * 压成同一个 `null`（直发只需要一个笼统 reason）。告警需要**六种断态的精确区分**——它们对应
   * 运维动作完全不同的六个修复步骤（建 admin / 恢复账号 / 绑渠道 / 去点测试 / 启用 provider）。
   *
   * @returns 判别联合（见 {@link SystemAlertTarget}）；DB 异常向上抛（由调用方决定吞还是报）
   */
  private async resolveSystemAlertTarget(): Promise<SystemAlertTarget> {
    // ① admin 账号。actor 是 eager 关系，且 Actor 有 DeleteDateColumn ⇒ TypeORM 的软删过滤
    //    会把已软删的 actor 置成 null（这正是我们要判的"账号还在、身份已软删"）。
    const admin = await this.userRepo.findOne({ where: { role: UserRole.ADMIN } });
    if (!admin) return { status: 'no_admin' };
    // ⚠️ **不读 `actor.deletedAt`**：该列 `select: false`，读了恒为 undefined ⇒ 判定会静默失效
    //    （architect B2 点名的坑）。status / 空引用这两条事实已足以区分"活着 / 软删"。
    if (!admin.actor || admin.actor.status !== AgentStatus.ACTIVE) {
      return { status: 'admin_soft_deleted', adminUsername: admin.username };
    }

    // ② 主投递渠道（deliveryEligible 谓词**单源**；`createdAt ASC` = "主渠道"的既有口径）
    const channel = await this.channelRepo.findOne({
      where: { ...deliveryEligibleWhere(), userId: admin.id },
      order: { createdAt: 'ASC' },
    });
    if (!channel) {
      // 区分"从没绑过"与"绑过但不可投递"：只数**非墓碑**行（`unboundAt IS NULL`）。
      // 墓碑行（曾解绑）若计入，会把"解绑过"的人误指引去点测试（PM N3）。
      const boundRows = await this.channelRepo.count({
        where: { userId: admin.id, unboundAt: IsNull() },
      });
      return { status: boundRows > 0 ? 'channel_ineligible' : 'no_channel' };
    }

    // ③ 出口装配：渠道行存在但本部署没启用该 provider ⇒ 投了必然失败，且会把账记到无关渠道
    if (!this.providers.some((candidate) => candidate.key === channel.provider)) {
      return { status: 'no_provider' };
    }

    return {
      status: 'ok',
      adminUsername: admin.username,
      userId: admin.id,
      provider: channel.provider,
      recipient: channel.recipientAddress,
    };
  }

  /**
   * 系统告警量控（**按臂分桶**，见 {@link SystemAlertArm} 的三处裁决）。
   *
   * @param arm 量控分桶键
   * @param kind 告警种类（决定是否计额）
   * @returns true = 允许投递（并已占额）；false = 超限丢弃（已记账，可能已打聚合 WARN）
   */
  private consumeSystemAlertQuota(arm: SystemAlertArm, kind: SystemAlertKind): boolean {
    // heartbeat 不计额：它自带 60/240min 节律；给它计额只会让"平台还活着"的信号先死
    if (kind === 'heartbeat') return true;
    // availability 的 recovery 免额：A 臂恢复有探针 2 连胜 ≥4min 迟滞，天然有界
    if (arm === 'availability' && kind === 'recovery') return true;

    const now = Date.now();
    const bucket = this.systemAlertBucketFor(arm, now);
    // ⚠️ **逐键兜底**（review N2）：`resolveNotificationsConfig` 只在**整个 `notifications`
    //    命名空间缺失**时回落 FALLBACK；若配置对象"存在但缺这个新键"（旧版 e2e 内联配置、
    //    外部 override），`undefined` 会让 `used < undefined` 恒为 false ⇒ **所有系统告警
    //    被判 rate_limited**——最需要出声的通道静默，且日志只说"限流"，查不出根因。
    const limit =
      this.settings.systemAlertMaxPerHour ?? NOTIFICATIONS_CONFIG_FALLBACK.systemAlertMaxPerHour;

    if (bucket.used < limit) {
      bucket.used += 1;
      return true;
    }

    // 超限：丢弃并记账。WARN 按**窗口聚合**（一个窗口最多一行、带累计条数）——flap 会成批丢，
    // 逐条 WARN 会把日志冲垮而信息量不增（与部署总闸的 notePlatformGateDrop 同款纪律）。
    bucket.dropped += 1;
    if (now - bucket.warnedAt >= SYSTEM_ALERT_RATE_WINDOW_MS) {
      this.logger.warn(
        `system_alert rate limit hit: ${bucket.dropped} alert(s) dropped in the last hour ` +
          `(arm=${arm} limit=${limit}/h via NOTIFY_SYSTEM_ALERT_MAX_PER_HOUR). Check the engine ` +
          'health arm — a flap loop is the usual cause.',
      );
      bucket.warnedAt = now;
      bucket.dropped = 0;
    }
    return false;
  }

  /**
   * 取某个臂的量控桶（窗口过期即重建——惰性回收，不引入独立定时器）。
   *
   * @param arm 分桶键
   * @param now 当前时刻（epoch ms）
   * @returns 该臂的窗口对象（`used` 已占额度；`dropped`/`warnedAt` 是 WARN 限频状态）
   */
  private systemAlertBucketFor(
    arm: SystemAlertArm,
    now: number,
  ): { startedAt: number; used: number; dropped: number; warnedAt: number } {
    const existing = this.systemAlertBuckets.get(arm);
    if (existing && now - existing.startedAt < SYSTEM_ALERT_RATE_WINDOW_MS) return existing;
    const fresh = { startedAt: now, used: 0, dropped: 0, warnedAt: 0 };
    this.systemAlertBuckets.set(arm, fresh);
    return fresh;
  }

  /**
   * 渲染一条系统告警（**直构 `RenderedNotification`，不走 `render()`**）。
   *
   * 为什么不复用 `render(category, event, recipient)`：它按事件资源回库取标题与归属，而告警
   * **没有事件行**（`eventId: null`）——硬塞需要伪造 Event，还会把"资源缺失 ⇒ 丢弃"的语义
   * 错误地套到告警上（告警正文由生产方给全，不存在"资源已删"这一态）。
   *
   * 出境面（与 config `NOTIFY_EGRESS_FIELDS` 的告警行逐项对齐）：title / body（生产方闭集
   * 文案）、固定运维页链接、收件人地址。`occurredAt` / `consecutive` / `workspaceId`
   * **不进出境面**（要么已在正文里，要么只用于日志对账）。
   *
   * @param input 告警入参
   * @param recipient 收件人地址（admin 渠道）
   * @returns 成品通知（`category='system_alert'`、`eventId=null`）
   */
  private renderSystemAlert(input: SystemAlertInput, recipient: string): RenderedNotification {
    const base = this.settings.webBaseUrl;
    return {
      category: SYSTEM_ALERT_DELIVERY_CATEGORY,
      eventId: null,
      title: truncateText(stripControlChars(input.title), TITLE_MAX_LENGTH),
      body: truncateText(stripControlChars(input.body), SYSTEM_ALERT_BODY_MAX_LENGTH),
      // ⚠️ 基址缺失时**必须为 null**：拼 `"null/memory"` 会给出一个必然打不开的链接
      link: base ? `${base}/memory` : null,
      recipient,
    };
  }

  // ─────────────────────────────── 渲染 ───────────────────────────────

  /**
   * 渲染一条通知（**出境面在这里成形**，见文件头不变量）。
   *
   * 资源缺失（回库查不到）= 幻影事件（事务回滚 / 已删）⇒ 返回 null 让管线丢弃。
   *
   * **v2 —— 归属信息**（多项目 / 多 agent 场景下"这是谁的事"）：三类正文各补一段归属——
   * task 补 `看板「<boardName>」 · <actorName>`（指派类再追 `→ 指派给 <assigneeName>`）、
   * topic 补 `<senderName>：` 前缀、doc 补 `空间「<spaceName>」 · ` 前缀；title 一律不变。
   * ⚠️ 归属名**降级不丢弃**（兜底 `?`，见 `ATTRIBUTION_FALLBACK`）——它是旁挂信息，
   * 不该让"取不到看板名"演变成"这件事 Owner 完全看不到"。
   *
   * @param category 类别
   * @param event 事件行
   * @param recipient 收件人
   * @returns 成品通知，或 null（资源缺失）
   */
  private async render(
    category: NotifyCategory,
    event: Event,
    recipient: string,
  ): Promise<RenderedNotification | null> {
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    const link = this.buildLink(category, event);

    switch (category) {
      case NOTIFY_CATEGORY.TASK_DONE:
      case NOTIFY_CATEGORY.TASK_CREATED:
      case NOTIFY_CATEGORY.TASK_UPDATED:
      case NOTIFY_CATEGORY.TASK_ASSIGNED: {
        const task = await this.taskRepo.findOne({ where: { id: event.resourceId } });
        if (!task) return null;
        const title = truncateText(task.title, TITLE_MAX_LENGTH);
        const prefix =
          category === NOTIFY_CATEGORY.TASK_DONE
            ? payload.toStatus === TaskStatus.BLOCKED
              ? '[阻塞]'
              : '[完工]'
            : category === NOTIFY_CATEGORY.TASK_CREATED
              ? '[新任务]'
              : category === NOTIFY_CATEGORY.TASK_ASSIGNED
                ? '[指派]'
                : '[任务更新]';
        // v2 归属信息：标题已带任务名，正文改为「看板「<boardName>」 · <actorName>」——
        // 多项目场景下 Owner 一眼看出"这是哪张看板、谁在做"。两个名字都是**尽力而为的旁挂
        // 信息**：取不到（boardId 缺键 / board 行缺失 / actor 已删）只降级成 `?`，
        // **绝不因此丢弃通知**（丢弃 = Owner 彻底看不到这件事，比归属残缺严重得多）。
        // ⚠️ 两次 await **刻意串行**（不是 Promise.all）：两条都是回库查询，并发只会抢同一个
        //    连接池。开销订正：本分支每投递新增 **≤4 次往返** —— 看板名 1 次单行查询
        //    （`boardId` 缺键时为 0 次）+ `ActorProfileService.resolveProfiles` 内部**固定 3 条**
        //    批量查询（actors 主查 / agents 补查 / users 条件补查）；相对投递本身的网络开销可忽略。
        const boardName = await this.resolveBoardName(event.boardId);
        const actorName = await this.resolveActorName(event.actorId);
        const assigneeSuffix =
          category === NOTIFY_CATEGORY.TASK_ASSIGNED
            ? ` → 指派给 ${truncateText(String(payload.assigneeName ?? ATTRIBUTION_FALLBACK), 50)}`
            : '';
        const summary = `看板「${boardName}」 · ${actorName}${assigneeSuffix}`;
        return {
          category,
          eventId: event.id,
          title: truncateText(`${prefix} ${title}`, TITLE_MAX_LENGTH),
          // 归属信息是**消息本体** ⇒ 用 200 的宽度（见 NOTIFICATION_BODY_MAX_LENGTH 的取舍）；
          // 100 会把"哪个项目 / 哪张看板 / 谁做的"截掉，那正是本类通知要回答的问题。
          body: truncateText(summary, NOTIFICATION_BODY_MAX_LENGTH),
          link,
          recipient,
        };
      }
      case NOTIFY_CATEGORY.TOPIC: {
        if (!event.topicId) return null;
        const [topic, message] = await Promise.all([
          this.topicRepo.findOne({ where: { id: event.topicId } }),
          this.messageRepo.findOne({ where: { id: event.resourceId } }),
        ]);
        if (!topic || !message) return null;
        const topicTitle = truncateText(topic.title, TITLE_MAX_LENGTH);
        // 出境字段：话题名 + **发言人显示名** + 消息摘要（截断 100 字符）——与 config 的出境
        // 声明逐字对齐。发言人是 v2 新增归属：多 agent 场景下"谁说的"与"说了什么"同等重要。
        // ⚠️ 复用 `message` 这一次 findOne 的结果（不额外查库），但**消息行上没有名字**——
        //    名字仍要走 `ActorProfileService`（同一份 name 回退链，与 `topic.service.ts` 的
        //    `senderName` 注入对齐；真孤儿 / senderId 缺失一律兜底 `?`）。
        const rawSenderName = await this.resolveActorName(message.senderId);
        // ⚠️ 发言人名**先收到 30 字符再组串**（预算保护，不是显示名契约）：displayName 长度
        //    不由本模块约束，异常长的名字会把 100 字的正文预算整个吃掉 —— 用户连摘要的第一个字
        //    都看不到。这条通知的价值在"谁说了什么"，名字只是前缀。
        const senderName = truncateText(rawSenderName, 30);
        const excerpt = truncateText(message.content, NOTIFICATION_SUMMARY_MAX_LENGTH);
        return {
          category,
          eventId: event.id,
          title: truncateText(`[话题] ${topicTitle}`, TITLE_MAX_LENGTH),
          // 100 字符上限**作用于整条正文**（含发言人名）——它是出境面的宽度契约
          // （见文件头 [关键不变量]），不是"给摘要留 100 再随便加前缀"。
          body: truncateText(`${senderName}：${excerpt}`, NOTIFICATION_SUMMARY_MAX_LENGTH),
          link,
          recipient,
        };
      }
      case NOTIFY_CATEGORY.DOC_DELETED: {
        // ⚠️ **本类别刻意不回库**（P0 修复）：`doc.service.ts` 的删除是"**先软删、后发事件**"
        // （`set({ deletedAt })` 在前，`eventService.create(DOC_DELETED)` 在后）——事件到达时
        // doc 行已被 `@DeleteDateColumn` 软删过滤，`docRepo.findOne` **恒 null** ⇒ 通知静默
        // 全灭。故只信事件载荷：删除路径在软删**之前**读过 doc 行，把
        // `{ spaceId, docId, path, title }` 填进了 payload。
        // 代价：载荷字段缺失时标题退化为空串——比"永远收不到"好。
        const deletedPath = truncateText(String(payload.path ?? ''), TITLE_MAX_LENGTH);
        // v2 归属：空间名同样**只信载荷**（`payload.spaceId`）——doc 行已软删，拿不到它的 spaceId。
        // ⚠️ **订正一句曾写错的"不变量"**：这里**不能**假定"被删的是 doc 不是 space"。整空间删除
        //    （`docspace.service.ts` 的 `remove()`）在**同一事务**里先软删该空间的全部 doc、再软删
        //    space 行，之后才逐条 `emit` `DOC_DELETED` ⇒ 事件到达时 **space 行也已软删**。故
        //    `resolveDocSpaceName` 内部用 `withDeleted`（见其注释）；否则整空间删除场景下空间名
        //    会全数退化成 `空间「?」`——恰恰是本类通知最该说清楚的那件事。
        const spaceName = await this.resolveDocSpaceName(payload.spaceId);
        // 载荷是不可信输入：`title` 非字符串一律视同缺失（与 spaceId 同纪律，铁律 #21）
        const deletedTitle = typeof payload.title === 'string' ? payload.title : '';
        return {
          category,
          eventId: event.id,
          title: truncateText(`[文档删除] ${deletedPath}`, TITLE_MAX_LENGTH),
          // 同 task：空间名是**消息本体** ⇒ 200（见 NOTIFICATION_BODY_MAX_LENGTH 的取舍）
          body: truncateText(
            `空间「${spaceName}」 · ${deletedTitle}`,
            NOTIFICATION_BODY_MAX_LENGTH,
          ),
          link,
          recipient,
        };
      }
      case NOTIFY_CATEGORY.DOC_CREATED:
      case NOTIFY_CATEGORY.DOC_UPDATED:
      case NOTIFY_CATEGORY.DOC_MOVED: {
        const doc = await this.docRepo.findOne({ where: { id: event.resourceId } });
        if (!doc) return null;
        const path = truncateText(doc.path, TITLE_MAX_LENGTH);
        const prefix =
          category === NOTIFY_CATEGORY.DOC_CREATED
            ? '[新文档]'
            : category === NOTIFY_CATEGORY.DOC_MOVED
              ? '[文档移动]'
              : '[文档更新]';
        // v2 归属：`空间「<spaceName>」 · <doc.title>`——doc 行还活着，spaceId 直接从行上取
        // （不必信事件载荷）；space 行缺失 ⇒ `空间「?」`（降级不丢弃）。
        const spaceName = await this.resolveDocSpaceName(doc.spaceId);
        return {
          category,
          eventId: event.id,
          title: truncateText(`${prefix} ${path}`, TITLE_MAX_LENGTH),
          // 同 task：空间名 + 文档标题是**消息本体** ⇒ 200
          body: truncateText(`空间「${spaceName}」 · ${doc.title}`, NOTIFICATION_BODY_MAX_LENGTH),
          link,
          recipient,
        };
      }
      case NOTIFY_CATEGORY.DIRECT:
        // 直发链路不经本编排器（端点自己渲染 + 同步投递；见 plan §7.1）。防御性返回 null。
        return null;
      default:
        return null;
    }
  }

  // ─────────────────────── 归属信息（v2：看板 / 空间 / 显示名） ───────────────────────

  /**
   * 解析 actor 的**显示名**（v2 归属：任务的操作者 / 话题的发言人）。
   *
   * 走 `ActorProfileService.resolveProfiles`（**唯一**的名字回退链收口点：agent 名以
   * `agents.name` 为准、软删 actor 名字仍保留）——与 `topic.service.ts` 的 `senderName`
   * 注入是**同一份事实**；在本文件里自建第二份必然与它分叉。
   *
   * ⚠️ 归属是**旁挂信息**：actorId 缺失与真孤儿（actors 表无行，R12 不写进 Map）一律兜底 `?`，
   * **绝不让归属解析失败演变成整条通知被丢弃**。
   *
   * @param actorId 事件行的 `actorId`（可能为 null——事件行的 actor 是可空的）
   * @returns 显示名，或 `?`（无法解析）
   */
  private async resolveActorName(actorId: string | null | undefined): Promise<string> {
    if (!actorId) return ATTRIBUTION_FALLBACK;
    const profile = (await this.actorProfiles.resolveProfiles([actorId])).get(actorId);
    return profile?.name ?? ATTRIBUTION_FALLBACK;
  }

  /**
   * 解析**看板名**（v2 归属：这条任务通知属于哪张看板）。
   *
   * `event.boardId` 在 `task.service.ts` 是**可选键**（"拿不到 boardId 就省键"，见其 B-50-EVT
   * 注释）⇒ null 是**常态而非异常**，直接兜底 `?` 且**不查库**（省一次必然落空的往返）。
   *
   * @param boardId 事件行的 `boardId`（可能为 null）
   * @returns 看板名，或 `?`（缺键 / board 行缺失 / 已软删）
   */
  private async resolveBoardName(boardId: string | null | undefined): Promise<string> {
    if (!boardId) return ATTRIBUTION_FALLBACK;
    const board = await this.boardRepo.findOne({ where: { id: boardId } });
    return board?.name ?? ATTRIBUTION_FALLBACK;
  }

  /**
   * 解析 **DocSpace 名**（v2 归属：这条文档通知属于哪个空间）。
   *
   * 入参是 `unknown`：两个调用方一个给实体列（`doc.spaceId`，强类型 string），另一个给
   * **事件载荷**（`payload.spaceId`，`unknown`）——载荷是不可信输入，这里做一次收窄，
   * 非字符串/空串直接兜底 `?`（不把畸形值透传给 TypeORM，铁律 #21）。
   *
   * ⚠️ **`withDeleted: true` 是必须的，不是防御性写法**：整空间删除
   * （`docspace.service.ts` 的 `remove()`）在**同一事务**里先软删空间内的全部 doc、再软删
   * space 行，之后才逐条 emit `DOC_DELETED` ⇒ 事件到达时 space 行已被 `@DeleteDateColumn`
   * 过滤，不带 `withDeleted` 的 `findOne` **恒 null**，`doc_deleted` 的空间名会全数退化成
   * `空间「?」`。**归属名是历史事实**（这条通知当时属于哪个空间），行软删不改变这个事实，
   * 故读它是对的（与 `ActorProfileService` 的 `withDeleted` 收口同族口径）。
   * 无需 `addSelect('deletedAt')`：本方法只要 `name`，不投影软删信号（那是 `select: false` 列）。
   *
   * @param spaceId 空间 id（实体列或事件载荷值）
   * @returns 空间名，或 `?`（值畸形 / space 行确实不存在）
   */
  private async resolveDocSpaceName(spaceId: unknown): Promise<string> {
    if (typeof spaceId !== 'string' || spaceId.length === 0) return ATTRIBUTION_FALLBACK;
    const space = await this.docSpaceRepo.findOne({ where: { id: spaceId }, withDeleted: true });
    return space?.name ?? ATTRIBUTION_FALLBACK;
  }

  /**
   * 深链拼接（**单源**：所有链接都由 `NOTIFY_WEB_BASE_URL` + 资源路径构成）。
   *
   * 路径形态与直发端点的同源白名单一致（`^/(tasks|topics|docs|boards|experiences)/`，见 plan §7.1）。
   * 未配基址 ⇒ null（不伪造相对链接——手机点不开相对链接，那是"最后一厘米"失效）。
   */
  private buildLink(category: NotifyCategory, event: Event): string | null {
    const base = this.settings.webBaseUrl;
    if (!base) return null;
    switch (category) {
      case NOTIFY_CATEGORY.TASK_DONE:
      case NOTIFY_CATEGORY.TASK_CREATED:
      case NOTIFY_CATEGORY.TASK_UPDATED:
      case NOTIFY_CATEGORY.TASK_ASSIGNED:
        return `${base}/tasks/${event.resourceId}`;
      case NOTIFY_CATEGORY.TOPIC:
        return event.topicId ? `${base}/topics/${event.topicId}` : null;
      case NOTIFY_CATEGORY.DOC_CREATED:
      case NOTIFY_CATEGORY.DOC_UPDATED:
      case NOTIFY_CATEGORY.DOC_DELETED:
      case NOTIFY_CATEGORY.DOC_MOVED:
        // 删除类别同样用 resourceId（= docId）：行虽已软删，深链仍指向同一 id
        return `${base}/docs/${event.resourceId}`;
      default:
        return null;
    }
  }

  // ─────────────────────────────── 投递 ───────────────────────────────

  /**
   * 投递一条成品通知（**只走收件人绑定的那个渠道** → 终态落库 → 失败计数）。
   *
   * 发送前打一行 INFO **对账锚点**（category + eventId + channel）——投递表只落终态、抑制类不落表，
   * 故"为什么没收到"与"这条行是哪次发送"都只能靠这一行 grep 对齐（plan §3 fail-open 代价的对策）。
   *
   * ⚠️ **为什么不再遍历全部 provider**（MINOR-3，2026-10-13 复核）：投递地址是**某个渠道上的
   * 地址**（飞书 = open_id），把它交给另一个 provider 只会得到一次必然失败、且把失败记在无关
   * 渠道账上的投递（投递行是"尝试过一次"的语义，那条账会指向错误的方向）。直发链路已在批 2
   * 棒 B 收窄到 `target.provider`，事件链路这里对齐它。
   *
   * @param rendered 成品通知
   * @param recipientUserId **这条投递归属的平台用户**（`users.id`）——批 2 棒 B 的四路径贯通之一
   *   （编排器 deliver / L2 摘要 / 直发 / test）。事件链路给 `recipient.userId`，摘要给窗口的
   *   `recipientUserId`。落 `notification_deliveries.recipient_user_id`（admin 列表按人过滤的
   *   唯一依据；NULL 语义 = "尚未归属"，**不是**"不属于任何人"）。
   * @param recipientProvider **该收件人的主渠道 token**（快照 `channels[0].provider`）——
   *   投递地址属于这个渠道，只能经它出境（见上）。
   * @returns 真实终态；**`null` = 该渠道未装配**（`dropped [no_provider]`，不落表）。
   *   两个既有调用点（事件链路 / L2 摘要 flush）是**语句式 await、忽略返回值**——本签名扩展
   *   对它们零行为变化；系统告警端口（`sendSystemAlert`）需要区分 `null` 与 failed 才读它。
   */
  private async deliver(
    rendered: RenderedNotification,
    recipientUserId: string | null,
    recipientProvider: string,
  ): Promise<DeliveryOutcome | null> {
    // 两条"没有可用出口"的路径打**同一行** `dropped [no_provider]`（对齐直发的 `no_provider`
    // 语义；事件链路没有信封，它的"降级信封"就是这一行日志 + 不落表）：
    //   ① 部署根本没配出口；② 收件人绑的那个渠道**不在本部署的出口列表里**（理论分支：用户绑了
    //      一个部署没启用的 token）。两者对运维的动作相同（去把出口配好）。
    const providerImpl = this.providers.find((candidate) => candidate.key === recipientProvider);
    if (!providerImpl) {
      // 没有出口 = 没有投递尝试 ⇒ **不落表**（投递行的语义是"尝试过一次"，见 repository 文件头）。
      // 启动时工厂已 warn 一行；每次丢弃再打一行 INFO 供逐条对账。
      this.logger.log(
        `dropped [no_provider] category=${rendered.category} eventId=${rendered.eventId ?? '-'} ` +
          `recipient=${recipientUserId ?? '-'} provider=${recipientProvider}`,
      );
      return null;
    }

    const provider = providerImpl;
    this.logger.log(
      `sending category=${rendered.category} eventId=${rendered.eventId ?? '-'} channel=${provider.key}`,
    );
    // ⚠️ 端口契约要求 provider **never-throw**，但那是 TypeScript 签名表达不了的运行时约束
    //    （签名只有 `Promise<DeliveryOutcome>`）。违约的 provider 会让整条 fire-and-forget
    //    管线 reject（Node 22 默认崩进程）——故这里兜底成**合成 failed 终态**：
    //    一次投递失败必须始终表现为一行投递记录，而不是一次未捕获 rejection。
    const outcome = await this.sendThroughProvider(provider, rendered);
    await this.deliveryRepo.record({
      channel: provider.key,
      recipient: rendered.recipient,
      category: rendered.category,
      eventId: rendered.eventId,
      title: rendered.title,
      body: rendered.body,
      outcome,
      recipientUserId,
    });
    this.noteDeliveryOutcome(outcome.status, rendered.category);
    return outcome;
  }

  /**
   * 调一次 provider 并把任何抛出**合成为 failed 终态**（端口 never-throw 契约的运行时兜底）。
   *
   * ⚠️ **公开（S4）**：两个调用点——事件链路（本文件的 `deliver()`）与直发链路
   * （`NotifyDirectService.send()`）。两边都必须走这一个兜底：各自写一份 try/catch 意味着
   * "一处漏了兜底 ⇒ 一次未捕获 rejection / 一次没有账本的发送"，且两份实现迟早会分叉。
   *
   * @param provider 出口实现（契约上不该抛；**唯二**调用点见上）
   * @param rendered 成品通知
   * @returns 真实终态，或合成的 failed 终态
   */
  async sendThroughProvider(
    provider: NotifyProvider,
    rendered: RenderedNotification,
    opts?: NotifySendOptions,
  ): Promise<DeliveryOutcome> {
    try {
      return await provider.send(rendered, opts);
    } catch (err) {
      // 只收短描述：**绝不回显响应体原文 / secret**（写入侧另有 500 字符截断）
      const reason = truncateText(String(err), 200);
      this.logger.error(
        `provider ${provider.key} threw despite the never-throw contract (synthesised a failed ` +
          `outcome): ${reason}`,
      );
      return {
        status: 'failed',
        attempts: 1,
        responseStatus: null,
        lastError: `provider threw: ${reason}`,
        deliveredAt: null,
      };
    }
  }

  /**
   * 记录投递结果并做周期性失败告警（plan §3：连续 5 条 failed ⇒ warn 一行，然后重新计数）。
   *
   * ⚠️ **公开（S4）**：两个调用点——事件链路（本文件的 `deliver()`）与直发链路
   * （`NotifyDirectService.runDirectPipeline()` 落库后）。两条链路**必须共用同一个计数**：
   * 直发的失败同样不能只躺在投递表里等人去查（agent 侧只拿到 `delivered=0`，运维侧的信号就是
   * 这一行 warn）；各记各的计数会让"连续 5 条"永远凑不满（被互相稀释）。
   *
   * @param status 终态
   * @param category 类别（告警文案里带上，便于定位是哪条链路在失败）
   */
  noteDeliveryOutcome(status: 'success' | 'failed', category: NotificationDeliveryCategory): void {
    // switch 而非 `status === 'success'`：本仓 ESLint 规则 no-magic-string-compare 禁止字面量
    // 比较，而本值域只有两态、不值得为此再造一份状态常量（switch case 不在该规则检测面内）。
    switch (status) {
      case 'failed':
        this.consecutiveFailures += 1;
        break;
      default:
        // 成功：单次成功即复位（观测面只有「连续失败」一个信号——见文件头 fail-open 口径）
        this.consecutiveFailures = 0;
        return;
    }
    if (this.consecutiveFailures >= CONSECUTIVE_FAILURE_WARN_THRESHOLD) {
      this.logger.warn(
        `${this.consecutiveFailures} consecutive notification delivery failures (last category=` +
          `${category}) — check the provider credentials/network; delivery rows are in ` +
          'notification_deliveries. See .env.example.',
      );
      // 重新计数：下一条失败会重新累积到阈值再报，避免刷屏
      this.consecutiveFailures = 0;
    }
  }

  // ─────────────────────────────── 工具 ───────────────────────────────

  /**
   * fire-and-forget 派发（**唯一允许的 void promise 形态**，见文件头 [关键不变量]）。
   *
   * 为什么不直接 `void p`：Nest 的 `@OnEvent` 包装只覆盖回调本身，回调内启动的 promise 的
   * rejection 会成为**未捕获 rejection** ⇒ Node 22 默认崩进程（本仓无全局处理器）。
   *
   * @param promise 待派发的 promise
   * @param context 出错时的日志前缀（定位是哪条链路）
   */
  private fireAndForget(promise: Promise<void>, context: string): void {
    promise.catch((err) => {
      this.logger.error(`${context} failed (swallowed): ${String(err)}`);
    });
  }
}
