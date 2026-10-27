'use client';

/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 记忆项目创建 Dialog（`POST /memory/projects`）——本仓**首个 web 写路径**
 *
 * [代码职责]
 *   - 只做"表单 + 提交 + 错误面"这一件事；创建成功后的刷新/选中时序由父页面
 *     （`app/(main)/memory/page.tsx`）承担（`onCreated` 回调），组件不碰 queryClient
 *
 * [权威文档]
 *   - 合同源: apps/backend/src/modules/memory/dto/project.dto.ts（CreateMemoryProjectDto）
 *   - 错误面: apps/backend/src/modules/memory/memory-project.service.ts（400 两形态 / 409/14002 / 503 四 reason）
 *   - 设计基线: 线上 docs/frontend/ui-design-system.md §3/§4/§5（工具类红线 / 组件基线 / 动效）
 *
 * [关键不变量]
 *   - **不声明 `aria-modal`**：本 Dialog 没有 focus trap / inert，声明它等于假声明
 *     （键盘 Tab 仍会跑到背后内容上），比不声明更糟——先例 = `components/ui/sheet.tsx:19`。
 *     有 role="dialog" + aria-labelledby，键盘能到、Esc 能关、焦点在打开时进首字段。
 *   - **被动关闭只在"无未保存后果"时允许**（N6 + m-1）：`isPending`（提交中）与
 *     `submitError`（错误态）期间，遮罩点击与 Esc **都不关**——关窗 = 卸载 = 清空已填值，
 *     会让"错误态保留已填值 / 保持 slug 与项目名不变再试一次"的承诺失效。
 *     取消按钮**保留可用**（明确点击 = 有权放弃）。
 *   - **bindings 是数组（1~20 条、类型可混绑）**：后端 `@ArrayNotEmpty @ArrayMaxSize(20)`；
 *     故界面是「已选列表 + 添加行」的编辑器，不是单条选择器。载荷只发 `type`+`id`
 *     （`toBindingPayload` 剥掉仅用于展示的 `label`——DTO 是白名单校验，多一个键就 400）。
 *   - **重复防护 = 禁用添加 + 可见提示**（不是"添加后去重"）：去重是"先接受再撤回"，
 *     用户看到列表闪一下又变回去且无法解释；禁用 + 可见文案把因果摆在点击之前。
 *   - **引擎三键是三态**（M-1）：全填 / 全空 / **部分填**。部分填在**任何**部署模式下都必 400
 *     （后端 `normalizeEngineBinding` 缺一即错），必须禁用提交；全空仅"自助开通可用"时合法
 *     （自动注册），不可用时同样禁用。禁用原因按成因分开写（部分填 ≠ 自助开通不可用）。
 *   - **slug 禁止静默自动填充**：slug 是不可撤销动作（`engine=hument` 时会作为引擎侧
 *     workspace 注册），由机器替用户"猜"一个只会在出错时暴露。仅提供行内预校验。
 *   - **引擎三键"全缺 / 全显式"二态**：`provisioningAvailable !== true` 时缺一即提交禁用
 *     （部分缺后端必 400）；`=== true` 时三键全留空 = 自助开通（自动 Hub 注册）。
 *   - **候选集合 = 调用者本人可读**（否则选了必 400）：目标下拉直接消费
 *     `Api.topics.list` / `Api.boards.list` / `Api.docs.listSpaces`——**依赖后端按白名单过滤**，
 *     前端**不**二次过滤（不猜后端语义）。
 *   - **错误分叉以响应体为凭据**（不是 HTTP 状态直觉）：400 有 `data.errors` ⇒ 表单形状错；
 *     无 ⇒ 语义错（绑定不可读 / 引擎字段缺失）；503 读 `data.data.reason` 四值翻人话。
 *     **服务端 message 不作主文案**（可能含 `GET /memory/...` 路径），只作次级兜底。
 *
 * [关联代码]
 *   - ../../app/(main)/memory/page.tsx — 唯一挂载点（入口按钮 + 空态 CTA + onCreated 时序）
 *   - ../../lib/memory.ts — 入参/投影类型、slug 正则、三键字段名、provisioning 三态读法
 *   - ../../lib/notify.ts — toast（成功/失败反馈，带 aria-live）
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认键盘动线与禁用说明仍完整（禁用而无解释 = 死胡同）
 *   □ 新增字段必须与后端 CreateMemoryProjectDto 同步，并补错误分叉
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { AlertTriangle, Loader2, X } from 'lucide-react';
import {
  ErrorCode,
  MEMORY_BINDING_TYPE,
  MEMORY_BINDING_TYPES,
  MEMORY_ENGINE,
  MEMORY_UNAVAILABLE_REASON,
  type MemoryBindingType,
  type MemoryEngine,
} from '@agent-chamber/shared';
import { Api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from '@/lib/notify';
import {
  MEMORY_BINDING_MAX_COUNT,
  MEMORY_BINDING_TARGET_PAGE_SIZE,
  MEMORY_ENGINE_BINDING_FIELDS,
  MEMORY_PROJECT_NAME_MAX_LENGTH,
  MEMORY_PROJECT_SLUG_MAX_LENGTH,
  MEMORY_PROJECT_SLUG_PATTERN,
  memoryProvisioningAvailable,
  type MemoryCreateProjectInput,
  type MemoryProjectDto,
} from '@/lib/memory';

/** 绑定目标下拉的一个候选（统一 topic/board/docSpace 三种来源的形状） */
interface MemoryBindingTarget {
  id: string;
  label: string;
}

/**
 * 已选绑定（多绑列表编辑器的一行）。
 *
 * `label` 只在**界面**上用于"哪一条"（后端只收 `type` + `id`）：提交时经
 * `toBindingPayload` 剥掉，避免把展示名混进请求体（后端 DTO 是白名单校验，多一个键就 400）。
 */
interface MemorySelectedBinding {
  type: MemoryBindingType;
  id: string;
  label: string;
}

/** 已选绑定的行标识（type+id 唯一 ⇒ 兼作去重判据、React key 与焦点恢复键） */
function bindingRowKey(binding: Pick<MemorySelectedBinding, 'type' | 'id'>): string {
  return `${binding.type}:${binding.id}`;
}

/** 已选绑定 → 提交载荷（**只取 type/id**，剥掉仅用于展示的 label） */
function toBindingPayload(
  bindings: readonly MemorySelectedBinding[],
): { type: MemoryBindingType; id: string }[] {
  return bindings.map((binding) => ({ type: binding.type, id: binding.id }));
}

/** 绑定类型 → 人话标签（显式字面量：next-intl key 有编译期校验，禁动态拼 key。列表行与下拉共用） */
function bindingTypeLabel(
  t: ReturnType<typeof useTranslations<'memory'>>,
  type: MemoryBindingType,
): string {
  if (type === MEMORY_BINDING_TYPE.TOPIC) return t('project.form.bindingTypeTopic');
  if (type === MEMORY_BINDING_TYPE.BOARD) return t('project.form.bindingTypeBoard');
  return t('project.form.bindingTypeDocSpace');
}

/** 字段级错误（键与表单字段一一对应；空对象 = 无错） */
interface MemoryCreateFieldErrors {
  name?: string;
  slug?: string;
  engine?: string;
  target?: string;
}

/**
 * 创建请求失败 → 结构化判据（**响应体是唯一凭据**）。
 *
 * 层级提醒：`apiRequest` 只在**成功**时剥 `data`；错误对象里是原始响应体
 * `{code, message, data}`，故 `errors`/`field`/`reason` 都在 `response.data.data`。
 */
interface MemoryCreateErrorShape {
  status: number | null;
  code: number | null;
  /** `data.errors` 是否存在（class-validator 形状错的特征） */
  hasShapeErrors: boolean;
  /** `data.field`（引擎三键缺失时指名字段） */
  field: string | null;
  /** `data.data.reason`（503 的机器可读孪生） */
  reason: string | null;
  /** `data.data.engineCode`（provisioning_failed 的附带因） */
  engineCode: string | null;
  /** 服务端 message（**只作次级兜底**，主文案一律前端出） */
  message: string | null;
}

/** 从 axios 错误里读出创建失败的结构化判据 */
function readCreateError(error: unknown): MemoryCreateErrorShape {
  const err = error as {
    response?: {
      status?: number;
      data?: { code?: number; message?: string; data?: Record<string, unknown> };
    };
  };
  const response = err?.response;
  const body = response?.data;
  const inner = (body?.data ?? {}) as Record<string, unknown>;
  return {
    status: response?.status ?? null,
    code: body?.code ?? null,
    hasShapeErrors: Array.isArray(inner.errors),
    field: typeof inner.field === 'string' ? inner.field : null,
    reason: typeof inner.reason === 'string' ? inner.reason : null,
    engineCode: typeof inner.engineCode === 'string' ? inner.engineCode : null,
    message: typeof body?.message === 'string' ? body.message : null,
  };
}

/**
 * 凭据引用名"看起来像真密钥"的形态（**与后端 `MEMORY_CREDENTIAL_REF_PATTERN` 逐字对齐**）。
 *
 * 后端闸门 = `/^(apikey|sk)[_-]/i`（前缀 + 下划线**或连字符**、大小写不敏感）；
 * 前端预警 = 同一形态的**提前**提示（别等 400）。**两侧不许各自演化**：漏掉 `sk-`/大写形态
 * 会让 KEY_SHAPED 400 落到「语义错」分支，真因被权限文案盖住（M-2 实证）。
 */
const CREDENTIAL_LIKE_PATTERN = /^(apikey|sk)[_-]/i;

/** 该凭据引用名是否长得像真密钥（行内预警用；最终仍由后端 KEY_SHAPED 闸门裁决） */
function credentialLooksLikeSecret(value: string): boolean {
  return CREDENTIAL_LIKE_PATTERN.test(value.trim());
}

/**
 * 绑定目标候选取数（按类型分派到后端已有的三个列表端点）。
 *
 * **依赖后端"只返回调用者本人可读资源"的白名单过滤**（N7 验证项）：前端不二次过滤、
 * 也不猜可见性——否则会出现"下拉里选了必 400"的候选。
 *
 * @param type - 绑定资源类型（topic / board / docSpace）
 * @returns 候选（id + 展示名）
 */
async function loadBindingTargets(type: MemoryBindingType): Promise<MemoryBindingTarget[]> {
  const params = { page: 1, pageSize: MEMORY_BINDING_TARGET_PAGE_SIZE };
  if (type === MEMORY_BINDING_TYPE.TOPIC) {
    const res = await Api.topics.list(params);
    return res.items.map((topic) => ({ id: topic.id, label: topic.title }));
  }
  if (type === MEMORY_BINDING_TYPE.BOARD) {
    const res = await Api.boards.list(params);
    return res.items.map((board) => ({ id: board.id, label: board.name }));
  }
  const res = await Api.docs.listSpaces(params);
  return res.items.map((space) => ({ id: space.id, label: space.name }));
}

interface MemoryProjectCreateDialogProps {
  /** 开关（受控） */
  open: boolean;
  /** 开关回调 */
  onOpenChange: (open: boolean) => void;
  /** 部署级自助开通开关（`undefined`/`false` 一律按不可用，见 `memoryProvisioningAvailable`） */
  provisioningAvailable: boolean | undefined;
  /**
   * 创建成功回调（父页面负责"先 await refetch 再 setProjectId"的时序）。
   *
   * 组件**不**自己关窗：关窗与选中都收口在父页面，避免出现"选择器还没刷新就选中"的空值窗口。
   */
  onCreated: (project: MemoryProjectDto) => void | Promise<void>;
}

/**
 * 记忆项目创建 Dialog（仅在 `open` 时挂载表单体 ⇒ 每次打开都是全新初值，无脏值残留）。
 */
function MemoryProjectCreateDialog({
  open,
  onOpenChange,
  provisioningAvailable,
  onCreated,
}: MemoryProjectCreateDialogProps) {
  if (!open) return null;
  return (
    <MemoryProjectCreateForm
      provisioningAvailable={memoryProvisioningAvailable(provisioningAvailable)}
      onOpenChange={onOpenChange}
      onCreated={onCreated}
    />
  );
}

/**
 * 表单体（挂在 Dialog 打开期间）。
 *
 * 初值走 `useState` 初始化器而不是"打开时 setState 的 effect"——先例
 * `experience-form-dialog.tsx` 文件头第 1 条（那个写法在不稳定依赖下会触发
 * Maximum update depth）。
 */
function MemoryProjectCreateForm({
  provisioningAvailable,
  onOpenChange,
  onCreated,
}: {
  provisioningAvailable: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (project: MemoryProjectDto) => void | Promise<void>;
}) {
  const t = useTranslations('memory');

  // ── 表单状态（字段顺序 = name → slug → engine → bindings，人先命名、机器标识后置）──────
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  /** engine 默认值**条件化**（N2）：只有显式可用才默认 hument，否则默认 none（不承诺） */
  const [engine, setEngine] = useState<MemoryEngine>(
    provisioningAvailable ? MEMORY_ENGINE.HUMENT : MEMORY_ENGINE.NONE,
  );
  const [bindingType, setBindingType] = useState<MemoryBindingType>(MEMORY_BINDING_TYPE.TOPIC);
  /** 「待选」目标（添加行里的下拉值；添加成功即清空回占位，便于连续添加同类型多个） */
  const [targetId, setTargetId] = useState('');
  /** 已选绑定列表（1~20，可混类型；提交载荷的来源） */
  const [selectedBindings, setSelectedBindings] = useState<MemorySelectedBinding[]>([]);
  /** 高级区（引擎三键）开关：错误分叉命中引擎字段时会自动展开 */
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [engineWorkspaceId, setEngineWorkspaceId] = useState('');
  const [engineActorId, setEngineActorId] = useState('');
  const [engineCredentialRef, setEngineCredentialRef] = useState('');
  const [fieldErrors, setFieldErrors] = useState<MemoryCreateFieldErrors>({});
  /** 提交失败的人类文案 + 服务端 message（次级兜底） */
  const [submitError, setSubmitError] = useState<{ primary: string; detail: string | null } | null>(
    null,
  );

  const nameRef = useRef<HTMLInputElement>(null);
  const slugRef = useRef<HTMLInputElement>(null);
  const typeRef = useRef<HTMLSelectElement>(null);
  const targetRef = useRef<HTMLSelectElement>(null);
  const engineWorkspaceRef = useRef<HTMLInputElement>(null);
  /** "待把焦点落到目标下拉"标记（切类型时置位，候选就绪后消费；见 handleBindingTypeChange） */
  const pendingTargetFocusRef = useRef(false);
  /**
   * 每行"移除"按钮的 ref（key = `type:id`）。
   *
   * 用途：移除一行后把焦点交给**相邻行**的移除按钮 —— 让键盘用户能在列表里连续删，
   * 而不是删一次就掉回 body（"焦点不丢"的可执行含义）。
   */
  const removeButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  /**
   * 移除后的待落焦点：`undefined` = 无请求；`null` = 列表已空（回**类型下拉**）；
   * 其余 = 目标行的移除按钮 key。用 ref 而不是 state：它是"一次性动作信号"，不是渲染输入。
   */
  const pendingRemoveFocusRef = useRef<string | null | undefined>(undefined);

  // ── 目标候选三态（加载中 / 空 / 失败）─────────────────────────────────────────
  const targetQuery = useQuery({
    queryKey: ['memory', 'create', 'binding-targets', bindingType],
    queryFn: () => loadBindingTargets(bindingType),
    // 只在对话框挂载（= open）时才取数；列表类 query 显式关掉窗口聚焦重取（第 41 条口径）
    refetchOnWindowFocus: false,
    retry: 1,
  });
  const targets = targetQuery.data ?? [];

  /**
   * 提交（无幂等键 ⇒ 关掉 mutation 自动重试）。
   *
   * 全局 `mutations.retry: 1`（`app/providers.tsx`）会对一个**没有幂等键**的写请求
   * 自动重发一次——首次已落库但响应丢失时，重发会撞 409 并把"我刚建成了"误报成"标识被占用"。
   * 故此处显式 `retry: false`（已知债 R-6 的前端侧收口：宁可让用户自己按重试）。
   */
  const createMutation = useMutation({
    mutationFn: (input: MemoryCreateProjectInput) => Api.memory.create(input),
    retry: false,
    onSuccess: async (created) => {
      toast.success({ title: t('project.created'), description: created.name });
      await onCreated(created);
    },
    onError: (error: unknown) => {
      applyCreateError(error);
    },
  });

  const isPending = createMutation.isPending;

  /** 引擎三键是否全缺（trim 口径：空白 = 未给，与后端 `isBlankEngineField` 一致） */
  const engineTripleBlank =
    engineWorkspaceId.trim().length === 0 &&
    engineActorId.trim().length === 0 &&
    engineCredentialRef.trim().length === 0;
  /** 引擎三键是否全填（全填 = 显式复用已有 workspace，走后端手工分支） */
  const engineTripleFilled =
    engineWorkspaceId.trim().length > 0 &&
    engineActorId.trim().length > 0 &&
    engineCredentialRef.trim().length > 0;

  /**
   * **部分填**是三态里的第三种（M-1 实证：`engineTripleBlank` 只是"全空"，不等于"不完整"）。
   *
   * 后端 `normalizeEngineBinding` 对"部分缺"一律 400（`engineBindingFieldError`，缺一即错），
   * 与部署是否启用自助开通**无关**——所以两种模式下部分填都必须禁用提交。
   */
  const enginePartial = !engineTripleBlank && !engineTripleFilled;

  /**
   * 引擎三键不完整（C-6 + M-1）：
   * - 任何模式下**部分填** ⇒ 必 400 ⇒ 禁用；
   * - 自助开通**不可用**时**全空** ⇒ 也必 400 ⇒ 禁用；
   * - 自助开通**可用**时全空 ⇒ **合法**（自动注册主路径），**必须放行**。
   */
  const engineTripleIncomplete =
    engine === MEMORY_ENGINE.HUMENT &&
    (enginePartial || (!provisioningAvailable && engineTripleBlank));

  /**
   * 已达绑定条数上限（后端 `@ArrayMaxSize(20)`）：到顶即禁用"添加"并写明原因，
   * 不让用户填到第 21 条才吃 400。
   */
  const bindingMaxReached = selectedBindings.length >= MEMORY_BINDING_MAX_COUNT;

  /**
   * 待选目标是否**已在列表里**（重复防护）。
   *
   * 采用「**禁用添加** + 可见提示」而不是「添加后去重」：去重是"先接受再撤回"，
   * 用户会看到列表闪一下又变回去，且无法解释为什么；禁用 + 可见文案把因果摆在点击之前
   * （title 只作鼠标补充，**可见文本**才是键盘/触屏/读屏都能读到的那个）。
   */
  const bindingDuplicate =
    targetId.length > 0 &&
    selectedBindings.some((binding) => binding.type === bindingType && binding.id === targetId);

  /** 「添加」按钮可否点击（未选目标 / 重复 / 到顶 / 提交中都不可加） */
  const addDisabled = isPending || targetId.length === 0 || bindingDuplicate || bindingMaxReached;

  /**
   * 提交禁用（C-2 + C-6 + M-1 + 多绑）：**绑定列表为空** / 引擎三键不完整。
   * 「待选目标」不参与判据 —— 没点"添加"就还没进列表，那不是一条绑定。
   */
  const submitDisabled = isPending || selectedBindings.length === 0 || engineTripleIncomplete;

  /**
   * 三键不完整的**人话原因**（按成因二选一）。
   *
   * 为什么分开：把「可用态下部分填」说成「自助开通不可用」是错误归因（M-1 指出的文案承诺
   * 与逻辑不符）。部分填 = 形态错（任何模式），全空 = 自助开通不可用（仅不可用态）。
   */
  const engineIncompleteText = enginePartial
    ? t('project.form.engineTriplePartial')
    : t('project.form.engineTripleRequired');

  /** 禁用原因（禁用而无解释 = 死胡同，第 39 条口径）：只在禁用且非 pending 时给一行 */
  const disabledReason = isPending
    ? null
    : selectedBindings.length === 0
      ? t('project.form.bindingEmpty')
      : engineTripleIncomplete
        ? engineIncompleteText
        : null;

  /**
   * "添加"按钮被禁用的**鼠标补充提示**（可见文本另行渲染：重复 / 到顶各有行内提示；
   * 未选目标则由目标下拉的占位文案自解释）。
   */
  const addHint = bindingDuplicate
    ? t('project.form.bindingDuplicate')
    : targetId.length === 0
      ? t('project.form.targetRequired')
      : undefined;

  /**
   * 把焦点落到**绑定区**：待选目标下拉可用就落它（那是下一步动作），
   * 否则退到类型下拉（恒可用，是绑定区的入口）——保证"报错必须能落到字段上"永不为空操作。
   */
  const focusBindingArea = () => {
    const targetSelect = targetRef.current;
    if (targetSelect && !targetSelect.disabled) {
      targetSelect.focus();
      return;
    }
    typeRef.current?.focus();
  };

  /** 聚焦第一个出错字段（键盘与读屏用户的动线：报错必须能落到字段上） */
  const focusFirstError = (errors: MemoryCreateFieldErrors) => {
    if (errors.name) nameRef.current?.focus();
    else if (errors.slug) slugRef.current?.focus();
    else if (errors.engine) engineWorkspaceRef.current?.focus();
    else if (errors.target) focusBindingArea();
  };

  /**
   * 失败 → 字段级映射（**响应体判据**，见文件头不变量）。
   *
   * 分叉：
   * - 409/14002 → slug 红字（服务端 message 含 `GET /memory/projects?slug=...` 路径，**不透传**）
   * - 400 有 `data.errors` → 表单形状错：聚焦目标下拉（本表单唯一"必然导致形状错"的字段）
   * - 400 无 `data.errors` 但 `data.field` 是引擎三键 → 引擎绑定信息不完整（**字段名不上屏**）+ 展开高级区
   * - 其余 400 → 语义错：绑定不可读 → 目标下拉红字（权限）
   * - 503/14000 → 读 `reason` 四值翻人话（**timeout 明说"保持 slug 与项目名不变再试一次"**）
   */
  const applyCreateError = (error: unknown) => {
    const info = readCreateError(error);

    if (info.status === 409 && info.code === ErrorCode.MEMORY_PROJECT_CONFLICT) {
      setFieldErrors({ slug: t('project.createError.slugTaken') });
      slugRef.current?.focus();
      return;
    }

    const engineFieldNamed =
      info.field !== null && MEMORY_ENGINE_BINDING_FIELDS.some((field) => field === info.field);
    if (info.status === 400 && (info.field === null || engineFieldNamed)) {
      if (info.hasShapeErrors) {
        // 表单形状错（class-validator）：把用户带回**绑定区**（本表单唯一"必填的列表"字段）
        setFieldErrors({ target: t('project.form.bindingEmpty') });
        focusBindingArea();
        return;
      }
      if (info.field !== null) {
        // 引擎三键缺失：人话 + 自动展开高级区（字段名不上屏）
        setAdvancedOpen(true);
        setFieldErrors({ engine: t('project.createError.engineField') });
        engineWorkspaceRef.current?.focus();
        return;
      }
      // 语义 400（无 shape errors、无 field）——本端点最典型的是"绑定资源不可读"（后端
      // `assertBindingsResolvable`），但也可能是 KEY_SHAPED 凭据形态错等同状态/同码的语义错
      // ⇒ 主文案给权限说明，**同时**把服务端 message 作为次级兜底显示（M-2：真因不许被吞）。
      setFieldErrors({ target: t('project.createError.targetForbidden') });
      setSubmitError({ primary: t('project.createError.targetForbidden'), detail: info.message });
      focusBindingArea();
      return;
    }

    if (info.status === 503 && info.code === ErrorCode.MEMORY_UNAVAILABLE && info.reason !== null) {
      setSubmitError({
        primary: provisioningReasonText(t, info.reason),
        detail: info.message,
      });
      return;
    }

    setSubmitError({ primary: t('project.createError.generic'), detail: info.message });
  };

  /** 提交（客户端形状校验 → 装配 payload → mutation） */
  const submitForm = () => {
    if (isPending) return;
    setSubmitError(null);

    const errors: MemoryCreateFieldErrors = {};
    if (name.trim().length === 0) errors.name = t('project.form.nameRequired');
    if (slug.trim().length === 0) errors.slug = t('project.form.slugRequired');
    else if (!MEMORY_PROJECT_SLUG_PATTERN.test(slug.trim()))
      errors.slug = t('project.form.slugInvalid');
    if (engineTripleIncomplete) errors.engine = engineIncompleteText;
    if (selectedBindings.length === 0) errors.target = t('project.form.bindingEmpty');

    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      focusFirstError(errors);
      return;
    }
    setFieldErrors({});

    const input: MemoryCreateProjectInput = {
      name: name.trim(),
      slug: slug.trim(),
      // 1~20 条、类型可混绑（后端 `@ArrayNotEmpty @ArrayMaxSize(20)`）；只发 type+id
      bindings: toBindingPayload(selectedBindings),
      engine,
    };
    // 引擎三键只在 hument 且**三键全填**时发送：全空 = 自助开通（省略键 = 后端三分支的"全缺"）；
    // 部分填已被 submitDisabled/校验挡住，这里再收一道（payload 不许携带半截绑定）
    if (engine === MEMORY_ENGINE.HUMENT && engineTripleFilled) {
      input.engineWorkspaceId = engineWorkspaceId.trim();
      input.engineActorId = engineActorId.trim();
      input.engineCredentialRef = engineCredentialRef.trim();
    }
    createMutation.mutate(input);
  };

  /** 原生表单提交（点"创建"按钮 / 浏览器隐式提交） */
  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    submitForm();
  };

  /**
   * Enter 显式提交（键盘动线契约）。
   *
   * 为什么显式：浏览器对 `<form>` 的隐式提交（input 内按 Enter）在真实浏览器里成立，
   * 但**jsdom 不实现**隐式提交 —— 不显式接住这条路径，键盘动线就只能靠"人工开浏览器"
   * 验证，测试里恒绿/恒红。接住后：`preventDefault` 拦掉隐式提交，只跑一次 `submitForm`。
   */
  const handleFormKeyDown = (event: ReactKeyboardEvent<HTMLFormElement>) => {
    if (event.key !== 'Enter') return;
    if (!(event.target instanceof HTMLInputElement)) return;
    event.preventDefault();
    submitForm();
  };

  /**
   * slug 输入即**行内预校验**（不等提交、也不必先选好目标）。
   *
   * 为什么在 change 上做：slug 是"不可撤销 + 会被引擎注册"的动作，形状错了越早知道越好；
   * 只放在提交期会让"提交按钮因目标未选而禁用"顺带把 slug 的反馈也一起挡住。
   */
  const handleSlugChange = (value: string) => {
    setSlug(value);
    const trimmed = value.trim();
    setFieldErrors((prev) => ({
      ...prev,
      slug:
        trimmed.length > 0 && !MEMORY_PROJECT_SLUG_PATTERN.test(trimmed)
          ? t('project.form.slugInvalid')
          : undefined,
    }));
  };

  /**
   * 添加当前「待选目标」进已选列表。
   *
   * 三道前置守卫（与"添加"按钮的 disabled 条件一一对应；按钮之外没有任何别的入口，
   * 但守卫仍写在这里而不是只写在 UI 上——键盘 Enter 走的是同一条函数）：
   * 未选目标 / 重复（同 type+id）/ 已达 20 条上限。
   *
   * 添加后：目标下拉清空回占位（便于连续添加**同类型多个**）+ 焦点留在目标下拉（连续添加不断手）。
   */
  const handleAddBinding = () => {
    if (addDisabled) return;
    const label = targets.find((target) => target.id === targetId)?.label ?? targetId;
    setSelectedBindings((prev) => [...prev, { type: bindingType, id: targetId, label }]);
    setTargetId('');
    setFieldErrors((prev) => ({ ...prev, target: undefined }));
    targetRef.current?.focus();
  };

  /**
   * 从列表移除第 `index` 条，并把焦点交给"下一个可落脚点"（焦点不丢）。
   *
   * 落点规则（`pendingRemoveFocusRef` 在下方 effect 里消费）：
   * 删完还剩行 ⇒ 落在**同下标那一行**（原位置被后一行顶上）的移除按钮，删的是最后一行时退到新的最后一行；
   * 删空 ⇒ 落在**类型下拉**（绑定区的入口，恒可用）。
   */
  const handleRemoveBinding = (index: number) => {
    const next = selectedBindings.filter((_, rowIndex) => rowIndex !== index);
    setSelectedBindings(next);
    pendingRemoveFocusRef.current =
      next.length === 0 ? null : bindingRowKey(next[Math.min(index, next.length - 1)]);
  };

  /** 消费移除后的待落焦点（列表更新后才存在目标节点 ⇒ 必须在 effect 里落） */
  useEffect(() => {
    const pending = pendingRemoveFocusRef.current;
    if (pending === undefined) return;
    pendingRemoveFocusRef.current = undefined;
    if (pending === null) {
      typeRef.current?.focus();
      return;
    }
    removeButtonRefs.current.get(pending)?.focus();
  }, [selectedBindings]);

  /**
   * 切绑定类型：清空目标 + 把焦点**留给**目标下拉（旧目标属于旧类型，留着就是错绑定）。
   *
   * ⚠️ 这里**不能**直接 `targetRef.current?.focus()`（m-3 实证）：切类型后新候选还在加载，
   * 目标下拉此刻是 `disabled`，而 disabled 元素**不可聚焦** —— 直接 focus 是 no-op。
   * 正确做法 = 打一个"待聚焦"标记，等候选就绪的 effect 再落焦点（见下）。
   * **已选列表不受切换影响**（切类型只改"待选"，不碰"已选"）。
   */
  const handleBindingTypeChange = (next: MemoryBindingType) => {
    setBindingType(next);
    setTargetId('');
    setFieldErrors((prev) => ({ ...prev, target: undefined }));
    pendingTargetFocusRef.current = true;
  };

  /**
   * 候选就绪后把焦点落回目标下拉（消费 `handleBindingTypeChange` 打的标记）。
   *
   * deps 含 `bindingType` 而非只 `isSuccess`：切回一个**已缓存**的类型时不会经过
   * loading→success 的过渡（isSuccess 恒 true、effect 不重跑），只依赖 isSuccess 会漏聚焦。
   */
  useEffect(() => {
    if (!pendingTargetFocusRef.current) return;
    if (!targetQuery.isSuccess) return;
    pendingTargetFocusRef.current = false;
    targetRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在类型切换后（标记）且候选就绪时落焦点
  }, [bindingType, targetQuery.isSuccess]);

  /**
   * 是否禁止"被动关闭"（Esc / 遮罩点击）。
   *
   * - `isPending`：提交中关窗会让"错误态保留已填值"的承诺失效（N6）；
   * - `submitError !== null`：错误态关窗 = 卸载 = 清空已填值，与 timeout 重试纪律
   *   （"保持 slug 与项目名不变再试一次"）自相矛盾（m-1）。
   *
   * **取消按钮不在此列**：用户明确点"取消"是有权放弃（明确意图），继续可用。
   */
  const dismissBlocked = isPending || submitError !== null;

  /**
   * Esc 关闭（被动关闭期间禁用，见 `dismissBlocked`）。
   *
   * 监听挂 window 而不是面板：本 Dialog 无 focus trap，只挂面板内的话焦点在背后时
   * Esc 就失效了。先例 = `components/ui/sheet.tsx`。
   */
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (dismissBlocked) return;
      onOpenChange(false);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [dismissBlocked, onOpenChange]);

  /**
   * 遮罩点击：被动关闭期间不关（同 `dismissBlocked`）。遮罩是纯装饰（不在 Tab 序列里），
   * 用 `aria-hidden` 标注而非给 role。
   */
  const handleBackdropClick = () => {
    if (dismissBlocked) return;
    onOpenChange(false);
  };

  const targetIdState = targetQuery.isLoading
    ? t('project.form.targetLoading')
    : targetQuery.isError
      ? t('project.form.targetError')
      : targets.length === 0
        ? t('project.form.targetEmpty')
        : t('project.form.targetPlaceholder');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4">
      <div
        className="fixed inset-0 bg-black/60 backdrop-blur-sm"
        aria-hidden="true"
        onClick={handleBackdropClick}
      />
      <div
        role="dialog"
        aria-labelledby="memory-project-create-title"
        className="glass relative z-50 w-full max-w-lg rounded-xl p-6 shadow-lg animate-in fade-in zoom-in-95 duration-200 max-h-[90vh] overflow-y-auto"
      >
        <form onSubmit={handleSubmit} onKeyDown={handleFormKeyDown} noValidate>
          <div className="flex flex-col space-y-1.5">
            <h2
              id="memory-project-create-title"
              className="text-lg font-semibold leading-none tracking-tight"
            >
              {t('project.createTitle')}
            </h2>
            <p className="text-sm text-muted-foreground">{t('project.createDesc')}</p>
          </div>

          <div className="mt-4 space-y-4">
            {/* ── 名称 ─────────────────────────────────────────────────────── */}
            <div className="space-y-1.5">
              <label htmlFor="memory-create-name" className="text-sm font-medium">
                {t('project.form.name')}
              </label>
              <Input
                id="memory-create-name"
                ref={nameRef}
                data-testid="memory-create-name"
                // 打开即聚焦首字段（键盘/读屏用户的起点）
                autoFocus
                value={name}
                maxLength={MEMORY_PROJECT_NAME_MAX_LENGTH}
                onChange={(e) => setName(e.target.value)}
                aria-invalid={!!fieldErrors.name}
                aria-describedby={fieldErrors.name ? 'memory-create-name-error' : undefined}
              />
              {fieldErrors.name && (
                <p
                  id="memory-create-name-error"
                  role="alert"
                  data-testid="memory-create-name-error"
                  className="text-xs text-destructive"
                >
                  {fieldErrors.name}
                </p>
              )}
            </div>

            {/* ── slug（不可撤销动作，禁止自动填充；engine=hument 时是引擎侧注册标识）── */}
            <div className="space-y-1.5">
              <label htmlFor="memory-create-slug" className="text-sm font-medium">
                {t('project.form.slug')}
              </label>
              <Input
                id="memory-create-slug"
                ref={slugRef}
                data-testid="memory-create-slug"
                value={slug}
                maxLength={MEMORY_PROJECT_SLUG_MAX_LENGTH}
                onChange={(e) => handleSlugChange(e.target.value)}
                aria-invalid={!!fieldErrors.slug}
                aria-describedby={
                  fieldErrors.slug
                    ? 'memory-create-slug-hint memory-create-slug-error'
                    : 'memory-create-slug-hint'
                }
              />
              <p id="memory-create-slug-hint" className="text-xs text-muted-foreground">
                {t('project.form.slugHint')}
              </p>
              {fieldErrors.slug && (
                <p
                  id="memory-create-slug-error"
                  role="alert"
                  data-testid="memory-create-slug-error"
                  className="text-xs text-destructive"
                >
                  {fieldErrors.slug}
                </p>
              )}
              {/* 常驻警示（非 title 属性）：只在 engine=hument 且自助开通可用时给出不可撤销后果 */}
              {engine === MEMORY_ENGINE.HUMENT && provisioningAvailable && (
                <p
                  data-testid="memory-create-slug-irreversible"
                  className="flex items-start gap-1.5 text-xs text-amber-300"
                >
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  {t('project.form.slugIrreversible')}
                </p>
              )}
            </div>

            {/* ── 引擎 ─────────────────────────────────────────────────────── */}
            <div className="space-y-1.5">
              <label htmlFor="memory-create-engine" className="text-sm font-medium">
                {t('project.form.engine')}
              </label>
              <select
                id="memory-create-engine"
                data-testid="memory-create-engine"
                value={engine}
                onChange={(e) => setEngine(e.target.value as MemoryEngine)}
                className="h-10 w-full rounded-md border border-input bg-background/60 px-2 text-sm"
              >
                {/* 人话选项：none = 永久空壳必须交代（"搜索不可用"写进标签） */}
                <option value={MEMORY_ENGINE.HUMENT}>{t('project.form.engineHument')}</option>
                <option value={MEMORY_ENGINE.NONE}>{t('project.form.engineNone')}</option>
              </select>
              {engine === MEMORY_ENGINE.HUMENT &&
                (provisioningAvailable ? (
                  <p
                    data-testid="memory-create-provisioning-auto"
                    className="text-xs text-muted-foreground"
                  >
                    {t('project.form.provisioningAuto')}
                  </p>
                ) : (
                  <p
                    data-testid="memory-create-provisioning-unavailable"
                    className="text-xs text-amber-300"
                  >
                    {t('project.form.provisioningUnavailable')}
                  </p>
                ))}
            </div>

            {/* ── 高级区：引擎三键（仅在复用已有 Hub workspace 时需要）────────────── */}
            {engine === MEMORY_ENGINE.HUMENT && (
              <details
                open={advancedOpen}
                onToggle={(e) => setAdvancedOpen((e.target as HTMLDetailsElement).open)}
                className="rounded-md border border-border/60 p-3"
                data-testid="memory-create-advanced"
              >
                <summary className="cursor-pointer text-xs text-muted-foreground">
                  {t('project.form.advancedSummary')}
                </summary>
                <div className="mt-3 space-y-3">
                  <div className="space-y-1.5">
                    <label
                      htmlFor="memory-create-workspace"
                      className="text-xs text-muted-foreground"
                    >
                      {t('project.form.engineWorkspaceId')}
                    </label>
                    <Input
                      id="memory-create-workspace"
                      ref={engineWorkspaceRef}
                      data-testid="memory-create-workspace"
                      value={engineWorkspaceId}
                      onChange={(e) => setEngineWorkspaceId(e.target.value)}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label htmlFor="memory-create-actor" className="text-xs text-muted-foreground">
                      {t('project.form.engineActorId')}
                    </label>
                    <Input
                      id="memory-create-actor"
                      data-testid="memory-create-actor"
                      value={engineActorId}
                      onChange={(e) => setEngineActorId(e.target.value)}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label
                      htmlFor="memory-create-credential"
                      className="text-xs text-muted-foreground"
                    >
                      {t('project.form.engineCredentialRef')}
                    </label>
                    <Input
                      id="memory-create-credential"
                      data-testid="memory-create-credential"
                      value={engineCredentialRef}
                      onChange={(e) => setEngineCredentialRef(e.target.value)}
                      aria-describedby="memory-create-credential-hint"
                    />
                    <p id="memory-create-credential-hint" className="text-xs text-muted-foreground">
                      {t('project.form.engineCredentialRefHint')}
                    </p>
                    {/* 行内预警：像真密钥就当场提示（别等 400） */}
                    {credentialLooksLikeSecret(engineCredentialRef) && (
                      <p
                        role="alert"
                        data-testid="memory-create-credential-warning"
                        className="text-xs text-amber-300"
                      >
                        {t('project.form.credentialLooksReal')}
                      </p>
                    )}
                  </div>
                  {fieldErrors.engine && (
                    <p
                      role="alert"
                      data-testid="memory-create-engine-error"
                      className="text-xs text-destructive"
                    >
                      {fieldErrors.engine}
                    </p>
                  )}
                </div>
              </details>
            )}

            {/*
              引擎三键错误在高级区**折叠**时也要可见：折叠态下上面的 error 段落不渲染，
              用户会看不到原因（禁用/错误而无解释 = 死胡同）。
            */}
            {engine === MEMORY_ENGINE.HUMENT && !advancedOpen && fieldErrors.engine && (
              <p
                role="alert"
                data-testid="memory-create-engine-error"
                className="text-xs text-destructive"
              >
                {fieldErrors.engine}
              </p>
            )}

            {/*
              ── bindings：**多绑列表编辑器**（1~20 条、类型可任意混绑）─────────────
              后端契约是数组（`@ArrayNotEmpty @ArrayMaxSize(20)`），同类型多绑与混类型都是原生能力。
              结构 = 已选列表（顶部）+ 添加行（类型 → 目标 → 添加）；空列表**不渲染列表区**。
            */}
            <div className="space-y-3" data-testid="memory-create-bindings">
              {selectedBindings.length > 0 && (
                <div className="space-y-1.5">
                  <p className="text-sm font-medium" data-testid="memory-create-binding-count">
                    {t('project.form.bindingSelected', {
                      count: selectedBindings.length,
                      max: MEMORY_BINDING_MAX_COUNT,
                    })}
                  </p>
                  <ul className="space-y-1" data-testid="memory-create-binding-list">
                    {selectedBindings.map((binding, index) => {
                      const key = bindingRowKey(binding);
                      return (
                        <li
                          key={key}
                          data-testid="memory-create-binding-row"
                          className="flex items-center gap-2 rounded-md border border-border/60 px-2 py-1.5 text-xs"
                        >
                          <span className="shrink-0 text-muted-foreground">
                            {bindingTypeLabel(t, binding.type)}
                          </span>
                          <span className="min-w-0 flex-1 truncate">{binding.label}</span>
                          {/* type="button"（button.tsx 无默认 type 陷阱）+ 人话 aria-label（读屏可辨"删哪条"） */}
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-6 shrink-0 px-2"
                            data-testid="memory-create-binding-remove"
                            aria-label={t('project.form.bindingRemove', {
                              type: bindingTypeLabel(t, binding.type),
                              name: binding.label,
                            })}
                            onClick={() => handleRemoveBinding(index)}
                            ref={(node) => {
                              if (node) removeButtonRefs.current.set(key, node);
                              else removeButtonRefs.current.delete(key);
                            }}
                          >
                            <X className="h-3.5 w-3.5" />
                          </Button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}

              {/* 添加行：类型下拉 + 目标下拉（三态逻辑 / 焦点契约与单绑时代完全一致）+ 「添加」 */}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
                <div className="space-y-1.5">
                  <label htmlFor="memory-create-binding-type" className="text-sm font-medium">
                    {t('project.form.bindingType')}
                  </label>
                  <select
                    id="memory-create-binding-type"
                    ref={typeRef}
                    data-testid="memory-create-binding-type"
                    value={bindingType}
                    onChange={(e) => handleBindingTypeChange(e.target.value as MemoryBindingType)}
                    className="h-10 w-full rounded-md border border-input bg-background/60 px-2 text-sm"
                  >
                    {/* 三值显式字面量：next-intl key 有编译期校验，禁动态拼 key */}
                    {MEMORY_BINDING_TYPES.map((type) => (
                      <option key={type} value={type}>
                        {bindingTypeLabel(t, type)}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1.5">
                  <label htmlFor="memory-create-target" className="text-sm font-medium">
                    {t('project.form.bindingTarget')}
                  </label>
                  <select
                    id="memory-create-target"
                    ref={targetRef}
                    data-testid="memory-create-target"
                    value={targetId}
                    onChange={(e) => {
                      setTargetId(e.target.value);
                      setFieldErrors((prev) => ({ ...prev, target: undefined }));
                    }}
                    disabled={targetQuery.isLoading || targetQuery.isError || targets.length === 0}
                    aria-describedby={
                      fieldErrors.target
                        ? 'memory-create-target-error'
                        : bindingDuplicate
                          ? 'memory-create-binding-duplicate'
                          : undefined
                    }
                    className="h-10 w-full rounded-md border border-input bg-background/60 px-2 text-sm disabled:opacity-50"
                  >
                    <option value="">{targetIdState}</option>
                    {targets.map((target) => (
                      <option key={target.id} value={target.id}>
                        {target.label}
                      </option>
                    ))}
                  </select>
                </div>
                {/* 添加按钮：未选目标 / 重复 / 到 20 条上限 / 提交中 都不可点（守卫也在 handler 里再收一道） */}
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-10 shrink-0 px-3"
                  data-testid="memory-create-binding-add"
                  disabled={addDisabled}
                  title={addHint}
                  aria-describedby={
                    bindingDuplicate ? 'memory-create-binding-duplicate' : undefined
                  }
                  onClick={handleAddBinding}
                >
                  {t('project.form.bindingAdd')}
                </Button>
              </div>
            </div>

            {/* 目标三态：加载中 / 空（附"绑定即权限来源"说明）/ 失败（行内错误 + 重试） */}
            {targetQuery.isLoading && (
              <p
                data-testid="memory-create-target-loading"
                className="text-xs text-muted-foreground"
              >
                {t('project.form.targetLoading')}
              </p>
            )}
            {!targetQuery.isLoading && !targetQuery.isError && targets.length === 0 && (
              <p data-testid="memory-create-target-empty" className="text-xs text-muted-foreground">
                {t('project.form.targetEmpty')} {t('project.form.targetEmptyHint')}
              </p>
            )}
            {targetQuery.isError && (
              <p
                role="alert"
                data-testid="memory-create-target-error"
                className="flex flex-wrap items-center gap-2 text-xs text-destructive"
              >
                <span>{t('project.form.targetError')}</span>
                <Button
                  type="button"
                  variant="outline"
                  className="h-6 px-2"
                  data-testid="memory-create-target-retry"
                  onClick={() => void targetQuery.refetch()}
                >
                  {t('project.form.targetRetry')}
                </Button>
              </p>
            )}
            {fieldErrors.target && (
              <p
                id="memory-create-target-error"
                role="alert"
                data-testid="memory-create-target-field-error"
                className="text-xs text-destructive"
              >
                {fieldErrors.target}
              </p>
            )}
            {/* 重复防护（可见文本，不是只挂在 title 上）：键盘/触屏/读屏都能读到为什么加不进去 */}
            {bindingDuplicate && (
              <p
                id="memory-create-binding-duplicate"
                role="status"
                data-testid="memory-create-binding-duplicate"
                className="text-xs text-amber-300"
              >
                {t('project.form.bindingDuplicate')}
              </p>
            )}
            {/* 到后端 `@ArrayMaxSize(20)` 上限：提前禁添加 + 写明原因（不让用户填到第 21 条才吃 400） */}
            {bindingMaxReached && (
              <p
                role="status"
                data-testid="memory-create-binding-max"
                className="text-xs text-amber-300"
              >
                {t('project.form.bindingMaxReached', { max: MEMORY_BINDING_MAX_COUNT })}
              </p>
            )}
            {/* 分页上限 100 = 已登记已知限制（不静默截断） */}
            <p
              data-testid="memory-create-target-cap-note"
              className="text-[11px] text-muted-foreground/70"
            >
              {t('project.form.targetCapNote')}
            </p>
          </div>

          {/*
            提交失败：人类文案为主、服务端 message 为次级兜底。
            错误态**保留已填值**且**禁止被动关窗**（Esc/遮罩，见 `dismissBlocked`）——
            与 timeout 文案"保持 slug 与项目名不变再试一次"闭环（m-1）。
          */}
          {submitError && (
            <div
              role="alert"
              data-testid="memory-create-submit-error"
              className="mt-4 rounded-md border border-amber-500/40 bg-amber-500/10 p-2.5 text-xs text-amber-300"
            >
              <p className="flex items-start gap-1.5">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                {submitError.primary}
              </p>
              {submitError.detail && (
                <p
                  data-testid="memory-create-submit-error-detail"
                  className="mt-1 pl-5 font-mono text-[10px] opacity-70"
                >
                  {submitError.detail}
                </p>
              )}
            </div>
          )}

          <div className="mt-4 flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2">
            {disabledReason && (
              <p
                className="mr-auto self-center text-xs text-muted-foreground"
                data-testid="memory-create-disabled-note"
              >
                {disabledReason}
              </p>
            )}
            {/* 取消按钮显式 type="button"：button.tsx 无默认 type 陷阱（在 form 内会变成 submit） */}
            <Button
              type="button"
              variant="outline"
              data-testid="memory-create-cancel"
              disabled={isPending}
              onClick={() => onOpenChange(false)}
            >
              {t('project.form.cancel')}
            </Button>
            <Button
              type="submit"
              data-testid="memory-create-submit"
              disabled={submitDisabled}
              className="sm:ml-2"
            >
              {isPending && (
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin motion-reduce:animate-none" />
              )}
              {isPending
                ? engine === MEMORY_ENGINE.HUMENT
                  ? t('project.form.submittingProvisioning')
                  : t('project.form.submitting')
                : t('project.form.submit')}
            </Button>
          </div>

          {/* 时间预期（后端有 30s 善后墙钟）：只在可能触发 Hub 注册时给，避免日常创建也被这句话吓到 */}
          {engine === MEMORY_ENGINE.HUMENT && (
            <p className="mt-2 text-right text-[11px] text-muted-foreground/70">
              {t('project.form.provisioningTimeNote')}
            </p>
          )}
        </form>
      </div>
    </div>
  );
}

/**
 * 503 provisioning reason → 人话（四值显式分支：next-intl key 有编译期校验，禁动态拼 key）。
 *
 * `timeout` 的文案**刻意建议保持 slug 与项目名不变**（Hub digest 含 display_name，
 * 改名即 409；换 slug 会制造孤儿）——**绝不**建议换 slug。
 */
function provisioningReasonText(
  t: ReturnType<typeof useTranslations<'memory'>>,
  reason: string,
): string {
  switch (reason) {
    case MEMORY_UNAVAILABLE_REASON.PROVISIONING_UNAVAILABLE:
      return t('project.createError.provisionUnavailable');
    case MEMORY_UNAVAILABLE_REASON.PROVISIONING_TIMEOUT:
      return t('project.createError.provisionTimeout');
    case MEMORY_UNAVAILABLE_REASON.PROVISIONING_CONFLICT:
      return t('project.createError.provisionConflict');
    case MEMORY_UNAVAILABLE_REASON.PROVISIONING_FAILED:
      return t('project.createError.provisionFailed');
    default:
      // 非 provisioning 的 503（引擎不可用等）走通用兜底（本端点理论上不会，但分叉要闭合）
      return t('project.createError.generic');
  }
}

export { MemoryProjectCreateDialog };
