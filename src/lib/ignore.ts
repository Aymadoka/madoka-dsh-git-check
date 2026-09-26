import { splitGitLines } from './scanner.js'
import type { CommandRunner, HarnessFs } from './seams.js'

export interface IgnoreSuggestion {
  pattern: string
  reason: string
}

export interface IgnoreScanReport {
  currentIgnore: string | null
  suggestions: IgnoreSuggestion[]
  configFiles: string[]
  trackedFiles: string[]
  dirs: string[]
  files: string[]
}

export interface IgnoreWriteResult {
  success: boolean
  message: string
}

/** 极简 glob：仅支持 `*`（匹配除 `/` 外任意字符），其余按字面匹配。 */
export function matchSimpleGlob(file: string, pattern: string): boolean {
  const regex = new RegExp(
    `^${pattern.split('*').map(escapeRegExp).join('[^/]*')}$`,
  )
  return regex.test(file)
}

function escapeRegExp(s: string): string {
  return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
}

function joinWorkPath(workdir: string, name: string): string {
  return `${workdir.replace(/\/$/, '')}/${name}`
}

function parseIgnorePatterns(content: string): Set<string> {
  const set = new Set<string>()
  for (const line of content.split('\n')) {
    const t = line.trim()
    if (t.length === 0 || t.startsWith('#')) continue
    set.add(t)
  }
  return set
}

/** 扫描项目结构，给出 .gitignore 建议；已存在的规则自动过滤。 */
export async function scanForIgnore(
  runner: CommandRunner,
  fs: HarnessFs,
  workdir: string,
): Promise<IgnoreScanReport> {
  const currentIgnore = await fs.readFileIfPresent(joinWorkPath(workdir, '.gitignore')) ?? null
  const top = await safeTopLevel(fs, workdir)

  let trackedFiles: string[] = []
  try {
    const res = await runner.run(['git', 'ls-files'], { cwd: workdir })
    if (res.exitCode === 0) {
      trackedFiles = splitGitLines(res.stdout).map((l) => l.trim()).filter((l) => l.length > 0)
    }
  } catch {
    trackedFiles = []
  }

  const effective = trackedFiles.length > 0 ? trackedFiles : [...top.files]
  const configFiles = [...effective]
  const existing = currentIgnore !== null ? parseIgnorePatterns(currentIgnore) : new Set<string>()

  const suggestions: IgnoreSuggestion[] = []
  const push = (pattern: string, reason: string): void => {
    if (existing.has(pattern)) return
    // 已有通配能覆盖时也不重复建议
    for (const cur of existing) {
      if (cur.includes('*') && matchSimpleGlob(pattern, cur)) return
    }
    if (suggestions.some((s) => s.pattern === pattern)) return
    suggestions.push({ pattern, reason })
  }

  const dirs = new Set(top.dirs)
  const files = new Set([...top.files, ...trackedFiles.map((f) => f.split('/')[0] ?? '')])
  const hasFile = (name: string): boolean =>
    top.files.includes(name) || trackedFiles.some((f) => f === name || f.endsWith(`/${name}`))

  const isNode = hasFile('package.json')
  const isPython = hasFile('requirements.txt') || hasFile('pyproject.toml') || hasFile('setup.py')
  const isRust = hasFile('Cargo.toml')
  const isGo = hasFile('go.mod')

  if (dirs.has('node_modules') || isNode) push('node_modules/', 'Node.js 依赖目录')
  if (dirs.has('dist')) push('dist/', '构建输出目录')
  else if (dirs.has('build') && (isNode || isPython)) push('build/', '构建输出目录')
  if (dirs.has('.vscode')) push('.vscode/', '编辑器配置')
  if (dirs.has('.idea')) push('.idea/', '编辑器配置')
  if (dirs.has('.next')) push('.next/', 'Next.js 构建输出')
  if (dirs.has('coverage')) push('coverage/', '测试覆盖率输出')
  if (hasFile('tsconfig.json') && dirs.has('dist') === false && isNode) {
    // TS 项目默认构建输出兜底
  }

  if (isPython) {
    if (dirs.has('__pycache__') || true) push('__pycache__/', 'Python 缓存')
    push('*.pyc', 'Python 字节码')
    push('.venv/', 'Python 虚拟环境')
  }
  if (isRust) push('target/', 'Rust 构建输出')
  if (isGo) push('bin/', 'Go 构建输出')

  // 通用系统/编辑器/AI 产物
  if (top.files.some((f) => f === '.DS_Store') || true) {
    push('.DS_Store', 'macOS 系统文件')
  }
  push('*.log', '日志文件')
  if (trackedFiles.some((f) => f.includes('.cursor')) || dirs.has('.cursor')) {
    push('.cursor/', 'AI 工具产物')
  }

  void files
  return {
    currentIgnore,
    suggestions,
    configFiles,
    trackedFiles,
    dirs: [...top.dirs],
    files: [...top.files],
  }
}

async function safeTopLevel(fs: HarnessFs, workdir: string): Promise<{ dirs: string[]; files: string[] }> {
  try {
    return await fs.listTopLevel(workdir)
  } catch {
    return { dirs: [], files: [] }
  }
}

/** 写入 .gitignore（自动补齐末尾换行）。 */
export async function writeGitignore(
  fs: HarnessFs,
  workdir: string,
  content: string,
): Promise<IgnoreWriteResult> {
  const normalized = content.endsWith('\n') ? content : `${content}\n`
  try {
    await fs.writeFile(joinWorkPath(workdir, '.gitignore'), normalized)
    return { success: true, message: '已写入 .gitignore。' }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { success: false, message: `.gitignore 写入失败: ${reason}` }
  }
}

/** 格式化为中文 .gitignore 分析报告。 */
export function formatIgnoreScanReport(report: IgnoreScanReport): string {
  const out: string[] = []
  if (report.currentIgnore === null) {
    out.push('📭 尚未创建 .gitignore')
  } else {
    out.push('📄 当前 .gitignore:')
    out.push('```')
    out.push(report.currentIgnore.trimEnd())
    out.push('```')
  }
  if (report.suggestions.length === 0) {
    out.push('')
    out.push('✅ 未发现需要新增的忽略规则')
  } else {
    out.push('')
    out.push(`建议新增 ${report.suggestions.length} 条规则:`)
    for (const s of report.suggestions) {
      out.push(`- ${s.pattern}（${s.reason}）`)
    }
  }
  return out.join('\n')
}
