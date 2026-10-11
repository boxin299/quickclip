# GitHub Releases 更新配置

QuickClip 的更新检查读取 GitHub Releases。应用本地后端会请求：

```text
https://api.github.com/repos/<owner>/<repo>/releases/latest
```

## 创建仓库

1. 在 GitHub 创建公开仓库，例如 `quickclip`。
2. 记录仓库标识，格式是 `owner/repo`，例如：

```text
boxin299/quickclip
```

3. 将仓库标识写入发布配置：

```python
# backend/app/release_config.py
GITHUB_UPDATE_REPO = "boxin299/quickclip"
```

4. 本地临时测试时也可以用环境变量覆盖：

```bash
export QUICKCLIP_GITHUB_REPO=boxin299/quickclip
```

打包后的应用会优先使用 `release_config.py` 中的仓库地址；环境变量只用于本机调试或临时切换更新源。

## 创建 Release

1. 在仓库页面打开 `Releases`。
2. 点击 `Draft a new release`。
3. Tag 使用 `v` 前缀，例如：

```text
v1.0.2
```

4. 上传 macOS 安装包资产，建议命名：

```text
QuickClip-1.0.2-arm64.dmg
```

5. Release notes 会作为更新日志显示在应用里。

## 资产匹配规则

当前 macOS Apple Silicon 会优先匹配同时包含以下关键词的资产：

```text
.dmg
arm64 或 aarch64
```

如果没有匹配资产，应用会打开该 Release 页面。
