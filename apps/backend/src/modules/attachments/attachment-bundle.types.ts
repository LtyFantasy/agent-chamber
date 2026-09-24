/**
 * bundle media 导入的门面契约（P2 批 5 / plan §⑤.4 第 ② 步）。
 *
 * 独立成文件的原因：DocSpaceModule（编排）与 AttachmentModule（字节/存储/配额实现）
 * 之间存在双向 forwardRef（plan §0 arch M1）。把跨模块形状放在**不依赖任何一方**的
 * 类型文件里，编排侧用 `import type` 引用——类型导入在编译期擦除，不会给运行时模块图
 * 再加一条边。
 *
 * 职责边界：docspace 只做"读 DTO → 交给门面 → 用返回的映射重写正文"，不碰 storage、
 * 不碰嗅探、不碰配额锁（那些都在 attachments 模块内聚）。
 */

/** bundle.media[] 缩略图输入（DTO 形状） */
export interface BundleMediaThumbnailInput {
  width: number;
  height: number;
  sizeBytes: number;
  sha256: string;
  contentBase64: string;
}

/**
 * bundle.media[] 单项输入（DTO 形状，字段可缺省——union 语义在实现层分支）。
 * `skipped` 非空 = 导出侧未打包标记：实现层直接计入 skipped，不做任何写。
 */
export interface BundleMediaImportItem {
  sourceAttachmentId: string | null;
  docPath: string;
  originalName: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  sha256: string | null;
  contentBase64: string | null;
  thumbnail: BundleMediaImportItemThumbnail | null;
  skipped: string | null;
}

/** 同上，避免与 DTO 类同名造成阅读歧义 */
export type BundleMediaImportItemThumbnail = BundleMediaThumbnailInput;

/** 导入阶段 ②（媒体落库）入参 */
export interface BundleMediaImportInput {
  items: BundleMediaImportItem[];
  /** importer 的 actor.id——新行的 uploader_id + 配额口径 + advisory 锁键 */
  importerId: string;
  /** 本 bundle docs[] 的 path 集合：media 项 docPath 不在此集合 → per-item failed */
  docPathSet: ReadonlySet<string>;
  /** docPath → **目标空间当前**解析出的 docId（复用键用；首导目标空间还没有该 doc → 缺省） */
  docIdByPath: ReadonlyMap<string, string>;
  /** 预算（父调用按 plan §⑤.3 口径算好传入，attachments 侧不自持 docspace 常量） */
  limits: {
    /** 单项原始字节上限（超出 → failed；DTO 层已有一道，这里是手改包的防御性复检） */
    itemMaxBytes: number;
    /** 本包解码后总量上限（原图 + 缩略图累计；超出 → failed） */
    budgetBytes: number;
  };
}

/** 落库成功的配对（正文重写 + 阶段 ④ 回绑用） */
export interface BundleMediaBinding {
  sourceAttachmentId: string;
  attachmentId: string;
  docPath: string;
  originalName: string | null;
}

/** 导入阶段 ②（媒体落库）结果——直接喂给结果信封的 media 段 */
export interface BundleMediaImportResult {
  created: number;
  reused: number;
  skipped: number;
  failed: Array<{ docPath: string; originalName: string | null; reason: string }>;
  bindings: BundleMediaBinding[];
}

/** 阶段 ④（回绑 docId）单项入参 */
export interface BundleMediaBindEntry {
  attachmentId: string;
  docId: string;
  sourceAttachmentId: string;
  docPath: string;
  originalName: string | null;
}

/** 阶段 ④ 结果 */
export interface BundleMediaBindResult {
  bound: number;
  failures: Array<{ docPath: string; originalName: string | null; reason: string }>;
}
