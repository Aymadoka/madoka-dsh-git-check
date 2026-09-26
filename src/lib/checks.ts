import { splitGitLines } from './scanner.js'
import type { CommandRunner, HarnessFs } from './seams.js'

export interface AddedLine {
  lineNo: number
  text: string
}

export type CheckSeverity = 'error' | 'warning' | 'info'

export interface CheckIssue {
  type: string
  severity: CheckSeverity
  message: string
  file?: string
  line?: number
}

export interface PreCommitReport {
  passed: boolean
  issues: CheckIssue[]
  stagedFiles: string[]
  diffSummary: string
  diff: string
  stat: string
}

const LARGE_FILE_BYTES = 1024 * 1024

/** 解析 unified diff，映射新增行为新文件行号。 */
export function parseAddedLines(diff: string): AddedLine[] {
  const result: AddedLine[] = []
  let newLineNo = 0
  let inHunk = false
  for (const raw of diff.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
    if (hunk) {
      newLineNo = Number.parseInt(hunk[1] ?? '1', 10) || 1
      inHunk = true
      continue
    }
    if (!inHunk) continue
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff --git')) continue
    if (line.startsWith('\\')) continue
    if (line.startsWith('+')) {
      result.push({ lineNo: newLineNo, text: line.slice(1) })
      newLineNo += 1
    } else if (line.startsWith('-')) {
      // 删除行只占旧文件行号，新文件行号不变
    } else {
      // 上下文行（含以空格开头）新旧行号同步 +1；空行视为上下文
      newLineNo += 1
    }
  }
  return result
}

/** 未解决的合并冲突标记 → error。 */
export function checkConflictMarkers(added: AddedLine[], file: string, issues: CheckIssue[]): void {
  for (const line of added) {
    const t = line.text
    if (t.startsWith('<<<<<<<') || t.startsWith('=======') || t.startsWith('>>>>>>>')) {
      issues.push({
        type: 'conflict-marker',
        severity: 'error',
        message: '存在未解决的合并冲突标记',
        file,
        line: line.lineNo,
      })
    }
  }
}

const CONSOLE_RE = /\bconsole\.(log|debug|info|warn|error|trace)\s*\(/
const DEBUGGER_RE = /^\s*debugger\b/
const ALERT_RE = /\b(alert|confirm|prompt)\s*\(/
const PRINT_RE = /\bprint\s*\(/
const PDB_RE = /\b(pdb\.set_trace|breakpoint\s*\()\s*\)?/

/** 调试语句 → warning；Python 带 file= 的 print 视为正常日志，不误报。 */
export function checkDebugStatements(added: AddedLine[], file: string, issues: CheckIssue[]): void {
  const isPython = file.endsWith('.py')
  for (const line of added) {
    const t = line.text
    if (CONSOLE_RE.test(t) || DEBUGGER_RE.test(t) || ALERT_RE.test(t) || PDB_RE.test(t)) {
      issues.push({
        type: 'debug-statement',
        severity: 'warning',
        message: `疑似调试语句: ${t.trim().slice(0, 80)}`,
        file,
        line: line.lineNo,
      })
      continue
    }
    if (PRINT_RE.test(t)) {
      // print(x, file=sys.stderr) 是正常日志写法，不告警
      if (isPython && t.includes('file=')) continue
      issues.push({
        type: 'debug-statement',
        severity: 'warning',
        message: `疑似调试语句: ${t.trim().slice(0, 80)}`,
        file,
        line: line.lineNo,
      })
    }
  }
}

const SECRET_ASSIGN_RE = /(password|passwd|secret|api[_-]?key|access[_-]?key|private[_-]?key|token)\s*[:=]\s*["'][^"']+["']/i
const AWS_KEY_RE = /\bAKIA[0-9A-Z]{16}\b/
const PRIVATE_KEY_RE = /-----BEGIN .*PRIVATE KEY-----/
const CONNECTION_STRING_RE = /(mongodb|postgres|mysql|redis):\/\/[^\s"']+/i

/** 硬编码敏感信息 → error。 */
export function checkSensitiveInfo(added: AddedLine[], file: string, issues: CheckIssue[]): void {
  for (const line of added) {
    const t = line.text
    if (
      SECRET_ASSIGN_RE.test(t) || AWS_KEY_RE.test(t) ||
      PRIVATE_KEY_RE.test(t) || CONNECTION_STRING_RE.test(t)
    ) {
      issues.push({
        type: 'sensitive-info',
        severity: 'error',
        message: `疑似硬编码敏感信息: ${t.trim().slice(0, 80)}`,
        file,
        line: line.lineNo,
      })
    }
  }
}

/** TODO / FIXME 等标记 → info（不阻塞提交）。 */
export function checkTodoMarkers(added: AddedLine[], file: string, issues: CheckIssue[]): void {
  for (const line of added) {
    const t = line.text
    if (t.includes('TODO')) {
      issues.push({ type: 'todo-marker', severity: 'info', message: '包含 TODO 标记', file, line: line.lineNo })
    } else if (t.includes('FIXME')) {
      issues.push({ type: 'todo-marker', severity: 'info', message: '包含 FIXME 标记', file, line: line.lineNo })
    } else if (t.includes('HACK')) {
      issues.push({ type: 'todo-marker', severity: 'info', message: '包含 HACK 标记', file, line: line.lineNo })
    } else if (t.includes('XXX')) {
      issues.push({ type: 'todo-marker', severity: 'info', message: '包含 XXX 标记', file, line: line.lineNo })
    }
  }
}

/** 大文件 → warning（默认 1MB 阈值）。 */
export function checkFileSize(content: string, file: string, issues: CheckIssue[]): void {
  if (content.length >= LARGE_FILE_BYTES) {
    issues.push({
      type: 'large-file',
      severity: 'warning',
      message: `文件过大(${(content.length / 1024 / 1024).toFixed(2)}MB)，建议使用 Git LFS 或拆分`,
      file,
    })
  }
}

function joinWorkPath(workdir: string, name: string): string {
  return `${workdir.replace(/\/$/, '')}/${name}`
}

/** 预提交检查：暂存区内容检查 + 文件体积 + 项目 lint（lint 失败仅 warning）。 */
export async function runPreCommitChecks(
  runner: CommandRunner,
  fs: HarnessFs,
  workdir: string,
): Promise<PreCommitReport> {
  const issues: CheckIssue[] = []

  const nameOnly = await safeText(runner, ['git', 'diff', '--cached', '--name-only'], workdir)
  const stagedFiles = splitGitLines(nameOnly).map((l) => l.trim()).filter((l) => l.length > 0)
  if (stagedFiles.length === 0) {
    return {
      passed: false,
      issues: [{ type: 'no-staged-files', severity: 'error', message: '暂存区为空：请先 git add 需要提交的文件。' }],
      stagedFiles: [],
      diffSummary: '',
      diff: '',
      stat: '',
    }
  }

  const stat = await safeText(runner, ['git', 'diff', '--cached', '--stat'], workdir)
  const fullDiff = await safeText(runner, ['git', 'diff', '--cached'], workdir)
  const zeroContext = await safeText(runner, ['git', 'diff', '--cached', '-U0'], workdir)

  const addedByFile = new Map<string, AddedLine[]>()
  // 用 -U0 精确定位新增行；失败时回退到全量 diff 解析
  const parsed = parseAddedLines(zeroContext.length > 0 ? zeroContext : fullDiff)
  if (zeroContext.length === 0) {
    void 0
  }
  // parseAddedLines 是全文件混合行号，需要按文件切分：逐文件 diff 分别解析
  void parsed
  const perFileDiffs = splitDiffByFile(fullDiff)
  const perFileZero = splitDiffByFile(zeroContext)
  for (const file of stagedFiles) {
    const target = perFileZero.get(file) ?? perFileDiffs.get(file) ?? ''
    addedByFile.set(file, target ? parseAddedLines(target) : [])
  }

  for (const file of stagedFiles) {
    const added = addedByFile.get(file) ?? []
    checkConflictMarkers(added, file, issues)
    checkDebugStatements(added, file, issues)
    checkSensitiveInfo(added, file, issues)
    checkTodoMarkers(added, file, issues)
    const content = await safeShow(runner, file, workdir)
    if (content !== undefined) checkFileSize(content, file, issues)
  }

  // 项目 lint：package.json 存在 lint 脚本才运行，失败仅 warning
  try {
    const pkgRaw = await fs.readFileIfPresent(joinWorkPath(workdir, 'package.json'))
    if (pkgRaw !== undefined) {
      const pkg = JSON.parse(pkgRaw) as { scripts?: Record<string, string> }
      if (pkg.scripts?.['lint']) {
        try {
          const lintRes = await runner.run(['npm', 'run', 'lint', '--silent'], { cwd: workdir })
          if (lintRes.exitCode !== 0) {
            const detail = (lintRes.stdout.trim() || lintRes.stderr.trim()).slice(0, 500)
            issues.push({
              type: 'lint-error',
              severity: 'warning',
              message: `lint 未通过${detail ? `: ${detail}` : ''}`,
            })
          }
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error)
          issues.push({ type: 'lint-error', severity: 'warning', message: `lint 执行失败: ${reason}` })
        }
      }
    }
  } catch {
    // package.json 不可读时跳过 lint
  }

  const passed = !issues.some((i) => i.severity === 'error')
  const diffSummary = stat.length > 0 ? `${stat}\n${fullDiff}`.trim() : fullDiff.trim()
  return { passed, issues, stagedFiles, diffSummary, diff: fullDiff, stat }
}

async function safeText(runner: CommandRunner, argv: readonly string[], cwd: string): Promise<string> {
  try {
    const res = await runner.run(argv, { cwd })
    return res.exitCode === 0 ? res.stdout : ''
  } catch {
    return ''
  }
}

async function safeShow(runner: CommandRunner, file: string, cwd: string): Promise<string | undefined> {
  try {
    const res = await runner.run(['git', 'show', `:${file}`], { cwd })
    return res.exitCode === 0 ? res.stdout : undefined
  } catch {
    return undefined
  }
}

/** 按 `diff --git` 切分多文件 diff，便于逐文件解析新增行。 */
function splitDiffByFile(diff: string): Map<string, string> {
  const result = new Map<string, string>()
  const lines = diff.split('\n')
  let current: string | undefined
  let buf: string[] = []
  const flush = (): void => {
    if (current) result.set(current, buf.join('\n'))
  }
  for (const raw of lines) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    const m = line.match(/^diff --git a\/(.*) b\/(.*)$/)
    if (m) {
      flush()
      current = m[2] ?? m[1] ?? ''
      buf = [line]
    } else if (current !== undefined) {
      buf.push(line)
    }
  }
  flush()
  // 单文件无头 diff（如测试中的裸 hunk）归属到唯一暂存文件由调用方处理
  return result
}

/** 格式化为中文检查报告，供 AI 审查决策。 */
export function formatCheckReport(report: PreCommitReport): string {
  const out: string[] = []
  out.push(report.passed ? '✅ 所有检查通过' : '❌ 检查未通过')
  out.push(`已暂存 ${report.stagedFiles.length} 个文件: ${report.stagedFiles.join(', ') || '（无）'}`)
  if (report.issues.length === 0) {
    out.push('')
    out.push('未发现冲突标记、调试语句、敏感信息、大文件或 TODO 阻塞项。')
  } else {
    const label: Record<CheckSeverity, string> = { error: '❌ 错误', warning: '⚠️ 警告', info: 'ℹ️ 提示' }
    out.push('')
    out.push(`发现 ${report.issues.length} 个问题:`)
    for (const issue of report.issues) {
      const where = issue.file ? ` [${issue.file}${issue.line ? `:${issue.line}` : ''}]` : ''
      out.push(`- ${label[issue.severity]}(${issue.type})${where}: ${issue.message}`)
    }
  }
  if (report.diffSummary.trim().length > 0) {
    out.push('')
    out.push('--- diff 摘要 ---')
    out.push(report.diffSummary.slice(0, 8000))
  }
  return out.join('\n')
}
