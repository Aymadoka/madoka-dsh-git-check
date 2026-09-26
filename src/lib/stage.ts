import { splitGitLines } from './scanner.js'
import type { CommandRunner } from './seams.js'

export interface StageResult {
  success: boolean
  stagedFiles: string[]
  message: string
}

async function listCachedFiles(runner: CommandRunner, workdir: string): Promise<string[]> {
  try {
    const res = await runner.run(['git', 'diff', '--cached', '--name-only'], { cwd: workdir })
    if (res.exitCode !== 0) return []
    return splitGitLines(res.stdout).map((l) => l.trim()).filter((l) => l.length > 0)
  } catch {
    return []
  }
}

/** 暂存所有变更（git add -A），返回暂存后暂存区文件数。 */
export async function stageAll(runner: CommandRunner, workdir: string): Promise<StageResult> {
  let addRes
  try {
    addRes = await runner.run(['git', 'add', '-A'], { cwd: workdir })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { success: false, stagedFiles: [], message: `git add -A 执行失败: ${reason}` }
  }
  if (addRes.exitCode !== 0) {
    const reason = addRes.stderr.trim() || addRes.stdout.trim() || `exit ${addRes.exitCode}`
    return { success: false, stagedFiles: [], message: `git add -A 失败: ${reason}` }
  }
  const stagedFiles = await listCachedFiles(runner, workdir)
  if (stagedFiles.length === 0) {
    return { success: true, stagedFiles, message: '已执行 git add -A，暂存区为空（可能没有任何变更）。' }
  }
  return { success: true, stagedFiles, message: `已暂存 ${stagedFiles.length} 个文件:\n${stagedFiles.join('\n')}` }
}

/** 逐个暂存指定文件（argv 直传、无 shell 转义问题），部分失败也返回已成功部分。 */
export async function stageFiles(
  runner: CommandRunner,
  workdir: string,
  files: readonly string[],
): Promise<StageResult> {
  if (files.length === 0) {
    return { success: false, stagedFiles: [], message: '未指定要暂存的文件。' }
  }
  const stagedFiles: string[] = []
  const failed: string[] = []
  for (const file of files) {
    let res
    try {
      res = await runner.run(['git', 'add', '--', file], { cwd: workdir })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      failed.push(`${file}: ${reason}`)
      continue
    }
    if (res.exitCode !== 0) {
      const reason = res.stderr.trim() || res.stdout.trim() || `exit ${res.exitCode}`
      failed.push(`${file}: ${reason}`)
      continue
    }
    stagedFiles.push(file)
  }
  if (stagedFiles.length === 0) {
    return { success: false, stagedFiles, message: `暂存失败:\n${failed.join('\n')}` }
  }
  if (failed.length > 0) {
    return {
      success: true,
      stagedFiles,
      message: `已暂存 ${stagedFiles.length} 个文件:\n${stagedFiles.join('\n')}\n\n以下文件暂存失败:\n${failed.join('\n')}`,
    }
  }
  return { success: true, stagedFiles, message: `已暂存 ${stagedFiles.length} 个文件:\n${stagedFiles.join('\n')}` }
}
