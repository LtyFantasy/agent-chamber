/**
 * `formation-state.mapper` 单测（**§7 全表逐值**）。
 *
 * 设计意图：§7 状态机映射表是**活文档**——这里逐行钉住"哪个引擎信号 → 哪个 formation_state +
 * recovery_path + 是否采纳 ids"。三条最容易写错、也最贵的分支单列：
 * ① **outcome 优先于 job_state**（`no_change_validated` 常伴随 `job_state=committed`，
 * 用 job_state 先判会把"无需记忆"记成"已形成"）；
 * ② **committing 不采纳 ids** + **alias 恒空 ids**（写成 committed 会让召回映射指向不存在的
 * memory，错误只在消费侧暴露）；
 * ③ **默认行 fail-safe = unknown**（任何未映射信号绝不落 committed）。
 */
import { MEMORY_FORMATION_STATE } from '@agent-chamber/shared';
import {
  MEMORY_RECOVERY_PATHS,
  MEMORY_UNRESUMABLE_RECOVERY_PATHS,
  mapFormationState,
  type FormationMapping,
  type FormationSignal,
} from './formation-state.mapper';

/** 信号基线（duplicate/deferred 是两个必填布尔；其余按用例覆盖） */
function signal(overrides: Partial<FormationSignal> = {}): FormationSignal {
  return { duplicate: false, deferred: false, ...overrides };
}

/** 断言完整映射形状（含"未列出的列必须是空/ null"） */
function expectMapping(actual: FormationMapping, expected: Partial<FormationMapping>): void {
  expect(actual).toEqual({
    formationState: null,
    recoveryPath: null,
    memoryIds: [],
    mirrorCanonicalNominationId: null,
    ...expected,
  });
}

describe('mapFormationState（§7 状态机映射表逐值）', () => {
  describe('§7 第 1 行：committed（写 engine_memory_ids）', () => {
    it('outcome=memory_committed → committed + 采纳 ids', () => {
      expectMapping(
        mapFormationState(signal({ outcome: 'memory_committed', memoryIds: ['mem_1'] })),
        {
          formationState: MEMORY_FORMATION_STATE.COMMITTED,
          memoryIds: ['mem_1'],
        },
      );
    });

    it('**outcome 优先**：memory_committed 即使 job_state=committing 也采纳 ids', () => {
      expectMapping(
        mapFormationState(
          signal({
            outcome: 'memory_committed',
            jobState: 'committing',
            memoryIds: ['mem_1', 'mem_2'],
          }),
        ),
        { formationState: MEMORY_FORMATION_STATE.COMMITTED, memoryIds: ['mem_1', 'mem_2'] },
      );
    });

    it('job_state 回退：committed 且 memory_ids 非空 → committed', () => {
      expectMapping(mapFormationState(signal({ jobState: 'committed', memoryIds: ['mem_9'] })), {
        formationState: MEMORY_FORMATION_STATE.COMMITTED,
        memoryIds: ['mem_9'],
      });
    });

    it('**fail-safe**：job_state=committed 但 ids 为空 → unknown（绝不凭一个 job_state 落 committed）', () => {
      expectMapping(mapFormationState(signal({ jobState: 'committed', memoryIds: [] })), {
        formationState: MEMORY_FORMATION_STATE.UNKNOWN,
      });
    });

    it('ids 去重去空（合同 uniqueItems 的防御面）', () => {
      expectMapping(
        mapFormationState(signal({ outcome: 'memory_committed', memoryIds: ['a', 'a', '', 'b'] })),
        { formationState: MEMORY_FORMATION_STATE.COMMITTED, memoryIds: ['a', 'b'] },
      );
    });
  });

  describe('§7 第 2 行：no_memory（**即使 job_state=committed**）', () => {
    it.each(['no_memory', 'no_change_validated'])(
      'outcome=%s → no_memory + 不写 ids',
      (outcome) => {
        expectMapping(mapFormationState(signal({ outcome, memoryIds: ['mem_x'] })), {
          formationState: MEMORY_FORMATION_STATE.NO_MEMORY,
        });
      },
    );

    it('outcome=no_memory 且 job_state=committed 且带 ids → 仍 no_memory + ids 空', () => {
      expectMapping(
        mapFormationState(
          signal({ outcome: 'no_memory', jobState: 'committed', memoryIds: ['mem_1'] }),
        ),
        { formationState: MEMORY_FORMATION_STATE.NO_MEMORY },
      );
    });

    it('reason_code=no_change_validated（合同里它在 reason_code 轴）→ no_memory', () => {
      expectMapping(
        mapFormationState(signal({ reasonCode: 'no_change_validated', memoryIds: ['m'] })),
        {
          formationState: MEMORY_FORMATION_STATE.NO_MEMORY,
        },
      );
    });
  });

  describe('§7 第 3/4 行：rejected / unknown（Hument 终态，须人工处置）', () => {
    it('outcome=rejected → rejected + hub_manual_required', () => {
      expectMapping(mapFormationState(signal({ outcome: 'rejected' })), {
        formationState: MEMORY_FORMATION_STATE.REJECTED,
        recoveryPath: 'hub_manual_required',
      });
    });

    it.each(['unknown', 'provider_outcome_unknown'])(
      'outcome=%s → unknown + hub_manual_required（Chamber 不可恢复）',
      (outcome) => {
        expectMapping(mapFormationState(signal({ outcome })), {
          formationState: MEMORY_FORMATION_STATE.UNKNOWN,
          recoveryPath: 'hub_manual_required',
        });
      },
    );

    it('job_state=provider_outcome_unknown（合同的 job_state 值）→ unknown + hub_manual_required', () => {
      expectMapping(mapFormationState(signal({ jobState: 'provider_outcome_unknown' })), {
        formationState: MEMORY_FORMATION_STATE.UNKNOWN,
        recoveryPath: 'hub_manual_required',
      });
    });

    it('reason_code=provider_outcome_unknown → unknown + hub_manual_required', () => {
      expectMapping(mapFormationState(signal({ reasonCode: 'provider_outcome_unknown' })), {
        formationState: MEMORY_FORMATION_STATE.UNKNOWN,
        recoveryPath: 'hub_manual_required',
      });
    });
  });

  describe('§7 第 5 行：deferred（明示延后 ⇒ 非终态）', () => {
    it('outcome=deferred → submitted + same_key_resend', () => {
      expectMapping(mapFormationState(signal({ outcome: 'deferred' })), {
        formationState: MEMORY_FORMATION_STATE.SUBMITTED,
        recoveryPath: 'same_key_resend',
      });
    });

    it('deferred=true（无 outcome）→ submitted + same_key_resend', () => {
      expectMapping(mapFormationState(signal({ deferred: true })), {
        formationState: MEMORY_FORMATION_STATE.SUBMITTED,
        recoveryPath: 'same_key_resend',
      });
    });
  });

  describe('§7 第 6-8 行：job_state 回退（非终态一律同 key 重发）', () => {
    it.each(['pending', 'claimed', 'provider_inflight', 'proposed'])(
      'job_state=%s → submitted + same_key_resend',
      (jobState) => {
        expectMapping(mapFormationState(signal({ jobState })), {
          formationState: MEMORY_FORMATION_STATE.SUBMITTED,
          recoveryPath: 'same_key_resend',
        });
      },
    );

    it('job_state=committing → submitted + same_key_resend，且**ids 不采纳**', () => {
      expectMapping(
        mapFormationState(signal({ jobState: 'committing', memoryIds: ['mem_1', 'mem_2'] })),
        { formationState: MEMORY_FORMATION_STATE.SUBMITTED, recoveryPath: 'same_key_resend' },
      );
    });

    it('job_state=no_material（finish 前中断残留）→ submitted + same_key_resend', () => {
      expectMapping(mapFormationState(signal({ jobState: 'no_material' })), {
        formationState: MEMORY_FORMATION_STATE.SUBMITTED,
        recoveryPath: 'same_key_resend',
      });
    });

    it.each(['provider_rejected', 'validation_rejected'])(
      '退化路径（无 diagnostics）：job_state=%s → rejected + hub_manual_required（**不落默认行 unknown**）',
      (jobState) => {
        // 终态拒绝的退化形态与 §7 第 3 行同映射：rejected 可走 Owner recovery
        //（POST recover 只收 rejected），unknown 在 Chamber 侧不可恢复——映错 = 项目提名面冻结
        expectMapping(mapFormationState(signal({ jobState })), {
          formationState: MEMORY_FORMATION_STATE.REJECTED,
          recoveryPath: 'hub_manual_required',
        });
      },
    );
  });

  describe('§7 第 9-10 行：请求未到达 / 无回执', () => {
    it('durable=false / 连接拒绝 / HTTP 500 → failed + same_key_resend', () => {
      expectMapping(mapFormationState(signal({ durable: false })), {
        formationState: MEMORY_FORMATION_STATE.FAILED,
        recoveryPath: 'same_key_resend',
      });
      expectMapping(mapFormationState(signal({ failureKind: 'unreachable' })), {
        formationState: MEMORY_FORMATION_STATE.FAILED,
        recoveryPath: 'same_key_resend',
      });
      expectMapping(mapFormationState(signal({ failureKind: 'http', httpStatus: 500 })), {
        formationState: MEMORY_FORMATION_STATE.FAILED,
        recoveryPath: 'same_key_resend',
      });
    });

    it('客户端超时（无回执）→ unknown + same_key_resend（重发 replay 推进）', () => {
      expectMapping(mapFormationState(signal({ failureKind: 'timeout' })), {
        formationState: MEMORY_FORMATION_STATE.UNKNOWN,
        recoveryPath: 'same_key_resend',
      });
    });
  });

  describe('§7 第 11 行：引擎 409（多因）→ conflict（人工处置，归一化不拆因）', () => {
    it('HTTP 409 → conflict + 无自动恢复路径', () => {
      expectMapping(mapFormationState(signal({ failureKind: 'http', httpStatus: 409 })), {
        formationState: MEMORY_FORMATION_STATE.CONFLICT,
      });
    });

    it('HTTP 409 + error.code=idempotency_conflict → 仍走 409 行（同形 ⇒ 同映射）', () => {
      expectMapping(
        mapFormationState(
          signal({ failureKind: 'http', httpStatus: 409, engineCode: 'idempotency_conflict' }),
        ),
        { formationState: MEMORY_FORMATION_STATE.CONFLICT },
      );
    });
  });

  describe('§7 第 12 行：duplicate（alias）→ 镜像 canonical 行', () => {
    it('duplicate=true → formationState=null（由调用方镜像）+ mirror 标记 + ids 恒空', () => {
      expectMapping(
        mapFormationState(
          signal({ duplicate: true, canonicalNominationId: 'nom_canon', memoryIds: ['mem_1'] }),
        ),
        { mirrorCanonicalNominationId: 'nom_canon' },
      );
    });

    it('**alias 优先**：duplicate=true + outcome=memory_committed 也不采纳 ids（alias 不推进 job）', () => {
      expectMapping(
        mapFormationState(
          signal({
            duplicate: true,
            outcome: 'memory_committed',
            canonicalNominationId: 'nom_canon',
            memoryIds: ['mem_1'],
          }),
        ),
        { mirrorCanonicalNominationId: 'nom_canon' },
      );
    });

    it('duplicate=true 但缺 canonical 线索 → mirror=null（服务层据此落 conflict）', () => {
      expectMapping(mapFormationState(signal({ duplicate: true })), {
        mirrorCanonicalNominationId: null,
      });
    });
  });

  describe('§7 第 13-15 行：error.code 三族', () => {
    it.each(['binding_not_found', 'scope_denied'])(
      'error.code=%s → failed + config_invalid（重试无效）',
      (engineCode) => {
        expectMapping(
          mapFormationState(signal({ failureKind: 'http', httpStatus: 403, engineCode })),
          { formationState: MEMORY_FORMATION_STATE.FAILED, recoveryPath: 'config_invalid' },
        );
      },
    );

    it.each(['invalid_argument', 'budget_too_small'])(
      'error.code=%s → failed + param_invalid（须换新 client_request_id）',
      (engineCode) => {
        expectMapping(
          mapFormationState(signal({ failureKind: 'http', httpStatus: 400, engineCode })),
          {
            formationState: MEMORY_FORMATION_STATE.FAILED,
            recoveryPath: 'param_invalid',
          },
        );
      },
    );

    it.each(['provider_unavailable', 'overloaded', 'cell_unavailable'])(
      'error.code=%s → failed + same_key_resend（稍后同 key 重试）',
      (engineCode) => {
        expectMapping(
          mapFormationState(signal({ failureKind: 'http', httpStatus: 503, engineCode })),
          {
            formationState: MEMORY_FORMATION_STATE.FAILED,
            recoveryPath: 'same_key_resend',
          },
        );
      },
    );
  });

  describe('§7 第 16 行：默认行（任何未映射信号 ⇒ unknown，绝不落 committed）', () => {
    it.each([
      ['空信号', signal()],
      ['未映射 job_state', signal({ jobState: 'something_new' })],
      [
        '未枚举 error.code',
        signal({ failureKind: 'http', httpStatus: 401, engineCode: 'internal' }),
      ],
      ['2xx 体破损', signal({ failureKind: 'invalid_response' })],
      ['未映射 outcome', signal({ outcome: 'brand_new_outcome' })],
      ['未映射 reason_code', signal({ reasonCode: 'stored_diagnostic_invalid' })],
      ['HTTP 502（无 error.code）', signal({ failureKind: 'http', httpStatus: 502 })],
    ])('%s → unknown + recoveryPath null', (_label, input) => {
      expectMapping(mapFormationState(input), {
        formationState: MEMORY_FORMATION_STATE.UNKNOWN,
      });
    });
  });

  describe('输出值域不变量（全表扫描）', () => {
    /** 代表性信号电池：覆盖 §7 每一行 + 默认行 */
    const BATTERY: FormationSignal[] = [
      signal(),
      signal({ duplicate: true, canonicalNominationId: 'c' }),
      signal({ duplicate: true }),
      signal({ outcome: 'memory_committed', memoryIds: ['m'] }),
      signal({ outcome: 'no_memory', memoryIds: ['m'] }),
      signal({ jobState: 'committed' }),
      signal({ jobState: 'committed', memoryIds: ['m'] }),
      signal({ jobState: 'committing', memoryIds: ['m'] }),
      signal({ jobState: 'pending' }),
      signal({ jobState: 'no_material' }),
      signal({ jobState: 'provider_outcome_unknown' }),
      signal({ jobState: 'provider_rejected' }),
      signal({ jobState: 'validation_rejected' }),
      signal({ outcome: 'rejected' }),
      signal({ outcome: 'unknown' }),
      signal({ outcome: 'deferred' }),
      signal({ deferred: true }),
      signal({ durable: false }),
      signal({ failureKind: 'timeout' }),
      signal({ failureKind: 'unreachable' }),
      signal({ failureKind: 'invalid_response' }),
      signal({ failureKind: 'http', httpStatus: 409 }),
      signal({ failureKind: 'http', httpStatus: 500 }),
      signal({ failureKind: 'http', httpStatus: 503, engineCode: 'overloaded' }),
      signal({ failureKind: 'http', httpStatus: 403, engineCode: 'scope_denied' }),
      signal({ failureKind: 'http', httpStatus: 400, engineCode: 'invalid_argument' }),
    ];

    it('recoveryPath ∈ 值域 ∪ {null}，且**永不产出 inspect_backfill**（§7 无产出行）', () => {
      for (const input of BATTERY) {
        const mapping = mapFormationState(input);
        if (mapping.recoveryPath !== null) {
          expect(MEMORY_RECOVERY_PATHS).toContain(mapping.recoveryPath);
        }
        expect(mapping.recoveryPath).not.toBe('inspect_backfill');
      }
    });

    it('ids 只可能在 committed 上非空（其余状态一律空数组）', () => {
      for (const input of BATTERY) {
        const mapping = mapFormationState(input);
        if (mapping.formationState !== MEMORY_FORMATION_STATE.COMMITTED) {
          expect(mapping.memoryIds).toEqual([]);
        }
      }
    });

    it('formationState=null ⟺ alias（mirror 分支）；非 alias 恒有归一化态', () => {
      for (const input of BATTERY) {
        const mapping = mapFormationState(input);
        if (input.duplicate === true) {
          expect(mapping.formationState).toBeNull();
        } else {
          expect(mapping.formationState).not.toBeNull();
        }
      }
    });

    it('扫描排除集 = hub_manual_required / config_invalid / param_invalid（§7 末段定死）', () => {
      expect([...MEMORY_UNRESUMABLE_RECOVERY_PATHS]).toEqual([
        'hub_manual_required',
        'config_invalid',
        'param_invalid',
      ]);
      // 排除集必须是值域子集（新增 recovery_path 而忘了归类会当场红）
      for (const path of MEMORY_UNRESUMABLE_RECOVERY_PATHS) {
        expect(MEMORY_RECOVERY_PATHS).toContain(path);
      }
    });
  });
});
