# Multi-Agent Orchestrator 发布指南

**版本**: 0.2.0
**最后更新**: 2026-01-30

---

## 📦 发布到 npm

### 前置准备

#### 1. 注册 npm 账号

访问 https://www.npmjs.com/ 注册账号

#### 2. 登录 npm

```bash
npm login
```

输入用户名、密码和邮箱。

#### 3. 验证登录状态

```bash
npm whoami
```

### 发布流程

#### 1. 更新版本号

```bash
# 补丁版本（0.2.0 -> 0.2.1）
npm version patch

# 小版本（0.2.0 -> 0.3.0）
npm version minor

# 大版本（0.2.0 -> 1.0.0）
npm version major
```

#### 2. 构建项目

```bash
# 清理旧的构建
rm -rf dist/

# 重新构建
npm run build

# 验证构建
ls -la dist/
```

#### 3. 测试包

```bash
# 本地测试
npm pack

# 这会生成一个 .tgz 文件
# 在另一个项目中测试安装
npm install /path/to/multi-agent-orchestrator-0.2.0.tgz
```

#### 4. 发布到 npm

```bash
# 发布
npm publish

# 如果是第一次发布，可能需要设置为公开包
npm publish --access public
```

#### 5. 验证发布

```bash
# 查看包信息
npm info multi-agent-orchestrator

# 在新项目中安装测试
npm install multi-agent-orchestrator
```

---

## 🏷️ 版本管理

### 语义化版本

遵循 [Semantic Versioning](https://semver.org/) 规范：

- **主版本号（Major）**: 不兼容的 API 修改
- **次版本号（Minor）**: 向下兼容的功能性新增
- **修订号（Patch）**: 向下兼容的问题修正

### 版本发布流程

#### 1. 创建发布分支

```bash
git checkout -b release/v0.3.0
```

#### 2. 更新版本号和文档

```bash
# 更新 package.json 版本号
npm version minor

# 更新 CHANGELOG.md
nano CHANGELOG.md

# 更新 README.md
nano README.md
```

#### 3. 提交更改

```bash
git add .
git commit -m "chore: release v0.3.0"
```

#### 4. 合并到主分支

```bash
git checkout main
git merge release/v0.3.0
git push origin main
```

#### 5. 创建 Git 标签

```bash
git tag -a v0.3.0 -m "Release v0.3.0"
git push origin v0.3.0
```

#### 6. 发布到 npm

```bash
npm publish
```

---

## 📝 CHANGELOG 管理

### CHANGELOG.md 格式

```markdown
# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- New features that are not yet released

### Changed
- Changes in existing functionality

### Deprecated
- Soon-to-be removed features

### Removed
- Removed features

### Fixed
- Bug fixes

### Security
- Security fixes

## [0.3.0] - 2026-02-01

### Added
- Clawdbot Gateway integration
- Performance monitoring dashboard

### Changed
- Improved task decomposition algorithm
- Updated Telegram Bot message format

### Fixed
- Fixed memory leak in Worker heartbeat
- Fixed race condition in Task Manager

## [0.2.0] - 2026-01-30

### Added
- Telegram Bot integration
- Basic usage examples
- Deployment guide

### Changed
- Updated README with new features

## [0.1.0] - 2026-01-29

### Added
- Initial release
- Core orchestrator and worker implementation
- Claude API integration
- State and task management
- Memory service
```

---

## 🐙 GitHub Release

### 1. 创建 GitHub Release

访问 GitHub 仓库的 Releases 页面，点击 "Create a new release"

### 2. 填写 Release 信息

- **Tag version**: v0.3.0
- **Release title**: Multi-Agent Orchestrator v0.3.0
- **Description**: 从 CHANGELOG.md 复制相关内容

### 3. 上传构建产物（可选）

```bash
# 创建构建产物
npm pack

# 上传 .tgz 文件到 Release
```

### 4. 发布 Release

点击 "Publish release"

---

## 🔄 持续集成/持续部署 (CI/CD)

### GitHub Actions 配置

创建 `.github/workflows/publish.yml`:

```yaml
name: Publish to npm

on:
  push:
    tags:
      - 'v*'

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3

      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '20'
          registry-url: 'https://registry.npmjs.org'

      - name: Install dependencies
        run: npm ci

      - name: Run tests
        run: npm test

      - name: Build
        run: npm run build

      - name: Publish to npm
        run: npm publish --access public
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

### 设置 npm Token

1. 在 npm 网站生成 Access Token
2. 在 GitHub 仓库设置中添加 Secret: `NPM_TOKEN`

---

## 📊 发布检查清单

### 发布前检查

- [ ] 所有测试通过 (`npm test`)
- [ ] 代码已编译 (`npm run build`)
- [ ] 版本号已更新 (`package.json`)
- [ ] CHANGELOG.md 已更新
- [ ] README.md 已更新
- [ ] 文档已更新
- [ ] 依赖已更新到最新稳定版
- [ ] 没有安全漏洞 (`npm audit`)
- [ ] 代码已格式化 (`npm run format`)
- [ ] 代码已通过 lint (`npm run lint`)

### 发布后检查

- [ ] npm 包可以正常安装
- [ ] 包的大小合理（< 10MB）
- [ ] 文档链接正确
- [ ] GitHub Release 已创建
- [ ] Git 标签已推送
- [ ] 通知用户新版本发布

---

## 📈 包优化

### 1. 减小包大小

#### 使用 .npmignore

创建 `.npmignore` 文件：

```
# 源代码
src/
tests/
examples/

# 配置文件
.env
.env.example
tsconfig.json
.eslintrc.js
.prettierrc

# 文档
docs/
*.md
!README.md

# Git
.git/
.gitignore

# CI/CD
.github/

# 其他
node_modules/
coverage/
*.log
```

#### 检查包内容

```bash
# 查看将要发布的文件
npm pack --dry-run

# 查看包大小
npm pack
ls -lh *.tgz
```

### 2. 优化依赖

```bash
# 检查未使用的依赖
npx depcheck

# 更新依赖
npm update

# 检查过时的依赖
npm outdated
```

### 3. Tree Shaking

确保 package.json 中设置：

```json
{
  "sideEffects": false,
  "type": "module"
}
```

---

## 🔐 安全发布

### 1. 启用 2FA

在 npm 账号设置中启用两步验证

### 2. 使用 npm Token

```bash
# 生成只读 Token（用于 CI）
npm token create --read-only

# 生成发布 Token（用于发布）
npm token create
```

### 3. 签名发布

```bash
# 使用 GPG 签名
git tag -s v0.3.0 -m "Release v0.3.0"
```

---

## 📞 发布后支持

### 1. 监控下载量

访问 https://www.npmjs.com/package/multi-agent-orchestrator

### 2. 处理 Issues

及时回复 GitHub Issues 和 npm 上的问题

### 3. 收集反馈

- 监控 GitHub Issues
- 查看 npm 下载统计
- 收集用户反馈

### 4. 计划下一个版本

根据反馈和需求规划下一个版本的功能

---

## 🎯 发布策略

### 发布频率

- **补丁版本**: 每 1-2 周（bug 修复）
- **小版本**: 每 1-2 月（新功能）
- **大版本**: 每 6-12 月（重大更新）

### 版本支持

- **当前版本**: 完全支持
- **前一个大版本**: 安全更新
- **更早版本**: 不再支持

---

**文档版本**: 1.0
**最后更新**: 2026-01-30
