/**
 * 探针夹具 —— 唯一职责：**故意把注入打进 fail-open，让日志器真的写一行 ERROR**。
 *
 * 为什么必须是「真的写」而不是 mock 日志器：
 *   自检污染检查要证明的是「日志落点被隔离了」。如果探针用 mock/桩替代真正的
 *   `inject.mjs` 子进程，那么隔离判据验证的就是**桩的落点**，不是生产写路径的落点 ——
 *   判据和被测对象一起被替身掉了，破坏测试立刻失去意义（注入被改成往 cwd 写，
 *   探针照样绿）。
 *
 * 本文件住在 `tests/fixtures/` 下，`listTestFiles()` 只做非递归扫 `tests/*.test.mjs`，
 * 所以它**不会被全量自检自动收进**；只有 `tests/self-check-hygiene.test.mjs` 显式点名跑它。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const PROTOCOL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

test('探针：坏配置 → 注入 fail-open（必须真的记一条 ERROR，否则下面的隔离判据是空断言）', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'si-log-probe-'))
  try {
    const cfg = path.join(tmp, 'config-broken.yaml')
    // 与 tests/fixtures/inject/config-broken.yaml 同一形态：行内数组缺右括号。
    // 这里就地写而不是复制那份夹具，是为了让探针在被判为「哪个文件该跑」时能独立成活。
    writeFileSync(cfg, 'version: 1\nscope:\n  values: [infra, testing\n  default: other\n', 'utf8')
    const r = spawnSync(process.execPath, [path.join(PROTOCOL_ROOT, 'scripts', 'inject.mjs'), '--config', cfg, '--scope', 'infra', '--keywords', 'docker'], {
      encoding: 'utf8',
      timeout: 120_000,
    })
    assert.equal(r.status, 0, `fail-open 必须 exit 0，实得 ${r.status}\n${r.stderr ?? ''}`)
    assert.match(r.stderr ?? '', /fail-open/, '必须真的走到 fail-open 分支，否则本探针没起到写入作用')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})
