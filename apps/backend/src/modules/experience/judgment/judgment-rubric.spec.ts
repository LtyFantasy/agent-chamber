/**
 * judgment-rubric 单测（第二期批 3 / plan §3.3 + §0 逐字段白名单）。
 *
 * 设计意图：这是**注入面的收口点**——jev 返回的每个字段都必须过白名单，非法维度置 null，
 * 整体形状破损整次判为失败（不落快照）。这些分支静默失效时的症状是"快照里出现模型编造的
 * 档位/领域名"，且会被 reviewer 当 ground truth 对照，故逐条钉死。
 */
import { EXPERIENCE_INTENTS } from '@agent-chamber/shared';
import {
  ADMISSION_CHOICES,
  EXPERIENCE_JUDGMENT_RUBRIC_VERSION,
  JUDGMENT_CONTENT_EXCERPT_LIMIT,
  buildContentExcerpt,
  buildJudgmentState,
  buildRubricQuestions,
  extractJudgmentModel,
  normalizeJevAnswers,
} from './judgment-rubric';
import type { ExperienceCheckInput } from './judgment-provider.interface';

/** 合法 answers 骨架（实测形状；各用例按需破坏某一维） */
function validAnswers(): Record<string, unknown> {
  return {
    completeness: {
      type: 'score',
      score: 1.85,
      confidence: 0.7,
      legend: { 0: 'missing', 1: 'thin', 2: 'partial', 3: 'complete' },
      probabilities: { 0: 0, 1: 0.23, 2: 0.7, 3: 0.07 },
    },
    reusability: {
      type: 'score',
      score: 1.76,
      confidence: 0.64,
      legend: { 0: 'one_off', 1: 'narrow', 2: 'broad' },
      probabilities: { 0: 0, 1: 0.24, 2: 0.76 },
    },
    signalQuality: {
      type: 'score',
      score: 1.43,
      confidence: 0.32,
      legend: { 0: 'noise', 1: 'weak', 2: 'distinctive' },
      probabilities: { 0: 0.01, 1: 0.55, 2: 0.44 },
    },
    duplicate: {
      type: 'choice',
      choice: 'distinct',
      confidence: 0.92,
      probabilities: { distinct: 0.95, possible_duplicate: 0.02, likely_duplicate: 0.03 },
    },
    intentSuggestion: {
      type: 'choice',
      choice: 'keep',
      confidence: 0.51,
      probabilities: { keep: 0.52, repair: 0.48 },
    },
    domainSuggestion: {
      type: 'choice',
      choice: 'docker',
      confidence: 0.97,
      probabilities: { docker: 0.98, keep: 0 },
    },
    admissionSuggestion: {
      type: 'choice',
      choice: 'admit',
      confidence: 0.83,
      probabilities: {},
    },
  };
}

const DOMAINS = ['docker', 'postgres'];

describe('judgment-rubric', () => {
  describe('正文节选', () => {
    it('短正文：原样 + 标记未截断 + 记录原始长度', () => {
      const excerpt = buildContentExcerpt('short body');
      expect(excerpt).toEqual({
        content: 'short body',
        contentTruncated: false,
        contentLength: 'short body'.length,
      });
    });

    it('超长正文：截到 2000 字符 + contentTruncated=true + contentLength 记原文长度', () => {
      const body = 'x'.repeat(JUDGMENT_CONTENT_EXCERPT_LIMIT + 500);
      const excerpt = buildContentExcerpt(body);
      expect(excerpt.content).toHaveLength(JUDGMENT_CONTENT_EXCERPT_LIMIT);
      expect(excerpt.contentTruncated).toBe(true);
      expect(excerpt.contentLength).toBe(JUDGMENT_CONTENT_EXCERPT_LIMIT + 500);
    });
  });

  describe('问题集与 state', () => {
    it('七个维度齐备且 instructions 是固定常量（条目内容不进问题侧）', () => {
      const questions = buildRubricQuestions(DOMAINS);
      expect(Object.keys(questions).sort()).toEqual([
        'admissionSuggestion',
        'completeness',
        'domainSuggestion',
        'duplicate',
        'intentSuggestion',
        'reusability',
        'signalQuality',
      ]);
      expect(questions.completeness.type).toBe('score');
      expect(questions.completeness.criteria).toEqual(['missing', 'thin', 'partial', 'complete']);
      expect(questions.duplicate.type).toBe('choice');
      expect(questions.intentSuggestion.criteria).toMatchObject({ keep: expect.any(String) });
    });

    it('第 7 维 admissionSuggestion：choice 三值 + criteria 键 = 词表；**排在末尾**（不改既有 prompt 顺序）', () => {
      const questions = buildRubricQuestions(DOMAINS);
      expect(questions.admissionSuggestion.type).toBe('choice');
      expect(ADMISSION_CHOICES).toEqual(['admit', 'needs_human', 'reject']);
      // criteria 的键必须与词表逐一对应（防"问的选项"与"认的选项"漂移）
      expect(Object.keys(questions.admissionSuggestion.criteria as object).sort()).toEqual(
        [...ADMISSION_CHOICES].sort(),
      );
      // instructions 是固定英文常量：判据 = "换个项目还成立吗"
      expect(String(questions.admissionSuggestion.instructions)).toContain('CROSS-PROJECT');
      // 新维挂在末尾 ⇒ 既有六维在 prompt 里的相对顺序逐字不变（校准数据纵向可比）
      expect(Object.keys(questions)[6]).toBe('admissionSuggestion');
    });

    it('既有六维的 instructions / 词表逐字未变（本批只增维，不改维）', () => {
      const questions = buildRubricQuestions(DOMAINS);
      expect(questions.completeness.criteria).toEqual(['missing', 'thin', 'partial', 'complete']);
      expect(questions.reusability.criteria).toEqual(['one_off', 'narrow', 'broad']);
      expect(questions.signalQuality.criteria).toEqual(['noise', 'weak', 'distinctive']);
      expect(String(questions.completeness.instructions)).toContain(
        'How complete is this troubleshooting note for a DIFFERENT engineer',
      );
      expect(String(questions.reusability.instructions)).toContain('Score one_off for a one-time');
      expect(String(questions.signalQuality.instructions)).toContain('Score noise for generic');
      expect(String(questions.duplicate.instructions)).toContain(
        'Does this entry look like a duplicate of the candidate entries listed in',
      );
      expect(String(questions.intentSuggestion.instructions)).toContain(
        'Which intent label fits this entry best?',
      );
      expect(String(questions.domainSuggestion.instructions)).toContain(
        'none_fits when no existing tag applies',
      );
    });

    it('domainSuggestion 候选 = keep/none_fits + 当次词表快照；词表为空时只剩两档', () => {
      const withDomains = buildRubricQuestions(DOMAINS);
      expect(Object.keys(withDomains.domainSuggestion.criteria as object).sort()).toEqual([
        'docker',
        'keep',
        'none_fits',
        'postgres',
      ]);

      const empty = buildRubricQuestions([]);
      expect(Object.keys(empty.domainSuggestion.criteria as object).sort()).toEqual([
        'keep',
        'none_fits',
      ]);
    });

    it('state 只带数据位：节选/标记/信号/词表/重复候选（top-3）', () => {
      const input: ExperienceCheckInput = {
        title: 't',
        summary: 's',
        content: 'c'.repeat(3000),
        signals: ['econnrefused'],
        domains: ['docker'],
        env: { os: 'ubuntu22' },
        intent: 'repair',
        duplicateCandidates: [
          { id: '1', title: 'a', quality: 'verified' },
          { id: '2', title: 'b', quality: 'unverified' },
          { id: '3', title: 'c', quality: 'unverified' },
          { id: '4', title: 'd', quality: 'unverified' },
        ],
        availableDomains: DOMAINS,
      };
      const state = buildJudgmentState(input);
      expect(state.contentTruncated).toBe(true);
      expect(state.contentLength).toBe(3000);
      expect((state.possibleDuplicates as unknown[]).length).toBe(3);
      expect(state.availableDomains).toEqual(DOMAINS);
      expect(state.intent).toBe('repair');
    });
  });

  describe('归一化（逐字段白名单）', () => {
    it('合法 answers → 七维齐全，档位取自 legend[argmax(probabilities)]', () => {
      const dims = normalizeJevAnswers(validAnswers(), DOMAINS);
      expect(dims).not.toBeNull();
      expect(dims?.completeness).toEqual({ level: 'partial', confidence: 0.7 });
      expect(dims?.reusability).toEqual({ level: 'broad', confidence: 0.64 });
      // 概率 0.55/0.44 接近均分：argmax 取 weak（若按 round(score=1.43)=1 也是 weak，但语义来源不同）
      expect(dims?.signalQuality).toEqual({ level: 'weak', confidence: 0.32 });
      expect(dims?.duplicate).toEqual({ verdict: 'distinct', confidence: 0.92 });
    });

    it('intentSuggestion：keep → value=null；受控五值 → verdict=suggested + value', () => {
      const keep = normalizeJevAnswers(validAnswers(), DOMAINS);
      expect(keep?.intentSuggestion).toEqual({ verdict: 'keep', value: null, confidence: 0.51 });

      const answers = validAnswers();
      (answers.intentSuggestion as Record<string, unknown>).choice = 'pitfall';
      const suggested = normalizeJevAnswers(answers, DOMAINS);
      expect(suggested?.intentSuggestion).toEqual({
        verdict: 'suggested',
        value: 'pitfall',
        confidence: 0.51,
      });
      expect(EXPERIENCE_INTENTS).toContain('pitfall');
    });

    it('intentSuggestion 非法值（不在受控五值且非 keep）→ 该维度 null', () => {
      const answers = validAnswers();
      (answers.intentSuggestion as Record<string, unknown>).choice = 'bugfix';
      const dims = normalizeJevAnswers(answers, DOMAINS);
      expect(dims?.intentSuggestion).toBeNull();
      // 其余维度不受影响（只置非法那一维）
      expect(dims?.completeness).not.toBeNull();
    });

    it('domainSuggestion：none_fits → value=null；词表内值 → suggested；**词表外值 → null**', () => {
      const noneFits = validAnswers();
      (noneFits.domainSuggestion as Record<string, unknown>).choice = 'none_fits';
      expect(normalizeJevAnswers(noneFits, DOMAINS)?.domainSuggestion).toEqual({
        verdict: 'none_fits',
        value: null,
        confidence: 0.97,
      });

      expect(normalizeJevAnswers(validAnswers(), DOMAINS)?.domainSuggestion).toEqual({
        verdict: 'suggested',
        value: 'docker',
        confidence: 0.97,
      });

      const outOfVocab = validAnswers();
      (outOfVocab.domainSuggestion as Record<string, unknown>).choice = 'kubernetes';
      expect(normalizeJevAnswers(outOfVocab, DOMAINS)?.domainSuggestion).toBeNull();
    });

    it('admissionSuggestion：三值合法 → verdict 原样保留（confidence 一并归一化）', () => {
      for (const verdict of ADMISSION_CHOICES) {
        const answers = validAnswers();
        (answers.admissionSuggestion as Record<string, unknown>).choice = verdict;
        expect(normalizeJevAnswers(answers, DOMAINS)?.admissionSuggestion).toEqual({
          verdict,
          confidence: 0.83,
        });
      }
    });

    it('admissionSuggestion 词表外 choice（模型自造结论）→ 该维度 null，其余维度不受影响', () => {
      const answers = validAnswers();
      (answers.admissionSuggestion as Record<string, unknown>).choice = 'maybe_ok';
      const dims = normalizeJevAnswers(answers, DOMAINS);
      expect(dims?.admissionSuggestion).toBeNull();
      expect(dims?.completeness).not.toBeNull();
    });

    it('admissionSuggestion 缺 confidence / 非有限数 → 该维度 null（不猜）', () => {
      const missing = validAnswers();
      delete (missing.admissionSuggestion as Record<string, unknown>).confidence;
      expect(normalizeJevAnswers(missing, DOMAINS)?.admissionSuggestion).toBeNull();

      const nan = validAnswers();
      (nan.admissionSuggestion as Record<string, unknown>).confidence = Number.NaN;
      expect(normalizeJevAnswers(nan, DOMAINS)?.admissionSuggestion).toBeNull();
    });

    it('admissionSuggestion 越界 confidence → clamp 到 [0,1]（不因上游漂移丢整维）', () => {
      const answers = validAnswers();
      (answers.admissionSuggestion as Record<string, unknown>).confidence = 1.9;
      expect(normalizeJevAnswers(answers, DOMAINS)?.admissionSuggestion?.confidence).toBe(1);
    });

    it('**v1 旧快照兼容**：answers 无 admissionSuggestion 字段 → 新维按 null 处理，既有维度照常（不炸）', () => {
      const v1 = validAnswers();
      delete v1.admissionSuggestion;
      const dims = normalizeJevAnswers(v1, DOMAINS);
      expect(dims).not.toBeNull();
      expect(dims?.admissionSuggestion).toBeNull();
      // 六维快照的读取路径不受新维影响（旧数据仍全量可用）
      expect(dims?.completeness).toEqual({ level: 'partial', confidence: 0.7 });
      expect(dims?.domainSuggestion).toEqual({
        verdict: 'suggested',
        value: 'docker',
        confidence: 0.97,
      });
    });

    it('全空判定覆盖新维：仅 admissionSuggestion 非法 + 其余合法 → 不判整体形状破损', () => {
      const answers = validAnswers();
      (answers.admissionSuggestion as Record<string, unknown>).choice = 'nope';
      const dims = normalizeJevAnswers(answers, DOMAINS);
      expect(dims).not.toBeNull();
      expect(dims?.admissionSuggestion).toBeNull();
      // 新维合法也能单独撑起整次判定（证明它进了 Object.values 的全空判定）
      const onlyAdmission = { admissionSuggestion: validAnswers().admissionSuggestion };
      expect(normalizeJevAnswers(onlyAdmission, DOMAINS)?.admissionSuggestion).toEqual({
        verdict: 'admit',
        confidence: 0.83,
      });
    });

    it('confidence 非法（非有限数/缺失）→ 该维度 null', () => {
      const answers = validAnswers();
      (answers.completeness as Record<string, unknown>).confidence = 'high';
      expect(normalizeJevAnswers(answers, DOMAINS)?.completeness).toBeNull();

      const nan = validAnswers();
      (nan.reusability as Record<string, unknown>).confidence = Number.NaN;
      expect(normalizeJevAnswers(nan, DOMAINS)?.reusability).toBeNull();
    });

    it('confidence 越界 → clamp 到 [0,1]（不因上游漂移丢整维）', () => {
      const answers = validAnswers();
      (answers.completeness as Record<string, unknown>).confidence = 1.4;
      (answers.reusability as Record<string, unknown>).confidence = -0.2;
      const dims = normalizeJevAnswers(answers, DOMAINS);
      expect(dims?.completeness?.confidence).toBe(1);
      expect(dims?.reusability?.confidence).toBe(0);
    });

    it('score 档位不在词表 → 该维度 null（不猜）', () => {
      const answers = validAnswers();
      (answers.signalQuality as Record<string, unknown>).legend = {
        0: 'noise',
        1: 'weak',
        2: 'excellent', // 不在白名单
      };
      (answers.signalQuality as Record<string, unknown>).probabilities = { 2: 0.9, 1: 0.1 };
      expect(normalizeJevAnswers(answers, DOMAINS)?.signalQuality).toBeNull();
    });

    it('score 缺 legend/probabilities → 该维度 null（不回落 round(score)）', () => {
      const noLegend = validAnswers();
      delete (noLegend.completeness as Record<string, unknown>).legend;
      expect(normalizeJevAnswers(noLegend, DOMAINS)?.completeness).toBeNull();

      const noProbs = validAnswers();
      delete (noProbs.completeness as Record<string, unknown>).probabilities;
      expect(normalizeJevAnswers(noProbs, DOMAINS)?.completeness).toBeNull();
    });

    it('duplicate 非法 verdict → null', () => {
      const answers = validAnswers();
      (answers.duplicate as Record<string, unknown>).choice = 'probably_same';
      expect(normalizeJevAnswers(answers, DOMAINS)?.duplicate).toBeNull();
    });

    it('七维全非法 → 整体返回 null（整体形状破损 ⇒ 调用点判 error 且不落快照）', () => {
      expect(normalizeJevAnswers({}, DOMAINS)).toBeNull();
      expect(normalizeJevAnswers({ completeness: 'nope' }, DOMAINS)).toBeNull();
    });

    it('answers 非对象（数组/字符串/null）→ null', () => {
      expect(normalizeJevAnswers(null, DOMAINS)).toBeNull();
      expect(normalizeJevAnswers([], DOMAINS)).toBeNull();
      expect(normalizeJevAnswers('ok', DOMAINS)).toBeNull();
    });
  });

  describe('rubric 代际标记', () => {
    it('当前代际 = v2（旧快照无 rubricVersion → 缺省为 v1；写入快照由 provider 负责）', () => {
      expect(EXPERIENCE_JUDGMENT_RUBRIC_VERSION).toBe('v2');
    });
  });

  describe('模型标识提取', () => {
    it('字符串原样（trim）；缺失/非字符串 → unknown；超长截到 64', () => {
      expect(extractJudgmentModel({ model: 'jev-latest' })).toBe('jev-latest');
      expect(extractJudgmentModel({ model: '  jev-fast  ' })).toBe('jev-fast');
      expect(extractJudgmentModel({ model: 42 })).toBe('unknown');
      expect(extractJudgmentModel({})).toBe('unknown');
      expect(extractJudgmentModel({ model: 'm'.repeat(200) })).toHaveLength(64);
    });
  });
});
