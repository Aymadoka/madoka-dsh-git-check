import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { stageAll, stageFiles } from '../src/lib/stage.js'
import { executeCommit } from '../src/lib/commit.js'
import { resolveWorkdir } from '../src/lib/seams.js'
import { FakeRunner, ok, fail } from './helpers.js'

describe('stageAll', () => {
  it('stages everything and reports the count', async () => {
    const runner = new FakeRunner()
      .on('add', ok(''))
      .on('diff', ok('a.ts\nb.ts\n'))
    const result = await stageAll(runner, '/repo')
    assert.equal(result.success, true)
    assert.deepEqual(result.stagedFiles, ['a.ts', 'b.ts'])
    assert.ok(result.message.includes('2 个文件'))
    assert.deepEqual(runner.calls[0], ['git', 'add', '-A'])
  })

  it('reports add failures', async () => {
    const runner = new FakeRunner().on('add', fail('permission denied'))
    const result = await stageAll(runner, '/repo')
    assert.equal(result.success, false)
    assert.ok(result.message.includes('git add -A 失败'))
  })
})

describe('stageFiles', () => {
  it('stages listed files one by one without shell quoting', async () => {
    const runner = new FakeRunner().on('add', ok(''))
    const result = await stageFiles(runner, '/repo', ['a b.ts', 'c.ts'])
    assert.equal(result.success, true)
    assert.deepEqual(runner.calls, [
      ['git', 'add', '--', 'a b.ts'],
      ['git', 'add', '--', 'c.ts'],
    ])
  })

  it('reports partial failures', async () => {
    const runner = new FakeRunner().on('add', (argv) =>
      (argv[3] ?? '').includes('bad') ? fail('no such file') : ok(''),
    )
    const result = await stageFiles(runner, '/repo', ['good.ts', 'bad.ts'])
    assert.equal(result.success, true)
    assert.deepEqual(result.stagedFiles, ['good.ts'])
    assert.ok(result.message.includes('暂存失败'))
  })

  it('rejects an empty file list', async () => {
    const result = await stageFiles(new FakeRunner(), '/repo', [])
    assert.equal(result.success, false)
  })
})

describe('executeCommit', () => {
  it('commits and extracts the hash', async () => {
    const runner = new FakeRunner().on('commit', ok('[main abc1234] feat(x): hello\n 1 file changed\n'))
    const result = await executeCommit(runner, '/repo', 'feat(x): hello')
    assert.equal(result.success, true)
    assert.equal(result.commitHash, 'abc1234')
    assert.deepEqual(runner.calls[0], ['git', 'commit', '-m', 'feat(x): hello'])
  })

  it('rejects empty messages and reports failures', async () => {
    assert.equal((await executeCommit(new FakeRunner(), '/repo', '  ')).success, false)
    const runner = new FakeRunner().on('commit', fail('nothing to commit'))
    const result = await executeCommit(runner, '/repo', 'feat: x')
    assert.equal(result.success, false)
    assert.ok(result.message.includes('nothing to commit'))
  })
})

describe('resolveWorkdir', () => {
  it('prefers the explicit workdir, resolving relatives against the session cwd', async () => {
    const { resolve } = await import('node:path')
    const root = process.platform === 'win32' ? 'C:\\repo' : '/repo'
    const abs = process.platform === 'win32' ? 'C:\\other' : '/other'
    const exec = { agent: { session: { header: { cwd: root } } } }
    assert.equal(resolveWorkdir(undefined, exec), root)
    assert.equal(resolveWorkdir(abs, exec), abs)
    assert.equal(resolveWorkdir('sub/dir', exec), resolve(root, 'sub/dir'))
  })

  it('falls back to process.cwd() without a session', () => {
    assert.equal(resolveWorkdir(undefined, {}), process.cwd())
  })
})
