import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-tools'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import {
  runPreCommitChecks,
  formatCheckReport,
} from './lib/checks.js'
import { executeCommit } from './lib/commit.js'
import { scanWorkingTree, formatScanReport } from './lib/scanner.js'
import { stageFiles, stageAll } from './lib/stage.js'
import { scanForIgnore, formatIgnoreScanReport, writeGitignore } from './lib/ignore.js'
import type { CommandRunner, CommandResult, HarnessFs } from './lib/seams.js'
import { resolveWorkdir } from './lib/seams.js'
import {
  COMMIT_TEMPLATE_ZH,
  COMMIT_TEMPLATE_EN,
  GITIGNORE_TEMPLATE,
} from './lib/templates.js'

export const name = 'madoka-dsh-git-check'

/**
 * 声明依赖的官方 DSH contract：工具注册、人类命令、子进程执行、
 * 沙箱感知文件系统。`sandboxPolicy` 按需经 `ctx.get()` 读取（不清零注入），
 * 仅在文件系统声明约束模式时要求其存在。
 */
export const inject = ['tools', 'commands', 'subprocess', 'fs']

type ToolExecContext = ToolRunContext

const STDOUT_MAX_BYTES = 8 * 1024 * 1024
const STDERR_MAX_BYTES = 256 * 1024
/** 子进程终止升级的宽限期（terminate → kill）。 */
const SUBPROCESS_GRACE_MS = 2_000

const WORKDIR_DESCRIPTION =
  'Working directory for this tool. Defaults to the session workspace; a relative path is resolved against it.'

function textResult(text: string): { result: string } {
  return { result: text }
}

function renderTextResult(_args: unknown, value: { result: string }): [{ type: 'text'; text: string }] {
  return [{ type: 'text', text: value.result }]
}

const STRING_OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      result: { type: 'string', required: true },
    },
  },
  render: renderTextResult,
} as const

/**
 * 经 `ctx.subprocess` 适配命令执行：argv 直传、无 shell 层，
 * 跨平台（Windows / macOS / Linux）行为一致；非零退出是正常返回值，
 * 仅在进程无法启动或被取消/超时时抛错。
 */
function createRunner(ctx: Context, exec: ToolExecContext): CommandRunner {
  const workdir = exec.agent?.session.header.cwd ?? process.cwd()
  return {
    workdir,
    run: async (argv: readonly string[], options?: { cwd?: string }): Promise<CommandResult> => {
      const binary = argv[0]
      if (binary === undefined || binary.length === 0) {
        throw new Error('madoka-dsh-git-check: empty command')
      }
      let handle
      try {
        handle = ctx.subprocess.spawn({
          argv: [...argv],
          cwd: options?.cwd ?? workdir,
          stdio: {
            stdin: 'ignore',
            stdout: { maxBytes: STDOUT_MAX_BYTES },
            stderr: { maxBytes: STDERR_MAX_BYTES },
          },
          graceMs: SUBPROCESS_GRACE_MS,
          signal: exec.signal,
        })
      } catch (error) {
        if (exec.signal.aborted) throw error
        const reason = error instanceof Error ? error.message : String(error)
        throw new Error(`madoka-dsh-git-check: failed to start '${binary}': ${reason}`)
      }
      let outcome
      try {
        outcome = await handle.done
      } catch (error) {
        if (exec.signal.aborted) throw error
        const reason = error instanceof Error ? error.message : String(error)
        throw new Error(`madoka-dsh-git-check: '${binary}' subprocess failed: ${reason}`)
      }
      const stdout = handle.collected.stdout?.readFrom(0)?.text ?? ''
      const stderr = handle.collected.stderr?.readFrom(0)?.text ?? ''
      return {
        exitCode: outcome.exitCode ?? null,
        signal: outcome.signal ?? null,
        stdout,
        stderr,
      }
    },
  }
}

function resolveSandboxPolicy(ctx: Context, exec: ToolExecContext) {
  if (ctx.fs.sandboxMode === undefined) return undefined
  const policy = ctx.get('sandboxPolicy')
  if (policy === undefined) {
    throw new Error('madoka-dsh-git-check: the mounted filesystem confines but ctx.sandboxPolicy is missing')
  }
  const session = exec.agent?.session
  return policy.resolve(session === undefined ? {} : { session })
}

/**
 * 经 `ctx.fs` 适配文件读写：走沙箱裁决与读写观测（`fs/observed`），
 * 与 `str_replace_editor` 等第一方工具保持同一可观测性。
 */
function createHarnessFs(ctx: Context, exec: ToolExecContext): HarnessFs {
  return {
    readFileIfPresent: async (absPath: string): Promise<string | undefined> => {
      const target = await ctx.fs.resolve(absPath, { signal: exec.signal })
      const info = await ctx.fs.stat(target, exec.signal)
      if (info === undefined || info.type !== 'file') return undefined
      const content = await ctx.fs.readText(target, exec.signal)
      ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec)
      return content
    },
    listTopLevel: async (absPath: string): Promise<{ dirs: string[]; files: string[] }> => {
      const target = await ctx.fs.resolve(absPath, { signal: exec.signal })
      const entries = await ctx.fs.listDir(target, exec.signal)
      const dirs: string[] = []
      const files: string[] = []
      for (const entry of entries) {
        if (entry.type === 'directory') dirs.push(entry.name)
        else if (entry.type === 'file') files.push(entry.name)
      }
      return { dirs, files }
    },
    writeFile: async (absPath: string, content: string): Promise<void> => {
      const sandboxPolicy = resolveSandboxPolicy(ctx, exec)
      const target = await ctx.fs.resolve(absPath, { signal: exec.signal })
      const existing = await ctx.fs.stat(target, exec.signal)
      if (existing === undefined) {
        const intent = await ctx.waterfall('fs/write-intent', target, exec, () => ({ kind: 'createIfAbsent' }))
        const outcome = await ctx.fs.writeText(target, content, intent, exec.signal, sandboxPolicy)
        ctx.emit('fs/observed', target, { kind: 'present', version: outcome.version }, exec)
        return
      }
      if (existing.type !== 'file') {
        throw new Error(`madoka-dsh-git-check: ${target.displayPath} is not a regular file`)
      }
      const editIntent = await ctx.waterfall('fs/edit-intent', target, exec, () => undefined)
      const intent = editIntent === undefined
        ? { kind: 'replaceIfVersion' as const, version: existing.version }
        : { kind: 'replaceIfVersion' as const, version: editIntent.version }
      const outcome = await ctx.fs.writeText(target, content, intent, exec.signal, sandboxPolicy)
      ctx.emit('fs/observed', target, { kind: 'present', version: outcome.version }, exec)
    },
  }
}

export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'git_scan',
    description: '扫描 git 工作目录的所有变更（已暂存、未暂存、未追踪），按文件类型自动分类（源码、配置、文档、测试、样式、资源、构建产物等），返回结构化报告供 AI 分析决策。',
    parameters: {
      workdir: { type: 'string', description: WORKDIR_DESCRIPTION },
    },
    output: { ...STRING_OUTPUT },
    async execute(args, exec) {
      const runner = createRunner(ctx, exec)
      const worktree = resolveWorkdir(args.workdir, exec)
      const report = await scanWorkingTree(runner, worktree)
      return textResult(formatScanReport(report))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'git_stage',
    description: "暂存指定文件到 git 暂存区（git add）。mode='all' 暂存所有变更，mode='files' 暂存指定文件列表。",
    parameters: {
      mode: {
        type: 'string',
        required: true,
        enum: ['all', 'files'],
        description: "暂存模式: 'all' 暂存所有变更, 'files' 暂存指定文件",
      },
      files: {
        type: 'array',
        items: { type: 'string' },
        description: "mode='files' 时必填，要暂存的文件路径列表",
      },
      workdir: { type: 'string', description: WORKDIR_DESCRIPTION },
    },
    output: { ...STRING_OUTPUT },
    async execute(args, exec) {
      const runner = createRunner(ctx, exec)
      const worktree = resolveWorkdir(args.workdir, exec)
      if (args.mode === 'all') {
        const result = await stageAll(runner, worktree)
        return textResult(result.message)
      }
      if (args.files === undefined || args.files.length === 0) {
        return textResult("mode='files' 时必须提供 files 参数。")
      }
      const result = await stageFiles(runner, worktree, [...args.files])
      return textResult(result.message)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'pre_commit_check',
    description: '检查 git 暂存区的代码质量。检测冲突标记、调试语句、敏感信息、大文件、TODO 标记等问题，并返回 diff 内容供 AI 代码审查。',
    parameters: {
      workdir: { type: 'string', description: WORKDIR_DESCRIPTION },
    },
    output: { ...STRING_OUTPUT },
    async execute(args, exec) {
      const runner = createRunner(ctx, exec)
      const fs = createHarnessFs(ctx, exec)
      const worktree = resolveWorkdir(args.workdir, exec)
      const report = await runPreCommitChecks(runner, fs, worktree)
      return textResult(formatCheckReport(report))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'git_commit',
    description: '使用指定的提交信息执行 git commit（仅本地提交，不推送）。应在 pre_commit_check 通过后调用。',
    parameters: {
      message: {
        type: 'string',
        required: true,
        description: 'Conventional Commits 格式的提交信息',
      },
      workdir: { type: 'string', description: WORKDIR_DESCRIPTION },
    },
    output: { ...STRING_OUTPUT },
    async execute(args, exec) {
      const runner = createRunner(ctx, exec)
      const worktree = resolveWorkdir(args.workdir, exec)
      const result = await executeCommit(runner, worktree, args.message)
      if (result.success) {
        const hash = result.commitHash ?? 'N/A'
        return textResult(
          `提交成功！\n\n提交信息: ${args.message}\n提交哈希: ${hash}\n\n${result.message}\n\n💡 提示：提交仅在本地，未推送到远程仓库。`,
        )
      }
      return textResult(`提交失败:\n\n${result.message}`)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'gitignore_scan',
    description: '扫描项目结构，分析应添加到 .gitignore 的文件和目录。自动检测语言/框架（Node.js、Python、Rust、Go、Java 等）、编辑器配置、AI 工具产物、构建输出、系统文件等，返回当前 .gitignore 状态和建议新增的忽略规则。',
    parameters: {
      workdir: { type: 'string', description: WORKDIR_DESCRIPTION },
    },
    output: { ...STRING_OUTPUT },
    async execute(args, exec) {
      const runner = createRunner(ctx, exec)
      const fs = createHarnessFs(ctx, exec)
      const worktree = resolveWorkdir(args.workdir, exec)
      const report = await scanForIgnore(runner, fs, worktree)
      return textResult(formatIgnoreScanReport(report))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'gitignore_write',
    description: '将指定内容写入项目的 .gitignore 文件。应在 gitignore_scan 分析并经用户确认后调用。',
    parameters: {
      content: {
        type: 'string',
        required: true,
        description: '完整的 .gitignore 文件内容',
      },
      workdir: { type: 'string', description: WORKDIR_DESCRIPTION },
    },
    output: { ...STRING_OUTPUT },
    async execute(args, exec) {
      const fs = createHarnessFs(ctx, exec)
      const worktree = resolveWorkdir(args.workdir, exec)
      const result = await writeGitignore(fs, worktree, args.content)
      return textResult(result.message)
    },
  }))

  ctx.commands.register({
    name: 'commit',
    description: '一键扫描、分类、检查并提交（中文提交信息，不推送）',
    handler: (invocation) => {
      invocation.agent?.followup(createUserMessage({
        content: [{ type: 'text', text: COMMIT_TEMPLATE_ZH }],
        source: { kind: 'user' },
      }))
      return {
        kind: 'success' as const,
        text: '已注入中文一键提交流程：扫描 → 分类 → 暂存 → 检查 → 审查 → 提交（仅本地，不推送）。',
      }
    },
  })

  ctx.commands.register({
    name: 'commit-en',
    description: 'One-click scan, classify, check and commit (English, no push)',
    handler: (invocation) => {
      invocation.agent?.followup(createUserMessage({
        content: [{ type: 'text', text: COMMIT_TEMPLATE_EN }],
        source: { kind: 'user' },
      }))
      return {
        kind: 'success' as const,
        text: 'English one-click commit workflow injected: scan, classify, stage, check, review, then commit locally (no push).',
      }
    },
  })

  ctx.commands.register({
    name: 'gitignore',
    description: '分析项目结构，智能生成/更新 .gitignore',
    handler: (invocation) => {
      invocation.agent?.followup(createUserMessage({
        content: [{ type: 'text', text: GITIGNORE_TEMPLATE }],
        source: { kind: 'user' },
      }))
      return {
        kind: 'success' as const,
        text: '已注入 .gitignore 生成流程：扫描项目 → 分析建议 → 确认后写入。',
      }
    },
  })
}
