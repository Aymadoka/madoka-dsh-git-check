/** 三个斜杠命令的工作流模板：经 agent.followup 注入给智能体。 */
export const COMMIT_TEMPLATE_ZH = `请按以下流程完成一次本地提交（仅 git commit，不推送）：

1. 调用 git_scan 扫描工作目录的所有变更
2. 按 8 类（源码/配置/文档/测试/样式/资源/构建产物/其他）分析分类结果
3. 调用 git_stage 暂存需要提交的文件（暂存前向我确认文件列表）
4. 调用 pre_commit_check 检查暂存区（冲突标记/调试语句/敏感信息/大文件/TODO/lint）
5. 结合 pre_commit_check 返回的 diff 做代码审查，向我汇报发现的问题
6. 经我确认后，按 Conventional Commits（feat/fix/docs/style/refactor/test/chore）生成中文提交信息，调用 git_commit 完成本地提交

注意：只做本地提交，绝不执行 git push。`

export const COMMIT_TEMPLATE_EN = `Complete a local commit with the following workflow (git commit only, never push):

1. Call git_scan to scan all working tree changes
2. Analyze the classified results (source/config/docs/test/style/asset/build/other)
3. Call git_stage to stage the files to commit (confirm the file list with me first)
4. Call pre_commit_check to check the staged area (conflict markers/debug statements/secrets/large files/TODO/lint)
5. Review the diff returned by pre_commit_check and report any issues to me
6. After my confirmation, generate a Conventional Commits message (feat/fix/docs/style/refactor/test/chore) and call git_commit

Note: commit locally only, never run git push.`

export const GITIGNORE_TEMPLATE = `请按以下流程生成/更新 .gitignore：

1. 调用 gitignore_scan 扫描项目结构，查看当前 .gitignore 状态和建议新增的规则
2. 向我展示建议新增的忽略规则并说明原因，等待我确认
3. 经我确认后，调用 gitignore_write 将完整的 .gitignore 内容写入项目根目录`
