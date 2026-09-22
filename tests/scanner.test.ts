import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyFile,
  formatScanReport,
  scanWorkingTree,
  type ScanReport,
} from '../src/lib/scanner.js'
import { FakeRunner, ok, fail } from './helpers.js'

describe('classifyFile', () => {
  const cases: [string, string][] = [
    ['src/index.ts', 'source'],
    ['lib/scanner.js', 'source'],
    ['main.py', 'source'],
    ['main.go', 'source'],
    ['App.vue', 'source'],
    ['package.json', 'config'],
    ['tsconfig.json', 'config'],
    ['.env', 'config'],
    ['.env.local', 'config'],
    ['vite.config.ts', 'config'],
    ['README.md', 'docs'],
    ['docs/guide.md', 'docs'],
    ['LICENSE', 'docs'],
    ['CHANGELOG.md', 'docs'],
    ['src/foo.test.ts', 'test'],
    ['tests/bar.spec.js', 'test'],
    ['__tests__/a.ts', 'test'],
    ['src/test_helper.py', 'source'],
    ['styles/app.css', 'style'],
    ['theme/dark.scss', 'style'],
    ['assets/logo.png', 'asset'],
    ['fonts/a.woff2', 'asset'],
    ['dist/bundle.js', 'build'],
    ['build/out.css', 'build'],
    ['.next/static/x.js', 'build'],
    ['notes.txt', 'docs'],
    ['random.bin', 'other'],
  ]
  for (const [file, expected] of cases) {
    it(`classifies ${file} as ${expected}`, () => {
      assert.equal(classifyFile(file), expected)
    })
  }
})

describe('scanWorkingTree', () => {
  function baseRunner(): FakeRunner {
    return new FakeRunner()
      .on('status', ok(' M src/index.ts\nA  docs/guide.md\n?? newfile.txt\n'))
      .on('branch', ok('main\n'))
      .on('diff', ok(''))
      .on('rev-list', fail('fatal: no upstream'))
  }

  it('parses porcelain status and tolerates missing upstream', async () => {
    const report = await scanWorkingTree(baseRunner(), '/repo')
    assert.equal(report.branch, 'main')
    assert.equal(report.unpushedCommits, 0)
    assert.equal(report.allFiles.length, 3)
    assert.deepEqual(
      report.allFiles.map((f) => [f.file, f.status, f.category]),
      [
        ['src/index.ts', 'modified', 'source'],
        ['docs/guide.md', 'added', 'docs'],
        ['newfile.txt', 'untracked', 'docs'],
      ],
    )
  })

  it('parses renames and unpushed commits', async () => {
    const runner = new FakeRunner()
      .on('status', ok('R  new.ts -> old.ts\n'))
      .on('branch', ok('feature\n'))
      .on('diff', ok(''))
      .on('rev-list', ok('3\n'))
    const report = await scanWorkingTree(runner, '/repo')
    assert.equal(report.unpushedCommits, 3)
    const first = report.allFiles[0]
    assert.ok(first)
    assert.equal(first.file, 'old.ts')
    assert.equal(first.status, 'renamed')
    assert.equal(first.oldFile, 'new.ts')
  })

  it('merges numstat additions/deletions', async () => {
    const runner = new FakeRunner()
      .on('status', ok(' M a.ts\n'))
      .on('branch', ok('main\n'))
      .on('diff', (argv) => (argv.includes('--cached') ? ok('10\t2\ta.ts\n') : ok('3\t1\ta.ts\n')))
      .on('rev-list', ok('0\n'))
    const report = await scanWorkingTree(runner, '/repo')
    const first = report.allFiles[0]
    assert.ok(first)
    assert.equal(first.additions, 13)
    assert.equal(first.deletions, 3)
  })
})

describe('formatScanReport', () => {
  it('reports a clean tree', () => {
    const report: ScanReport = {
      categories: { source: [], config: [], docs: [], test: [], style: [], asset: [], build: [], other: [] },
      allFiles: [],
      stagedFiles: [],
      branch: 'main',
      unpushedCommits: 0,
    }
    assert.ok(formatScanReport(report).includes('没有任何变更'))
  })

  it('groups by category with totals', () => {
    const report: ScanReport = {
      categories: {
        source: [{ file: 'a.ts', status: 'modified', category: 'source', additions: 5, deletions: 1 }],
        config: [],
        docs: [{ file: 'README.md', status: 'added', category: 'docs' }],
        test: [], style: [], asset: [], build: [], other: [],
      },
      allFiles: [
        { file: 'a.ts', status: 'modified', category: 'source', additions: 5, deletions: 1 },
        { file: 'README.md', status: 'added', category: 'docs' },
      ],
      stagedFiles: ['a.ts'],
      branch: 'main',
      unpushedCommits: 2,
    }
    const text = formatScanReport(report)
    assert.ok(text.includes('📦 源码'))
    assert.ok(text.includes('📄 文档'))
    assert.ok(text.includes('✅已暂存'))
    assert.ok(text.includes('**总计**: +5/-1 行'))
    assert.ok(text.includes('**未推送提交**: 2 个'))
  })
})
