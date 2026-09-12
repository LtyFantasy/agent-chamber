/**
 * topic-composer.test.tsx — 圆桌输入框 @ 补全 + 高亮交互契约测试（jsdom，M2 web 批次）
 *
 * 覆盖：
 * ① 退化态（mentionTargets 缺省 = 普通 topic）：输入 @ 不弹补全框、不高亮
 *    （无 mark 元素）、textarea 文字不透明、Enter 直接发送
 * ② 补全框：输入 @ 弹出且 @all 置顶（右侧 i18n 说明）；继续输入前缀过滤；
 *    无匹配显示 i18n 空态行
 * ③ 键盘：Enter/Tab 选中插入 `@label `（含尾部空格）且不触发 onSend；
 *    ↑↓ 循环导航；Esc 关闭后 Enter 恢复发送；空 query 直接 Enter 选 @all
 * ④ 点击选中；补全框开时 Enter 禁止发送
 *
 * 受控流经 Harness 包装（onChange → setValue → rerender），模拟 page 真实数据流；
 * next-intl 按文案快照 mock（同 roundtable-mention-hint.test.tsx 先例）。
 */

import { useState } from 'react';
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TopicComposer } from './topic-composer';

/** topics.message 命名空间的英语文案快照（同 en.json；未命中 key 回退完整路径） */
const messages: Record<string, string> = {
  'message.mentionAllDesc': 'Notify all seats',
  'message.mentionNoMatch': 'No matching seat',
  'message.allWakeTitle': 'Wake all seats',
  'message.allWakeConfirm': 'This will wake all {count} seats. Send anyway?',
  'message.send': 'Send',
};

/** attachments 命名空间英语文案快照（同 en.json） */
const attachmentMessages: Record<string, string> = {
  'attachments.upload': 'Upload image',
  'attachments.uploading': 'Uploading...',
  'attachments.uploadFailed': 'Image upload failed, please retry',
  'attachments.tooLarge': 'Image exceeds the 8MiB size limit',
  'attachments.typeNotAllowed': 'Only PNG/JPEG/GIF/WebP images are supported',
  'attachments.quotaExceeded': 'Storage quota exceeded, please clean up attachments first',
  'attachments.removeChip': 'Remove attachment',
  'attachments.confirmRemove':
    'The attachment will be deleted and the image link in the message will be removed. Remove it?',
  'attachments.removeFailed':
    'Failed to delete the attachment; you can clean it up later in My Attachments',
};

// 全局 confirm（lib/notify）mock：window.confirm 替换批次后，@all 闸门改走
// 异步 Promise 确认——测试用 mockResolvedValue 控制结果 + await act 结算
jest.mock('@/lib/notify', () => ({
  confirm: jest.fn(),
  toast: { error: jest.fn(), warning: jest.fn(), success: jest.fn(), info: jest.fn() },
}));
import { confirm, toast } from '@/lib/notify';
const mockConfirm = confirm as jest.Mock;
const mockToastError = toast.error as jest.Mock;
const mockToastWarning = toast.warning as jest.Mock;

// Api.attachments mock（附件上传流；既有测试不触达，零影响）。
// requireActual 保留真实 ATTACHMENT_ALLOWED_TYPES/MAX_BYTES/escapeAttachmentAlt——
// 前端拦截与 alt 转义测的是真实实现，不是 mock 副本。
jest.mock('@/lib/api', () => {
  const actual = jest.requireActual('@/lib/api');
  return {
    ...actual,
    Api: {
      attachments: {
        upload: jest.fn(),
        remove: jest.fn(),
      },
    },
  };
});
import { Api } from '@/lib/api';
const mockUpload = Api.attachments.upload as jest.Mock;
const mockRemove = Api.attachments.remove as jest.Mock;

beforeEach(() => {
  mockConfirm.mockReset();
  mockToastError.mockReset();
  mockToastWarning.mockReset();
  mockUpload.mockReset();
  mockRemove.mockReset();
});

jest.mock('next-intl', () => ({
  // 文案快照 + {count} 插值（@all 闸门确认框断言 N 用；其余 key 无参数不受影响）
  useTranslations: () => (key: string, opts?: { count?: number }) => {
    const tpl = messages[key] ?? attachmentMessages[key] ?? key;
    return opts && typeof opts.count === 'number'
      ? tpl.replace('{count}', String(opts.count))
      : tpl;
  },
}));

/** 受控包装：onChange 同步 value，模拟 page 的真实受控流；
 *  onSend 后清空 value——模拟 page 发送成功（mutation onSuccess）清空输入框 */
function Harness({
  onSend,
  mentionTargets,
}: {
  onSend: (attachmentIds: string[]) => void;
  mentionTargets?: string[] | null;
}) {
  const [value, setValue] = useState('');
  return (
    <TopicComposer
      value={value}
      onChange={setValue}
      onSend={(ids) => {
        onSend(ids);
        setValue('');
      }}
      topicId="topic-1"
      placeholder="Type a message..."
      mentionTargets={mentionTargets}
    />
  );
}

/** 圆桌 active 座位 label（模拟 GET /roundtable/seats 过滤后） */
const SEATS = ['kimi-1', 'codex-1'];

function textareaOf(container: HTMLElement): HTMLTextAreaElement {
  return container.querySelector('textarea') as HTMLTextAreaElement;
}

describe('TopicComposer 退化态（普通 topic，mentionTargets 缺省）', () => {
  it('输入 @ 不弹补全框、不高亮（无 mark 元素）、文字不透明', async () => {
    const user = userEvent.setup();
    const onSend = jest.fn();
    const { container } = render(<Harness onSend={onSend} />);
    const ta = textareaOf(container);

    await user.type(ta, 'hello @kimi');

    expect(screen.queryByText('@all')).not.toBeInTheDocument();
    expect(container.querySelector('mark')).toBeNull();
    expect(ta.className).not.toContain('text-transparent');
  });

  it('Enter 直接发送（无补全框拦截）', async () => {
    const user = userEvent.setup();
    const onSend = jest.fn();
    const { container } = render(<Harness onSend={onSend} />);
    const ta = textareaOf(container);

    await user.type(ta, 'hello{Enter}');

    expect(onSend).toHaveBeenCalledTimes(1);
  });
});

describe('TopicComposer 圆桌 @ 补全', () => {
  it('输入 @ → 补全框出现且 @all 置顶（第一候选）+ 全部座位可见', async () => {
    const user = userEvent.setup();
    const { container } = render(<Harness onSend={jest.fn()} mentionTargets={SEATS} />);
    const ta = textareaOf(container);

    await user.type(ta, '@');

    // @all 置顶：DOM 顺序上先于第一个座位候选（paperclip/发送按钮无 @ 文本，过滤掉）
    const candidateButtons = Array.from(container.querySelectorAll('button')).filter((b) =>
      b.textContent?.includes('@'),
    );
    expect(candidateButtons[0]?.textContent).toContain('@all');
    expect(candidateButtons[0]?.textContent).toContain('Notify all seats');
    expect(screen.getByText('@kimi-1')).toBeInTheDocument();
    expect(screen.getByText('@codex-1')).toBeInTheDocument();
  });

  it('继续输入过滤：@ki → 只剩 kimi-1', async () => {
    const user = userEvent.setup();
    const { container } = render(<Harness onSend={jest.fn()} mentionTargets={SEATS} />);
    const ta = textareaOf(container);

    await user.type(ta, '@ki');

    expect(screen.getByText('@kimi-1')).toBeInTheDocument();
    expect(screen.queryByText('@codex-1')).not.toBeInTheDocument();
  });

  it('无匹配座位 → i18n 空态行（不可选）', async () => {
    const user = userEvent.setup();
    const { container } = render(<Harness onSend={jest.fn()} mentionTargets={SEATS} />);
    const ta = textareaOf(container);

    await user.type(ta, '@zzz');

    expect(screen.getByText('No matching seat')).toBeInTheDocument();
  });

  it('Enter 选中第一个匹配座位：插入 `@kimi-1 `（含尾部空格）且不触发 onSend', async () => {
    const user = userEvent.setup();
    const onSend = jest.fn();
    const { container } = render(<Harness onSend={onSend} mentionTargets={SEATS} />);
    const ta = textareaOf(container);

    await user.type(ta, '@ki');
    await user.keyboard('{Enter}');

    expect(ta.value).toBe('@kimi-1 ');
    expect(onSend).not.toHaveBeenCalled();
    // 补全框已关闭
    expect(screen.queryByText('Notify all seats')).not.toBeInTheDocument();
    // caret 移到插入文本之后（空格后）
    await waitFor(() => expect(ta.selectionStart).toBe(8));
  });

  it('空 query 直接 Enter → 选 @all（广播快捷路径）', async () => {
    const user = userEvent.setup();
    const { container } = render(<Harness onSend={jest.fn()} mentionTargets={SEATS} />);
    const ta = textareaOf(container);

    await user.type(ta, '@{Enter}');

    expect(ta.value).toBe('@all ');
  });

  it('Tab 选中候选（与 Enter 同语义）', async () => {
    const user = userEvent.setup();
    const { container } = render(<Harness onSend={jest.fn()} mentionTargets={SEATS} />);
    const ta = textareaOf(container);

    await user.type(ta, '@ki');
    await user.keyboard('{Tab}');

    expect(ta.value).toBe('@kimi-1 ');
  });

  it('↑↓ 循环导航：query 非空默认高亮首个座位，↑ 循环回 @all', async () => {
    const user = userEvent.setup();
    const { container } = render(<Harness onSend={jest.fn()} mentionTargets={SEATS} />);
    const ta = textareaOf(container);

    await user.type(ta, '@ki');
    await user.keyboard('{ArrowUp}{Enter}');

    expect(ta.value).toBe('@all ');
  });

  it('Esc 关闭补全框：随后 Enter 恢复发送', async () => {
    const user = userEvent.setup();
    const onSend = jest.fn();
    const { container } = render(<Harness onSend={onSend} mentionTargets={SEATS} />);
    const ta = textareaOf(container);

    await user.type(ta, '@ki');
    expect(screen.getByText('@kimi-1')).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(screen.queryByText('@kimi-1')).not.toBeInTheDocument();

    await user.keyboard('{Enter}');
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('点击选中 @all：插入 `@all `', async () => {
    const user = userEvent.setup();
    const { container } = render(<Harness onSend={jest.fn()} mentionTargets={SEATS} />);
    const ta = textareaOf(container);

    await user.type(ta, '@');
    await user.click(screen.getByText('@all'));

    expect(ta.value).toBe('@all ');
  });

  it('补全框开时 Enter 不发送（即使已有非空正文）', async () => {
    const user = userEvent.setup();
    const onSend = jest.fn();
    const { container } = render(<Harness onSend={onSend} mentionTargets={SEATS} />);
    const ta = textareaOf(container);

    await user.type(ta, 'hey @ki{Enter}');

    expect(onSend).not.toHaveBeenCalled();
    expect(ta.value).toBe('hey @kimi-1 ');
  });
});

describe('TopicComposer @all 闸门（M3 阶段 3，r13；全局 confirm 替换 window.confirm 批次）', () => {
  it('命中 @all + 有 active 座位 → 弹确认框（N = 座位数）；取消不发送', async () => {
    const user = userEvent.setup();
    mockConfirm.mockResolvedValue(false); // 取消
    const onSend = jest.fn();
    const { container } = render(<Harness onSend={onSend} mentionTargets={SEATS} />);
    const ta = textareaOf(container);

    await user.type(ta, '@all 开会{Enter}');
    await act(async () => {}); // 结算 confirm Promise（异步确认无同步阻塞）

    expect(mockConfirm).toHaveBeenCalledTimes(1);
    expect(mockConfirm).toHaveBeenCalledWith(
      expect.objectContaining({
        // N = SEATS.length = 2
        description: expect.stringContaining('wake all 2 seats'),
      }),
    );
    expect(onSend).not.toHaveBeenCalled(); // 取消不发送
  });

  it('确认后发送（Enter 路径）', async () => {
    const user = userEvent.setup();
    mockConfirm.mockResolvedValue(true);
    const onSend = jest.fn();
    const { container } = render(<Harness onSend={onSend} mentionTargets={SEATS} />);
    const ta = textareaOf(container);

    await user.type(ta, '@all 全体{Enter}');
    await act(async () => {});

    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('确认后发送（发送按钮路径）', async () => {
    const user = userEvent.setup();
    mockConfirm.mockResolvedValue(true);
    const onSend = jest.fn();
    render(<Harness onSend={onSend} mentionTargets={SEATS} />);

    await user.type(screen.getByPlaceholderText('Type a message...'), '@all 全体');
    // 发送按钮带 aria-label（图标无文字）；paperclip 按钮同排，必须按可访问名取
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await act(async () => {});

    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('发送守卫：确认弹窗打开期间重复触发被忽略（不排队第二个 confirm）', async () => {
    const user = userEvent.setup();
    // 第一个 confirm 挂起（pending）：模拟弹窗打开中
    mockConfirm.mockReturnValue(new Promise(() => {}));
    const onSend = jest.fn();
    render(<Harness onSend={onSend} mentionTargets={SEATS} />);

    await user.type(screen.getByPlaceholderText('Type a message...'), '@all 连点');
    const sendBtn = screen.getByRole('button', { name: 'Send' });
    await user.click(sendBtn);
    await user.click(sendBtn); // 弹窗打开期间连点第二次

    expect(mockConfirm).toHaveBeenCalledTimes(1); // 守卫生效：只排一个确认框
    expect(onSend).not.toHaveBeenCalled();
  });

  it('无 @all（定向 @座位）→ 零感知直发，不弹确认', async () => {
    const user = userEvent.setup();
    const onSend = jest.fn();
    const { container } = render(<Harness onSend={onSend} mentionTargets={SEATS} />);
    const ta = textareaOf(container);

    await user.type(ta, '@kimi-1 定向{Enter}');

    expect(mockConfirm).not.toHaveBeenCalled();
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('@all 在代码块内 → 不算提及（剥噪口径镜像），不弹确认直发', async () => {
    const user = userEvent.setup();
    const onSend = jest.fn();
    const { container } = render(<Harness onSend={onSend} mentionTargets={SEATS} />);
    const ta = textareaOf(container);

    // Shift+Enter 插入换行（不触发发送），最后的 Enter 才是发送
    await user.type(
      ta,
      '```[ShiftLeft>][Enter][/ShiftLeft]@all 代码内[ShiftLeft>][Enter][/ShiftLeft]```{Enter}',
    );

    expect(mockConfirm).not.toHaveBeenCalled();
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('零座位（mentionTargets=[]）→ 无可唤醒，不弹确认直发', async () => {
    const user = userEvent.setup();
    const onSend = jest.fn();
    const { container } = render(<Harness onSend={onSend} mentionTargets={[]} />);
    const ta = textareaOf(container);

    await user.type(ta, '@all 没人{Enter}');

    expect(mockConfirm).not.toHaveBeenCalled();
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('普通 topic（mentionTargets 缺省）→ 零感知直发，不弹确认', async () => {
    const user = userEvent.setup();
    const onSend = jest.fn();
    const { container } = render(<Harness onSend={onSend} />);
    const ta = textareaOf(container);

    await user.type(ta, '@all 普通桌{Enter}');

    expect(mockConfirm).not.toHaveBeenCalled();
    expect(onSend).toHaveBeenCalledTimes(1);
  });
});

describe('TopicComposer 附件上传流（MinIO 媒体附件 P0，plan §5.3）', () => {
  /** 构造最小上传响应（字段对齐 UploadAttachmentResponse 契约） */
  const uploadRes = (id: string, originalName: string) => ({
    id,
    contentUrl: `/api/v1/attachments/${id}/content`,
    originalName,
    mimeType: 'image/png',
    sizeBytes: 1024,
    sha256: 'a'.repeat(64),
    topicId: 'topic-1',
    docId: null,
    createdAt: '2026-09-09T00:00:00.000Z',
  });

  /** 构造图片 File（jsdom 支持 File/Blob） */
  const pngFile = (name = 'photo.png', size = 1024) =>
    new File([new Uint8Array(size)], name, { type: 'image/png' });

  /** 通过隐藏 file input 选择文件（paperclip 触发同一路径） */
  function pickFile(container: HTMLElement, file: File) {
    fireEvent.change(container.querySelector('input[type=file]') as HTMLInputElement, {
      target: { files: [file] },
    });
  }

  it('成功上传：插入 `![alt](contentUrl)` 到光标 + chip 回填 + onSend 透传 ids', async () => {
    const user = userEvent.setup();
    mockUpload.mockResolvedValue(uploadRes('att-1', 'photo.png'));
    const onSend = jest.fn();
    const { container } = render(<Harness onSend={onSend} />);
    const ta = textareaOf(container);

    await user.type(ta, '看这张图');
    pickFile(container, pngFile());

    await waitFor(() => {
      expect(mockUpload).toHaveBeenCalledWith(
        expect.any(File),
        expect.objectContaining({ topicId: 'topic-1' }),
      );
    });
    // 成功 → 光标处插入 markdown 图片链接（alt = 原始文件名）
    await waitFor(() => {
      expect(ta.value).toBe('看这张图![photo.png](/api/v1/attachments/att-1/content)');
    });
    // chip 展示文件名
    expect(screen.getByText('photo.png')).toBeInTheDocument();

    // 发送 → onSend 携带附件 id
    await user.type(ta, '{Enter}');
    expect(onSend).toHaveBeenCalledWith(['att-1']);
  });

  it('alt 转义：文件名含 `[ ] ( )` 不破 markdown 语法', async () => {
    const user = userEvent.setup();
    mockUpload.mockResolvedValue(uploadRes('att-2', 'a[b](c).png'));
    const onSend = jest.fn();
    const { container } = render(<Harness onSend={onSend} />);
    const ta = textareaOf(container);

    await user.type(ta, 'x');
    pickFile(container, pngFile('a[b](c).png'));

    await waitFor(() => {
      expect(ta.value).toBe('x![a\\[b\\]\\(c\\).png](/api/v1/attachments/att-2/content)');
    });
  });

  it('上传失败 → toast.error + chip 移除（不残留）', async () => {
    const user = userEvent.setup();
    mockUpload.mockRejectedValue(new Error('network'));
    const onSend = jest.fn();
    const { container } = render(<Harness onSend={onSend} />);
    const ta = textareaOf(container);

    await user.type(ta, 'x');
    pickFile(container, pngFile());

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Image upload failed, please retry' }),
      );
    });
    expect(screen.queryByText('photo.png')).not.toBeInTheDocument();
    expect(ta.value).toBe('x'); // 未插入链接
  });

  it('配额超限（12003）→ 单独配额文案', async () => {
    const user = userEvent.setup();
    const err = new Error('quota') as Error & { code?: number };
    err.code = 12003;
    mockUpload.mockRejectedValue(err);
    const { container } = render(<Harness onSend={jest.fn()} />);

    await user.type(textareaOf(container), 'x');
    pickFile(container, pngFile());

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Storage quota exceeded, please clean up attachments first',
        }),
      );
    });
  });

  it('超限前端拦截：>8MiB 不调 upload，直接 toast', async () => {
    const user = userEvent.setup();
    const { container } = render(<Harness onSend={jest.fn()} />);

    await user.type(textareaOf(container), 'x');
    pickFile(container, pngFile('big.png', 8 * 1024 * 1024 + 1));

    expect(mockUpload).not.toHaveBeenCalled();
    expect(mockToastError).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Image exceeds the 8MiB size limit' }),
    );
  });

  it('类型前端拦截：非白名单类型不调 upload，直接 toast', async () => {
    const user = userEvent.setup();
    const { container } = render(<Harness onSend={jest.fn()} />);

    await user.type(textareaOf(container), 'x');
    pickFile(container, new File(['svg'], 'evil.svg', { type: 'image/svg+xml' }));

    expect(mockUpload).not.toHaveBeenCalled();
    expect(mockToastError).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Only PNG/JPEG/GIF/WebP images are supported' }),
    );
  });

  it('chip 移除（已上传）：确认后调 DELETE + 同步剥离 textarea 链接', async () => {
    const user = userEvent.setup();
    mockUpload.mockResolvedValue(uploadRes('att-3', 'photo.png'));
    mockConfirm.mockResolvedValue(true);
    mockRemove.mockResolvedValue({ deleted: true });
    const onSend = jest.fn();
    const { container } = render(<Harness onSend={onSend} />);
    const ta = textareaOf(container);

    await user.type(ta, '看这张图');
    pickFile(container, pngFile());
    await waitFor(() => {
      expect(ta.value).toContain('![photo.png]');
    });

    // 移除 chip → 确认 → DELETE + 链接剥离
    await user.click(screen.getByRole('button', { name: 'Remove attachment' }));
    await act(async () => {});

    expect(mockConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ description: attachmentMessages['attachments.confirmRemove'] }),
    );
    expect(mockRemove).toHaveBeenCalledWith('att-3');
    expect(ta.value).toBe('看这张图'); // 死链已剥离
    expect(screen.queryByText('photo.png')).not.toBeInTheDocument();
  });

  it('chip 移除确认取消 → 不删不剥离', async () => {
    const user = userEvent.setup();
    mockUpload.mockResolvedValue(uploadRes('att-4', 'photo.png'));
    mockConfirm.mockResolvedValue(false);
    const { container } = render(<Harness onSend={jest.fn()} />);
    const ta = textareaOf(container);

    await user.type(ta, 'x');
    pickFile(container, pngFile());
    await waitFor(() => {
      expect(ta.value).toContain('![photo.png]');
    });

    await user.click(screen.getByRole('button', { name: 'Remove attachment' }));
    await act(async () => {});

    expect(mockRemove).not.toHaveBeenCalled();
    expect(ta.value).toContain('![photo.png]');
  });

  it('上传中移除 chip：不调 DELETE（无 id），成功回调不插入链接', async () => {
    const user = userEvent.setup();
    // upload 挂起（pending）：模拟上传中
    let resolveUpload: (v: unknown) => void = () => {};
    mockUpload.mockReturnValue(new Promise((r) => (resolveUpload = r)));
    const { container } = render(<Harness onSend={jest.fn()} />);
    const ta = textareaOf(container);

    await user.type(ta, 'x');
    pickFile(container, pngFile());
    await waitFor(() => {
      expect(screen.getByText('photo.png')).toBeInTheDocument();
    });

    // 上传中移除（无确认——无 id 可删）
    await user.click(screen.getByRole('button', { name: 'Remove attachment' }));
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(screen.queryByText('photo.png')).not.toBeInTheDocument();

    // 上传完成：不插入链接（已取消）
    await act(async () => {
      resolveUpload(uploadRes('att-5', 'photo.png'));
    });
    expect(ta.value).toBe('x');
  });

  it('onPaste 粘贴图片（全仓首例）：拦截默认粘贴 + 走上传', async () => {
    const user = userEvent.setup();
    mockUpload.mockResolvedValue(uploadRes('att-6', 'pasted.png'));
    const onSend = jest.fn();
    const { container } = render(<Harness onSend={onSend} />);
    const ta = textareaOf(container);

    await user.type(ta, 'x');
    // 模拟剪贴板图片粘贴（clipboardData.files）
    fireEvent.paste(ta, {
      clipboardData: { files: [pngFile('pasted.png')] },
    });

    await waitFor(() => {
      expect(mockUpload).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(ta.value).toBe('x![pasted.png](/api/v1/attachments/att-6/content)');
    });
  });

  it('onPaste 非图片（文本/文件）→ 不拦截，不调 upload', async () => {
    const user = userEvent.setup();
    const { container } = render(<Harness onSend={jest.fn()} />);
    const ta = textareaOf(container);

    await user.type(ta, 'x');
    fireEvent.paste(ta, {
      clipboardData: { files: [new File(['txt'], 'note.txt', { type: 'text/plain' })] },
    });

    expect(mockUpload).not.toHaveBeenCalled();
  });

  it('上传中发送被阻塞：发送按钮禁用 + Enter 不触发 onSend', async () => {
    const user = userEvent.setup();
    mockUpload.mockReturnValue(new Promise(() => {})); // 挂起
    const onSend = jest.fn();
    const { container } = render(<Harness onSend={onSend} />);
    const ta = textareaOf(container);

    await user.type(ta, 'x');
    pickFile(container, pngFile());
    await waitFor(() => {
      expect(screen.getByText('photo.png')).toBeInTheDocument();
    });

    // 发送按钮禁用（上传中）
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    await user.keyboard('{Enter}');
    expect(onSend).not.toHaveBeenCalled();
  });

  it('发送成功后 chips 重置（附件已随消息发送，不删除）', async () => {
    const user = userEvent.setup();
    mockUpload.mockResolvedValue(uploadRes('att-7', 'photo.png'));
    const onSend = jest.fn();
    const { container } = render(<Harness onSend={onSend} />);
    const ta = textareaOf(container);

    await user.type(ta, 'x');
    pickFile(container, pngFile());
    await waitFor(() => {
      expect(ta.value).toContain('![photo.png]');
    });

    // 发送成功 → page 清空 value（受控流）→ chips 重置
    await user.type(ta, '{Enter}');
    expect(onSend).toHaveBeenCalledWith(['att-7']);
    await waitFor(() => {
      expect(screen.queryByText('photo.png')).not.toBeInTheDocument();
    });
    expect(mockRemove).not.toHaveBeenCalled(); // 已发送附件不删除
  });
});
