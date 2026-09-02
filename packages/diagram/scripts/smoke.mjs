#!/usr/bin/env node
/**
 * @agent-chamber/diagram smoke — vendored archify 渲染器冒烟验证。
 *
 * 对 5 个 fixture（architecture / workflow / sequence / dataflow / lifecycle 各 1）逐一：
 *   1. 跑渲染器（renderers/<type>/render-<type>.mjs）→ 生成 HTML；
 *   2. 跑 artifact checker（scripts/check-render-output.mjs）→ 断言 ok=true；
 *   3. 确定性断言：同一 fixture 连渲两次，HTML sha256 相等
 *      （"HTML 是 IR 的确定性编译产物"的机器验证，plan §6.5）。
 *
 * spawn 方式照 bin/archify.mjs 先例：process.execPath + env 合并
 * `{...process.env, ARCHIFY_DIAGNOSTIC_FORMAT:'json'}`（失败时渲染器以 JSON
 * receipt 写 stderr 并 exit≠0，见 renderers/shared/diagnostics.mjs）。
 *
 * 退出码：0 = 全部通过；1 = 任一失败（输出清晰摘要）。
 * 临时文件：fs.mkdtemp(os.tmpdir())，finally 清理。
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(__dirname, '..');

// 5 型 fixture 映射：类型 → fixture 文件名（test/fixtures/ 下，每类型 1 个）
const FIXTURES = [
  { type: 'architecture', file: 'web-app.architecture.json' },
  { type: 'workflow', file: 'agent-tool-call.workflow.json' },
  { type: 'sequence', file: 'async-job-roundtrip.sequence.json' },
  { type: 'dataflow', file: 'product-analytics.dataflow.json' },
  { type: 'lifecycle', file: 'agent-run.lifecycle.json' },
];

// 渲染器/checker 的 spawn env：合并宿主环境 + 开启 JSON 诊断格式
// （与 bin/archify.mjs:54 的 runNode 同款合并写法；不设置 ARCHIFY_REPO_ROOT）
const SPAWN_ENV = { ...process.env, ARCHIFY_DIAGNOSTIC_FORMAT: 'json' };

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

/** 跑一个子进程，返回 { status, stdout, stderr }；spawn 异常（ENOENT 等）也捕获。 */
function runNode(args) {
  try {
    const result = spawnSync(process.execPath, args, {
      cwd: pkgRoot,
      encoding: 'utf8',
      env: SPAWN_ENV,
    });
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  } catch (err) {
    return { status: null, stdout: '', stderr: `spawn failed: ${err.message}` };
  }
}

/** 渲染一个 fixture 到 outPath；返回 { ok, html, stderr }。 */
function render(type, inputPath, outPath) {
  const renderer = path.join(pkgRoot, 'renderers', type, `render-${type}.mjs`);
  const result = runNode([renderer, inputPath, outPath]);
  if (result.status !== 0) {
    return { ok: false, html: null, stderr: result.stderr || `renderer exit ${result.status}` };
  }
  let html;
  try {
    html = fs.readFileSync(outPath, 'utf8');
  } catch (err) {
    return { ok: false, html: null, stderr: `output not readable: ${err.message}` };
  }
  return { ok: true, html, stderr: result.stderr };
}

/** 跑 checker；返回 { ok, json }（json = stdout 解析结果，失败时 null）。 */
function check(htmlPath) {
  const checker = path.join(pkgRoot, 'scripts', 'check-render-output.mjs');
  const result = runNode([checker, htmlPath]);
  if (result.status !== 0) {
    return { ok: false, json: null, stderr: result.stderr || `checker exit ${result.status}` };
  }
  try {
    const json = JSON.parse(result.stdout);
    return { ok: json.ok === true, json, stderr: result.stderr };
  } catch (err) {
    return { ok: false, json: null, stderr: `checker stdout not JSON: ${err.message}` };
  }
}

let failures = 0;
let tmpDir = null;
try {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diagram-smoke-'));
  for (const { type, file } of FIXTURES) {
    const inputPath = path.join(pkgRoot, 'test', 'fixtures', file);
    const out1 = path.join(tmpDir, `${type}-1.html`);
    const out2 = path.join(tmpDir, `${type}-2.html`);
    const label = `${type} (${file})`;

    // 第一次渲染 + checker
    const first = render(type, inputPath, out1);
    if (!first.ok) {
      failures += 1;
      console.error(`FAIL  ${label}: render #1 failed\n${first.stderr}`);
      continue;
    }
    const check1 = check(out1);
    if (!check1.ok) {
      failures += 1;
      console.error(`FAIL  ${label}: checker rejected render #1\n${check1.stderr}`);
      continue;
    }

    // 第二次渲染（确定性断言：两次 HTML sha256 必须相等）
    const second = render(type, inputPath, out2);
    if (!second.ok) {
      failures += 1;
      console.error(`FAIL  ${label}: render #2 failed\n${second.stderr}`);
      continue;
    }
    const hash1 = sha256(first.html);
    const hash2 = sha256(second.html);
    if (hash1 !== hash2) {
      failures += 1;
      console.error(`FAIL  ${label}: determinism broken (sha256 #1=${hash1} #2=${hash2})`);
      continue;
    }

    const { summary } = check1.json.composition;
    console.log(
      `PASS  ${label}: html=${first.html.length} bytes, sha256=${hash1.slice(0, 12)}…, ` +
        `checks=${check1.json.checks.length}, composition errors=${summary.errors} warnings=${summary.warnings}`,
    );
  }
} finally {
  // 无论成败都清理临时目录（覆盖 spawn 异常路径）
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\nsmoke FAILED: ${failures}/${FIXTURES.length} fixture(s) failed`);
  process.exit(1);
}
console.log(
  `\nsmoke PASSED: ${FIXTURES.length}/${FIXTURES.length} fixtures rendered, checked, deterministic`,
);
