import type { CommandResult, CommandRunner } from './seams.js'

export type FileCategory =
  | 'source'
  | 'config'
  | 'docs'
  | 'test'
  | 'style'
  | 'asset'
  | 'build'
  | 'other'

export type FileStatus =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'untracked'
  | 'ignored'
  | 'typechanged'
  | 'unmerged'

export interface FileEntry {
  file: string
  status: FileStatus
  category: FileCategory
  additions?: number
  deletions?: number
  oldFile?: string
  staged?: boolean
}

export interface ScanReport {
  categories: Record<FileCategory, FileEntry[]>
  allFiles: FileEntry[]
  stagedFiles: string[]
  branch: string
  unpushedCommits: number
}

const CATEGORY_ORDER: FileCategory[] = [
  'source',
  'config',
  'docs',
  'test',
  'style',
  'asset',
  'build',
  'other',
]

const CATEGORY_LABEL: Record<FileCategory, string> = {
  source: '📦 源码',
  config: '⚙️ 配置',
  docs: '📄 文档',
  test: '🧪 测试',
  style: '🎨 样式',
  asset: '🖼️ 资源',
  build: '🏗️ 构建产物',
  other: '📁 其他',
}

const SOURCE_EXTS = new Set([
  'ts', 'mts', 'cts', 'tsx', 'js', 'mjs', 'cjs', 'jsx',
  'vue', 'svelte', 'py', 'go', 'rs', 'java', 'kt', 'kts',
  'c', 'h', 'cc', 'cpp', 'hpp', 'cxx', 'cs', 'rb', 'php',
  'swift', 'scala', 'lua', 'sh', 'ps1', 'sql', 'r', 'dart',
])

const STYLE_EXTS = new Set(['css', 'scss', 'sass', 'less', 'styl', 'stylus'])

const ASSET_EXTS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp', 'avif',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'mp4', 'webm', 'mp3', 'wav', 'ogg', 'pdf', 'zip', 'tar',
])

const DOC_EXTS = new Set(['md', 'markdown', 'txt', 'rst', 'adoc'])

const DOC_BASENAMES = new Set([
  'readme', 'license', 'licence', 'changelog', 'authors', 'contributing', 'notice', 'codeowners',
])

/** 按 8 类归类：test > build > config > style > asset > docs > source > other。 */
export function classifyFile(filePath: string): FileCategory {
  const normalized = filePath.replace(/\\/g, '/')
  const segments = normalized.split('/')
  const basename = segments[segments.length - 1] ?? ''
  const lowerBase = basename.toLowerCase()
  const dot = lowerBase.lastIndexOf('.')
  const ext = dot >= 0 ? lowerBase.slice(dot + 1) : ''

  // 测试：__tests__/ 目录或 *.test.* / *.spec.*
  if (segments.some((s) => s === '__tests__')) return 'test'
  if (lowerBase.includes('.test.') || lowerBase.includes('.spec.')) return 'test'

  // 构建产物目录
  const first = segments[0] ?? ''
  if (
    first === 'dist' || first === 'build' || first === 'out' ||
    first === 'coverage' || first === '.next' || first === '.nuxt' ||
    first === 'target' || segments.includes('.next')
  ) {
    return 'build'
  }

  // 配置
  if (
    lowerBase === 'package.json' || lowerBase === 'package-lock.json' ||
    lowerBase === 'pnpm-lock.yaml' || lowerBase === 'yarn.lock' ||
    lowerBase === 'dockerfile' || lowerBase.startsWith('docker-compose') ||
    lowerBase === 'makefile' || lowerBase === '.gitignore' ||
    lowerBase === '.gitattributes' || lowerBase === '.editorconfig' ||
    lowerBase.startsWith('.env') ||
    lowerBase.startsWith('tsconfig') || lowerBase.startsWith('jsconfig') ||
    lowerBase.endsWith('.config.js') || lowerBase.endsWith('.config.ts') ||
    lowerBase.endsWith('.config.mjs') || lowerBase.endsWith('.config.cjs') ||
    lowerBase.endsWith('.config.mts') || lowerBase.endsWith('.config.cts') ||
    ext === 'toml' || ext === 'ini' ||
    lowerBase.startsWith('.eslintrc') || lowerBase === '.prettierrc' ||
    lowerBase === '.prettierignore'
  ) {
    return 'config'
  }
  if ((ext === 'yml' || ext === 'yaml') && (normalized.includes('.github/') || segments.includes('.vscode'))) {
    return 'config'
  }

  if (STYLE_EXTS.has(ext)) return 'style'
  if (ASSET_EXTS.has(ext)) return 'asset'

  // 文档
  if (DOC_EXTS.has(ext)) return 'docs'
  const baseNoExt = dot >= 0 ? lowerBase.slice(0, dot) : lowerBase
  if (DOC_BASENAMES.has(lowerBase) || DOC_BASENAMES.has(baseNoExt)) return 'docs'
  if (first === 'docs') return 'docs'

  if (SOURCE_EXTS.has(ext)) return 'source'
  if (lowerBase === 'dockerfile') return 'config'
  return 'other'
}

/**
 * 切分 git 输出行：逐行处理、保留行首空格（porcelain 行首空格本身就是状态位）、兼容 CRLF。
 * 不能对整串输出做 trim() 再切分，否则会把 ` M a.ts` 误解析为 `.ts`。
 */
export function splitGitLines(output: string): string[] {
  return output
    .split('\n')
    .map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
    .filter((line) => line.length > 0)
}

function parsePorcelainLine(line: string): { file: string; status: FileStatus; staged: boolean; oldFile?: string } | undefined {
  if (line.length < 4) return undefined
  const xy = line.slice(0, 2)
  const pathPart = line.slice(3)
  if (pathPart.length === 0) return undefined

  let file = pathPart
  let oldFile: string | undefined
  const arrow = pathPart.indexOf(' -> ')
  if (arrow >= 0) {
    oldFile = pathPart.slice(0, arrow)
    file = pathPart.slice(arrow + 4)
  }
  file = stripQuotes(file)
  if (oldFile !== undefined) oldFile = stripQuotes(oldFile)

  const x = xy[0] ?? ' '
  const y = xy[1] ?? ' '

  let status: FileStatus
  if (xy === '??') status = 'untracked'
  else if (xy === '!!') status = 'ignored'
  else if (x === 'R' || y === 'R' || oldFile !== undefined) status = 'renamed'
  else if (x === 'C' || y === 'C') status = 'copied'
  else if (x === 'A' || y === 'A') status = 'added'
  else if (x === 'D' || y === 'D') status = 'deleted'
  else if (x === 'U' || y === 'U') status = 'unmerged'
  else if (x === 'T' || y === 'T') status = 'typechanged'
  else if (x === 'M' || y === 'M') status = 'modified'
  else status = 'modified'

  const staged = x !== ' ' && x !== '?' && x !== '!'
  return oldFile === undefined ? { file, status, staged } : { file, status, staged, oldFile }
}

function stripQuotes(p: string): string {
  if (p.length >= 2 && p.startsWith('"') && p.endsWith('"')) return p.slice(1, -1)
  return p
}

function parseNumstat(output: string): Map<string, { additions: number; deletions: number }> {
  const result = new Map<string, { additions: number; deletions: number }>()
  for (const line of splitGitLines(output)) {
    const parts = line.split('\t')
    if (parts.length < 3) continue
    const addRaw = parts[0] ?? ''
    const delRaw = parts[1] ?? ''
    let file = parts.slice(2).join('\t')
    const arrow = file.lastIndexOf(' => ')
    if (arrow >= 0) file = file.slice(arrow + 4)
    file = file.replace(/^\{|\}$/g, '').trim()
    if (file.length === 0) continue
    const additions = addRaw === '-' ? 0 : (Number.parseInt(addRaw, 10) || 0)
    const deletions = delRaw === '-' ? 0 : (Number.parseInt(delRaw, 10) || 0)
    const prev = result.get(file)
    if (prev) {
      result.set(file, { additions: prev.additions + additions, deletions: prev.deletions + deletions })
    } else {
      result.set(file, { additions, deletions })
    }
  }
  return result
}

async function safeRun(runner: CommandRunner, argv: readonly string[], cwd: string): Promise<CommandResult | undefined> {
  try {
    return await runner.run(argv, { cwd })
  } catch {
    return undefined
  }
}

/** 扫描工作目录：status + branch + 两路 numstat + 未推送计数，全部容错。 */
export async function scanWorkingTree(runner: CommandRunner, workdir: string): Promise<ScanReport> {
  const statusRes = await safeRun(runner, ['git', 'status', '--porcelain'], workdir)
  const branchRes = await safeRun(runner, ['git', 'branch', '--show-current'], workdir)
  const cachedRes = await safeRun(runner, ['git', 'diff', '--cached', '--numstat'], workdir)
  const unstagedRes = await safeRun(runner, ['git', 'diff', '--numstat'], workdir)
  const revRes = await safeRun(runner, ['git', 'rev-list', '--count', '@{u}..HEAD'], workdir)

  const branch = branchRes !== undefined && branchRes.exitCode === 0
    ? (branchRes.stdout.split('\n')[0]?.trim() || 'HEAD')
    : 'HEAD'

  let unpushedCommits = 0
  if (revRes !== undefined && revRes.exitCode === 0) {
    const n = Number.parseInt(revRes.stdout.trim(), 10)
    unpushedCommits = Number.isFinite(n) && n >= 0 ? n : 0
  }

  const stats = new Map<string, { additions: number; deletions: number }>()
  for (const res of [cachedRes, unstagedRes]) {
    if (res === undefined || res.exitCode !== 0) continue
    for (const [file, v] of parseNumstat(res.stdout)) {
      const prev = stats.get(file)
      if (prev) stats.set(file, { additions: prev.additions + v.additions, deletions: prev.deletions + v.deletions })
      else stats.set(file, { ...v })
    }
  }

  const allFiles: FileEntry[] = []
  if (statusRes !== undefined && statusRes.exitCode === 0) {
    for (const line of splitGitLines(statusRes.stdout)) {
      const parsed = parsePorcelainLine(line)
      if (!parsed) continue
      const stat = stats.get(parsed.file)
      allFiles.push({
        file: parsed.file,
        status: parsed.status,
        category: classifyFile(parsed.file),
        ...(stat ? { additions: stat.additions, deletions: stat.deletions } : {}),
        ...(parsed.oldFile ? { oldFile: parsed.oldFile } : {}),
        staged: parsed.staged,
      })
    }
  }

  const categories = emptyCategories()
  for (const entry of allFiles) {
    categories[entry.category].push(entry)
  }

  const stagedFiles = allFiles.filter((f) => f.staged).map((f) => f.file)
  return { categories, allFiles, stagedFiles, branch, unpushedCommits }
}

function emptyCategories(): Record<FileCategory, FileEntry[]> {
  return { source: [], config: [], docs: [], test: [], style: [], asset: [], build: [], other: [] }
}

const STATUS_LABEL: Record<FileStatus, string> = {
  modified: '修改',
  added: '新增',
  deleted: '删除',
  renamed: '重命名',
  copied: '复制',
  untracked: '未追踪',
  ignored: '已忽略',
  typechanged: '类型变更',
  unmerged: '未合并',
}

/** 格式化为中文结构化报告，供 AI 分析决策。 */
export function formatScanReport(report: ScanReport): string {
  const out: string[] = []
  out.push(`🌿 分支: ${report.branch}`)
  out.push(`**未推送提交**: ${report.unpushedCommits} 个`)
  if (report.allFiles.length === 0) {
    out.push('')
    out.push('✨ 工作区干净，没有任何变更')
    return out.join('\n')
  }

  let totalAdd = 0
  let totalDel = 0
  for (const f of report.allFiles) {
    totalAdd += f.additions ?? 0
    totalDel += f.deletions ?? 0
  }
  out.push(`**总计**: +${totalAdd}/-${totalDel} 行`)
  out.push(`共 ${report.allFiles.length} 个变更文件，已暂存 ${report.stagedFiles.length} 个`)
  out.push('')

  for (const cat of CATEGORY_ORDER) {
    const files = report.categories[cat]
    if (files.length === 0) continue
    out.push(`## ${CATEGORY_LABEL[cat]}（${files.length}）`)
    for (const f of files) {
      const stat = f.additions !== undefined || f.deletions !== undefined
        ? ` (+${f.additions ?? 0}/-${f.deletions ?? 0})`
        : ''
      const staged = f.staged === true || report.stagedFiles.includes(f.file) ? ' ✅已暂存' : ''
      const rename = f.oldFile ? `（原 ${f.oldFile}）` : ''
      out.push(`- ${f.file}${rename} [${STATUS_LABEL[f.status] ?? f.status}]${stat}${staged}`)
    }
    out.push('')
  }
  return out.join('\n').trimEnd()
}
