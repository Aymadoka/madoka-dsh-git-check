import { isAbsolute, resolve } from 'node:path'

/** 子进程单次执行结果：非零退出是正常返回值，仅无法启动/取消/超时才抛错。 */
export interface CommandResult {
  exitCode: number | null
  signal: string | null
  stdout: string
  stderr: string
}

/** Harness 无关的命令执行接缝：argv 直传、无 shell 层。 */
export interface CommandRunner {
  workdir: string
  run: (argv: readonly string[], options?: { cwd?: string }) => Promise<CommandResult>
}

/** Harness 无关的文件系统接缝：仅经 ctx.fs 适配实现。 */
export interface HarnessFs {
  readFileIfPresent: (absPath: string) => Promise<string | undefined>
  listTopLevel: (absPath: string) => Promise<{ dirs: string[]; files: string[] }>
  writeFile: (absPath: string, content: string) => Promise<void>
}

interface SessionHeader {
  cwd?: unknown
}

interface ExecLike {
  agent?: {
    session?: {
      header?: SessionHeader
    }
  } | null
}

/** 解析工作目录：显式 workdir 优先（相对路径相对会话 cwd），否则会话 cwd，否则 process.cwd()。 */
export function resolveWorkdir(workdir: unknown, exec: unknown): string {
  const sessionCwd = extractSessionCwd(exec) ?? process.cwd()
  if (typeof workdir === 'string' && workdir.length > 0) {
    if (isAbsolute(workdir)) return workdir
    return resolve(sessionCwd, workdir)
  }
  return sessionCwd
}

function extractSessionCwd(exec: unknown): string | undefined {
  if (typeof exec !== 'object' || exec === null) return undefined
  const agent = (exec as ExecLike).agent
  if (typeof agent !== 'object' || agent === null) return undefined
  const session = agent.session
  if (typeof session !== 'object' || session === null) return undefined
  const header = session.header
  if (typeof header !== 'object' || header === null) return undefined
  const cwd = (header as SessionHeader).cwd
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined
}
