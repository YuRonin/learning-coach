# 发布与隐私说明

## 公开前先确认

1. 建立一个公开 GitHub 仓库，仓库根目录放置 `README.md`、`LICENSE`、`manifest.json`、`main.js` 和 `styles.css`，同时保留源码和 `package-lock.json`。
2. 不要把个人笔记库作为仓库目录，也不要把笔记库里的 `.obsidian/plugins/learning-coach/data.json` 或 `data.backup.json` 复制进仓库。
3. 在项目目录运行 `npm ci`、`npm test`、`npm run build`、`npm run smoke` 和 `npm run release:check`。
4. 检查 `git status` 与 `git diff --cached`，确认没有真实密钥、真实服务地址、个人笔记、截图或测试库输出。测试代码里的 `test-secret`、`fixture-key` 是虚构值，不要替换成真实值。

## 创建第一个社区版本

Obsidian 官方要求版本使用三段式语义版本号，例如 `0.4.0`。把 `manifest.json` 中的版本更新后，提交并推送到仓库默认分支，再在 GitHub 创建同名 tag 和 Release。Release 必须以单独附件上传：

- `main.js`
- `manifest.json`
- `styles.css`

压缩包可以作为额外下载附件，但不能只上传源码压缩包或只上传本项目生成的 ZIP。Obsidian 会从与 `manifest.json` 版本完全相同的 Release 中下载上述文件。

然后登录 `community.obsidian.md`，绑定 GitHub 账号，在社区目录添加插件。目录会读取默认分支的 `manifest.json`，使用名称、作者和描述提供搜索；审核通过后，用户可以从 Obsidian 的第三方插件页面搜索 “Learning Coach”。插件界面仍使用中文名称“学习教练”。后续版本只需要更新默认分支的 manifest、创建新版本 Release，不需要重复提交初始申请。

## 当前密钥为什么不会随插件发布

- 当前使用的密钥和自定义服务地址只存在于你个人笔记库的插件数据文件中，不在项目源码中。
- `.gitignore` 忽略了 `data.json` 和 `data.backup.json`。
- `scripts/package.mjs` 明确只把三个运行文件放进安装包。
- 公共构建文件中的服务地址只是默认值 `https://api.openai.com/v1`，不会读取你的本机配置。
- 插件没有把访问密钥写入学习记录、导出 Markdown、错误提示或请求日志。

这能避免“正常发布流程”泄漏当前配置，但不能保护你主动提交到 GitHub 的内容。若真实密钥曾经被提交、上传到 Release、发在 issue，或出现在截图中，应先撤销该密钥，再发布插件。

## 社区页面应写清楚的隐私行为

README 应明确说明：用户自己填写模型服务；笔记片段和回答会发送到用户配置的服务商；密钥保存在本地插件数据中且未加密；插件不会自动读取整个库。不要在 README、演示截图或示例配置中放入可用密钥。

参考：

- [Obsidian：提交插件](https://docs.obsidian.md/plugins/releasing/submit-plugin)
- [Obsidian：插件提交要求](https://docs.obsidian.md/community-directory/submission-requirements-for-plugins)
- [Obsidian Releases：社区插件如何发布和下载](https://github.com/obsidianmd/obsidian-releases/blob/master/README.md)
