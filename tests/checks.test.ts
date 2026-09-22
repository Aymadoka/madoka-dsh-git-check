import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  checkConflictMarkers,
  checkDebugStatements,
  checkFileSize,
  checkSensitiveInfo,
  checkTodoMarkers,
  formatCheckReport,
  parseAddedLines,
  runPreCommitChecks,
  type AddedLine,
  type CheckIssue,
} from '../src/lib/checks.js'
import { FakeRunner, FakeFs, ok } from './helpers.js'

function collect(file: string, lines: string[]): CheckIssue[] {
  const added: AddedLine[] = lines.map((text, i) => ({ lineNo: i + 1, text }))
  const issues: CheckIssue[] = []
  checkConflictMarkers(added, file, issues)
  checkDebugStatements(added, file, issues)
  checkSensitiveInfo(added, file, issues)
  checkTodoMarkers(added, file, issues)
  checkFileSize(lines.join('\n'), file, issues)
  return issues
}

describe('parseAddedLines', () => {
  it('maps hunk headers to new-file line numbers', () => {
    const diff = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1,3 +1,4 @@',
      ' keep',
      '-old',
      '+new1',
      '+new2',
      '@@ -10 +11 @@',
      '+far',
    ].join('\n')
    assert.deepEqual(parseAddedLines(diff), [
      { lineNo: 2, text: 'new1' },
      { lineNo: 3, text: 'new2' },
      { lineNo: 11, text: 'far' },
    ])
  })
})

describe('content checks', () => {
  it('flags conflict markers as errors', () => {
    const issues = collect('a.ts', ['<<<<<<< HEAD', 'code'])
    assert.deepEqual(issues, [{
      type: 'conflict-marker', severity: 'error',
      message: '存在未解决的合并冲突标记', file: 'a.ts', line: 1,
    }])
  })

  it('flags debug statements as warnings', () => {
    const issues = collect('a.ts', ['console.log(x)', 'debugger', 'const a = 1'])
    assert.equal(issues.filter((i) => i.type === 'debug-statement').length, 2)
    assert.ok(issues.every((i) => i.severity === 'warning'))
  })

  it('does not flag print with file= as debug', () => {
    assert.deepEqual(collect('a.py', ['print(x, file=sys.stderr)']), [])
  })

  it('flags hardcoded secrets as errors', () => {
    const issues = collect('a.ts', [
      'const password = "s3cr3t!"',
      'const key = AKIAIOSFODNN7EXAMPLE',
      '-----BEGIN RSA PRIVATE KEY-----',
    ])
    assert.equal(issues.filter((i) => i.severity === 'error').length, 3)
  })

  it('flags TODO markers as info', () => {
    const issues = collect('a.ts', ['// TODO: fix later', '// FIXME broken'])
    assert.deepEqual(issues.map((i) => i.message), ['包含 TODO 标记', '包含 FIXME 标记'])
    assert.ok(issues.every((i) => i.severity === 'info'))
  })

  it('flags oversized files', () => {
    const issues: CheckIssue[] = []
    checkFileSize('x'.repeat(2 * 1024 * 1024), 'big.bin', issues)
    assert.equal(issues.length, 1)
    assert.equal(issues[0]?.type, 'large-file')
  })
})

describe('runPreCommitChecks', () => {
  it('errors when nothing is staged', async () => {
    const runner = new FakeRunner().on('diff', ok(''))
    const report = await runPreCommitChecks(runner, new FakeFs(), '/repo')
    assert.equal(report.passed, false)
    assert.equal(report.issues[0]?.type, 'no-staged-files')
  })

  it('passes a clean staged change and returns diff', async () => {
    const runner = new FakeRunner()
      .on('diff', (argv) => {
        if (argv.includes('--name-only')) return ok('a.ts\n')
        if (argv.includes('--stat')) return ok(' a.ts | 2 +-')
        if (argv.includes('-U0')) return ok('diff\n@@ -1 +1 @@\n-old\n+new')
        if (argv.length === 3) return ok('diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-old\n+new\n')
        return ok('')
      })
      .on('show', ok('const a = 1\n'))
    const report = await runPreCommitChecks(runner, new FakeFs(), '/repo')
    assert.deepEqual(report.stagedFiles, ['a.ts'])
    assert.equal(report.passed, true)
    assert.ok(report.diffSummary.includes('+new'))
    assert.ok(formatCheckReport(report).includes('所有检查通过'))
  })

  it('runs project lint when a lint script exists', async () => {
    const runner = new FakeRunner()
      .on('diff', (argv) => {
        if (argv.includes('--name-only')) return ok('a.ts\n')
        if (argv.includes('--stat')) return ok('stat')
        return ok('diff')
      })
      .on('show', ok('ok\n'))
      .on('run', { exitCode: 1, signal: null, stdout: 'lint failed!', stderr: '' })
    const fs = new FakeFs()
    fs.files.set('/repo/package.json', JSON.stringify({ scripts: { lint: 'eslint .' } }))
    const report = await runPreCommitChecks(runner, fs, '/repo')
    assert.ok(report.issues.some((i) => i.type === 'lint-error'))
    // lint 失败只是 warning，不阻塞提交
    assert.equal(report.passed, true)
  })
})
