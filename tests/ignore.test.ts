import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  formatIgnoreScanReport,
  matchSimpleGlob,
  scanForIgnore,
  writeGitignore,
} from '../src/lib/ignore.js'
import { FakeRunner, FakeFs, ok } from './helpers.js'

describe('matchSimpleGlob', () => {
  const cases: [string, string, boolean][] = [
    ['a.log', '*.log', true],
    ['a.txt', '*.log', false],
    ['.env', '.env', true],
    ['debug.log.1', '*.log', false],
    ['npm-debug.log.0', 'npm-debug.log*', true],
  ]
  for (const [file, pattern, expected] of cases) {
    it(`${file} vs ${pattern} -> ${expected}`, () => {
      assert.equal(matchSimpleGlob(file, pattern), expected)
    })
  }
})

describe('scanForIgnore', () => {
  function setup(): { fs: FakeFs; runner: FakeRunner } {
    const fs = new FakeFs()
    fs.dirs = ['node_modules', 'dist', '.vscode', 'src']
    fs.topFiles = ['package.json', 'tsconfig.json', 'README.md']
    const runner = new FakeRunner().on('ls-files', ok('package.json\ntsconfig.json\nsrc/index.ts\n'))
    return { fs, runner }
  }

  it('suggests node_modules/dist/vscode rules for a TS project', async () => {
    const { fs, runner } = setup()
    const report = await scanForIgnore(runner, fs, '/repo')
    assert.equal(report.currentIgnore, null)
    const patterns = report.suggestions.map((s) => s.pattern).join(' ')
    assert.ok(patterns.includes('node_modules/'))
    assert.ok(patterns.includes('dist/'))
    assert.ok(patterns.includes('.vscode/'))
    assert.ok(formatIgnoreScanReport(report).includes('尚未创建 .gitignore'))
  })

  it('filters out rules already present', async () => {
    const { fs, runner } = setup()
    fs.files.set('/repo/.gitignore', '# deps\nnode_modules/\n')
    const report = await scanForIgnore(runner, fs, '/repo')
    assert.ok(report.currentIgnore?.includes('node_modules/'))
    assert.ok(!report.suggestions.map((s) => s.pattern).join(' ').includes('node_modules/'))
    assert.ok(formatIgnoreScanReport(report).includes('当前 .gitignore'))
  })

  it('falls back to top-level files when git ls-files fails', async () => {
    const { fs } = setup()
    const runner = new FakeRunner().on('ls-files', {
      exitCode: 128, signal: null, stdout: '', stderr: 'not a git repo',
    })
    const report = await scanForIgnore(runner, fs, '/repo')
    assert.deepEqual(report.configFiles, ['package.json', 'tsconfig.json', 'README.md'])
  })
})

describe('writeGitignore', () => {
  it('normalizes the trailing newline', async () => {
    const fs = new FakeFs()
    const result = await writeGitignore(fs, '/repo', 'node_modules/')
    assert.equal(result.success, true)
    assert.equal(fs.files.get('/repo/.gitignore'), 'node_modules/\n')
  })
})
