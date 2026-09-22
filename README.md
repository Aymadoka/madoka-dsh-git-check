# madoka-dsh-git-check

> DSH 插件 — 一键扫描、分类、审查并提交代码

为 DSH（含 DSH-Desktop）提供完整的 Git 工作流能力：扫描工作目录、智能分类、
预提交质量检查、暂存/提交、以及 `.gitignore` 智能生成。

## 功能

- **智能分类**：按 8 类自动归类变更文件（源码、配置、文档、测试、样式、资源、构建产物、其他），标注状态与增删行统计
- **预提交检查**：检测冲突标记、调试语句、敏感信息、大文件、TODO 标记，并自动运行项目 lint
- **沙箱合规**：git 调用走 `ctx.subprocess`（argv 直传、无 shell 层），文件读写走 `ctx.fs`（沙箱裁决 + 读写观测），Windows / macOS / Linux 通用
- **仅本地提交**：`git_commit` 只做 `git commit`，绝不推送
- **UTF-8**：全量 UTF-8 编码，中文提交信息无乱码

## 工具

| 工具 | 说明 |
|------|------|
| `git_scan` | 扫描工作目录所有变更并按 8 类自动分类 |
| `git_stage` | `git add` 全部或指定文件 |
| `pre_commit_check` | 检查暂存区（冲突/调试/敏感信息/TODO/大文件/lint）+ 返回 diff |
| `git_commit` | `git commit -m` 仅本地提交，不推送 |
| `gitignore_scan` | 扫描项目结构，给出 `.gitignore` 建议 |
| `gitignore_write` | 写入 `.gitignore` |

所有工具都接受可选的 `workdir` 参数（默认为会话工作区，相对路径相对其解析；
与 `bash` 工具的语义一致）。

## 命令

| 命令 | 说明 |
|------|------|
| `/commit` | 中文提交流程（扫描 → 分类 → 暂存 → 检查 → 审查 → 提交） |
| `/commit-en` | 英文提交流程 |
| `/gitignore` | 生成 `.gitignore` 流程 |

## 安装

### 发布后（npm）

```bash
dsh plugin add madoka-dsh-git-check
```

在 DSH-Desktop 中，也可以通过桌面端的插件管理界面安装（待插件市场收录）。

### 本地开发 / 调试

```bash
npm install
npm run build      # 输出 lib/
npm run typecheck  # 类型检查（含测试）
npm run test       # 编译测试并用 node:test 运行
npm run check      # build + typecheck + test
```

构建产物为标准 Cordis/DSH 插件（入口 `lib/index.js`，组合声明见
`cordis.patch.yml`），将其目录加入目标 profile 的插件列表即可加载。
准确的本地安装语法以所用版本的 `dsh plugin --help` 为准。

## 项目结构

```
src/
  index.ts          # 插件入口：export name/inject/apply，注册 6 tools + 3 commands
  lib/
    seams.ts        # Harness 无关接缝：CommandRunner / HarnessFs / resolveWorkdir
    scanner.ts      # git_scan 逻辑 + 分类/格式化（含 splitGitLines）
    checks.ts       # pre_commit_check 逻辑
    stage.ts        # git_stage
    commit.ts       # git_commit
    ignore.ts       # gitignore_scan/write
    templates.ts    # 三个斜杠命令的工作流模板
tests/
  helpers.ts        # 内存 FakeRunner / FakeFs
  scanner.test.ts
  checks.test.ts
  stage-commit.test.ts
  ignore.test.ts
```

`src/lib` 不依赖任何 DSH service（只依赖 `seams.ts` 定义的窄接口），
因此全部逻辑都可以用内存替身做单元测试；`src/index.ts` 是唯一的
Harness 接线层（`ctx.tools` / `ctx.commands` / `ctx.subprocess` / `ctx.fs`）。

## 实现说明

- **插件协议**：标准 Cordis 插件（`export name/inject/apply`），经
  `ctx.tools.register(defineTool(...))` 注册 6 个工具，
  经 `ctx.commands.register(...)` 注册 3 个人类命令
- **命令触发**：`/commit`、`/commit-en`、`/gitignore` 触发时经
  `agent.followup` 向智能体注入工作流（模板见 `src/lib/templates.ts`）；
  DSH 命令名只允许 `^[a-z][a-z0-9_-]*$`，英文提交流程对应 `/commit-en`
- **进程执行**：`ctx.subprocess.spawn`，argv 数组直传、无 shell 层，
  无转义问题，原生跨平台（Windows / macOS / Linux）
- **文件读写**：`ctx.fs`（走沙箱裁决、`fs/write-intent` / `fs/edit-intent`
  waterfall 与 `fs/observed` 观测）
- **工作目录**：会话 cwd（`exec.agent.session.header.cwd`）+ 可选 `workdir` 参数
- **porcelain 解析**：`git status --porcelain` 的行首空格本身就是状态位
  （` M file` 表示未暂存的修改），因此不能对整串输出做 `trim()` 再切分
  （会把 ` M a.ts` 误解析为 `.ts`）；`splitGitLines`
  （见 `src/lib/scanner.ts`）逐行处理、保留行首空格、兼容 CRLF
- **测试**：`node:test` 单元测试 60 用例（`npm run test`）
- **构建**：`tsc` → `lib/`（DSH 包约定）+ `cordis.patch.yml` 组合声明

## 协议

MIT
