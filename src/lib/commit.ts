import type { CommandRunner } from './seams.js'

export interface CommitResult {
  success: boolean
  commitHash?: string
  message: string
}

/** 仅本地 git commit（绝不推送），成功时提取短哈希。 */
export async function executeCommit(
  runner: CommandRunner,
  workdir: string,
  message: string,
): Promise<CommitResult> {
  if (message.trim().length === 0) {
    return { success: false, message: '提交信息为空，已拒绝提交。' }
  }
  let res
  try {
    res = await runner.run(['git', 'commit', '-m', message], { cwd: workdir })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { success: false, message: `git commit 执行失败: ${reason}` }
  }
  if (res.exitCode !== 0) {
    const reason = res.stderr.trim() || res.stdout.trim() || `exit ${res.exitCode}`
    return { success: false, message: `git commit 失败:\n${reason}` }
  }
  const combined = `${res.stdout}\n${res.stderr}`
  const hash = extractHash(combined)
  return {
    success: true,
    ...(hash ? { commitHash: hash } : {}),
    message: res.stdout.trim() || '提交成功。',
  }
}

function extractHash(output: string): string | undefined {
  const m = output.match(/\[[^\]]*\s([0-9a-f]{4,40})\]/i)
  return m?.[1]
}
