import type { CommandResult, CommandRunner, HarnessFs } from '../src/lib/seams.js'

/** 记录 argv 调用的内存 git runner。 */
export class FakeRunner implements CommandRunner {
  workdir = '/repo'
  calls: string[][] = []
  private handlers = new Map<string, CommandResult | ((argv: string[]) => CommandResult)>()
  private fallback?: (argv: string[]) => CommandResult

  on(firstArg: string, result: CommandResult | ((argv: string[]) => CommandResult)): this {
    this.handlers.set(firstArg, result)
    return this
  }

  onFallback(handler: (argv: string[]) => CommandResult): this {
    this.fallback = handler
    return this
  }

  async run(argv: readonly string[], _options?: { cwd?: string }): Promise<CommandResult> {
    this.calls.push([...argv])
    const key = argv[1] ?? ''
    const handler = this.handlers.get(key) ?? this.fallback
    if (handler === undefined) {
      throw new Error(`unexpected git call: ${argv.join(' ')}`)
    }
    return typeof handler === 'function' ? handler([...argv]) : handler
  }
}

export function ok(stdout = ''): CommandResult {
  return { exitCode: 0, signal: null, stdout, stderr: '' }
}

export function fail(stderr = 'error'): CommandResult {
  return { exitCode: 1, signal: null, stdout: '', stderr }
}

/** 内存文件系统。 */
export class FakeFs implements HarnessFs {
  files = new Map<string, string>()
  dirs: string[] = []
  topFiles: string[] = []
  written: { path: string; content: string }[] = []

  async readFileIfPresent(absPath: string): Promise<string | undefined> {
    return this.files.get(absPath)
  }

  async listTopLevel(_absPath: string): Promise<{ dirs: string[]; files: string[] }> {
    return { dirs: [...this.dirs], files: [...this.topFiles] }
  }

  async writeFile(absPath: string, content: string): Promise<void> {
    this.written.push({ path: absPath, content })
    this.files.set(absPath, content)
  }
}
