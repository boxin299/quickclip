# QuickClip

QuickClip 是面向 **DaVinci Resolve** 的文本驱动剪辑与效率工具。它把本地转录、文本粗剪、字幕编辑、时间线检查、审阅意见同步和素材整理放进一个桌面工作台，让剪辑师围绕文本完成更多日常操作。

桌面界面使用 React + Tauri，后端使用 Python + FastAPI，语音识别使用 faster-whisper；说话人分离使用 sherpa-onnx。

> 当前仓库是从网盘备份整理的桌面应用源码，主要面向 macOS。完整构建和功能验证尚未完成；Windows 版本尚未验证。下列安装步骤对应当前源码与脚本，已知限制见文末。

## 可以做什么

| 功能 | 用途 |
| --- | --- |
| 音频转录 | 将本地媒体或时间线音频转换为带时间戳的文本 |
| 文本驱动剪辑 | 选择句子或词语，生成剪辑时间线 |
| 字幕处理 | 编辑字幕、调整对齐、导出 SRT 并插入达芬奇时间线 |
| 时间线检查 | 检查夹帧、黑帧和黑边等问题 |
| 同步审阅 | 拉取阅流评论，并写入时间线标记；需要自行配置阅流凭证 |
| 文件层级管理 | 整理达芬奇媒体池与项目文件夹 |
| 素材打包与导出 | 收集时间线引用的素材，辅助归档、交接和渲染导出 |
| 剪贴导入 | 将剪贴板图片保存到项目并导入媒体池 |
| 音效库 | 索引、试听、分类和插入本地音效 |

转录在本机执行；下载依赖、模型、检查更新及阅流等外部集成功能仍需要网络连接。与达芬奇交互的操作需要达芬奇已启动，并允许脚本访问。

## 源码、模型和安装包的区别

本次整理后的源码约 19 MB，压缩后约 16 MB。源码仓库不包含 Python 虚拟环境、依赖缓存、编译产物、模型权重、数据库、登录会话或个人媒体记录，也不包含宣传网站 `web/`。

安装包还会包含便携 Python、后端依赖和编译后的程序，因此即使源码只有几十 MB，安装包仍可能达到 GB 级别。语音模型需要另外下载；当前源码中的 Whisper small 模型下载量标注约 927 MB，说话人分离模型还会占用额外空间。具体大小以实际下载和构建结果为准。

本仓库没有随此次迁移发布旧安装包。后续若提供安装包，请从本仓库的 [Releases](https://github.com/boxin299/quickclip/releases) 获取，勿将源码 ZIP 当作可直接双击安装的软件。

## 开发环境

| 环境 | 说明 |
| --- | --- |
| macOS | 当前脚本和达芬奇脚本路径主要按 macOS 编写 |
| Python | 使用 Python 3.10 或更高版本创建开发环境；依赖安装兼容性仍需实际验证 |
| Node.js / npm | 当前锁文件中的工具依赖要求 Node.js 20.x ≥ 20.19.0、22.x ≥ 22.13.0，或 ≥ 24.0.0；Node.js 18 不适用 |
| Rust / Cargo | 编译 Tauri 桌面程序所需；项目声明的 Rust 最低版本为 1.77.2 |
| Xcode Command Line Tools | macOS 桌面开发所需，可执行 `xcode-select --install` 安装 |
| DaVinci Resolve | 时间线和媒体池等功能需要可用的 Resolve Python 脚本接口 |

Tauri 的系统依赖与 Rust 安装方式见 [官方环境配置说明](https://v2.tauri.app/start/prerequisites/)；本项目使用 Tauri 2。

当前发布打包脚本下载的是 **Apple Silicon（arm64）** 的便携 Python。Intel Mac、Windows 和 Linux 的打包流程不能直接按已验证的平台使用，需先适配并验证。

## 快速开始：桌面开发模式

### 1. 获取源码

在源码迁移拉取请求合并前，使用迁移分支：

```bash
git clone --branch codex/quark-source-import https://github.com/boxin299/quickclip.git
cd quickclip
```

合并后可以使用仓库默认分支。

### 2. 安装 Python 和前端依赖

以下命令在项目根目录执行：

```bash
python3 -m venv backend/.venv
backend/.venv/bin/python -m pip install --upgrade pip
backend/.venv/bin/python -m pip install -r backend/requirements.txt

cd frontend
npm ci
cd ..
```

Python 依赖包含 torch、torchaudio 等较大的包，安装耗时和占用空间明显高于源码本身。前端依赖安装在 `frontend/`，根目录的 `package.json` 不是桌面应用的依赖入口。

### 3. 启动达芬奇，再启动 QuickClip

先打开 DaVinci Resolve，并打开要操作的项目与时间线。需要真实联动时，确认达芬奇偏好设置允许外部脚本访问；不同版本的选项名称和可用范围以该版本自带的脚本文档为准。

然后在项目根目录执行：

```bash
./start-app.command
```

也可在 Finder 中双击该文件，但 Finder 的环境变量与终端可能不同；遇到找不到 Node.js、Python 或配置变量时，优先从终端启动。

启动入口会进入 `frontend/` 并执行 `npm run tauri dev`。后端默认从 `127.0.0.1:18000` 起寻找可用端口；桌面界面会发现实际端口。Vite 开发服务默认端口为 `3000`。

### 4. 安装转录模型

在软件的转录环境 / 模型安装界面完成依赖检查和模型下载后，再进行真实转录。缺少模型时可能显示安装提示或失败信息，不应把示例数据或未完成的转录当作真实识别结果。

开发环境的模型通常保存到：

- `backend/data/whisper_models/`：Whisper 模型。
- `backend/data/sherpa_onnx/`：说话人分离模型。

打包后的应用会寻找可写的用户数据目录；macOS 首选 `~/.quickclip/`，并有缓存目录等回退路径。启动脚本设置的 `MODELSCOPE_CACHE` 与上述模型文件目录不是同一个概念。

## 手动启动：界面和 API 调试

需要分别查看前后端日志时，可以使用两个终端。此模式适合浏览器界面和接口调试；文件系统、原生拖拽等 Tauri 能力仍需桌面模式。切换模式前，先停止原有开发进程。

**终端一：在项目根目录启动后端。**

```bash
backend/.venv/bin/python -m uvicorn main:app --app-dir backend/app --host 127.0.0.1 --port 18000
```

**终端二：启动前端。**

```bash
cd frontend
VITE_API_BASE_URL=http://127.0.0.1:18000 npm run dev -- --host 127.0.0.1 --port 3000
```

- 界面：<http://127.0.0.1:3000>
- 后端状态：<http://127.0.0.1:18000/api/status>
- API 文档：<http://127.0.0.1:18000/docs>

如果使用其他后端端口，请同步修改前端的 `VITE_API_BASE_URL`。直接运行 `python3 backend/app/main.py` 时，后端会根据 `APP_BACKEND_PORT` 或可用端口选择结果启动，不能假定它固定为 `8000`。

## 本地配置与凭证

本次开源整理已移除启动脚本中的管理员密码哈希、JWT 密钥及阅流应用密钥，并排除了保存账户、会话和私人配置的运行数据文件。

[.env.example](.env.example) 只说明可能使用的变量，不会被启动脚本自动加载，也不表示每个变量都是桌面功能的必填项。请在实际启动进程的环境中配置所需变量，勿把真实密钥写回源码、测试、文档或提交记录。

| 变量 | 用途 |
| --- | --- |
| `APP_BACKEND_PORT` | 后端端口；根目录启动脚本会明确设置为 `18000`，开发脚本可自动寻找空闲端口 |
| `VITE_API_BASE_URL` | 前端连接的后端地址；开发启动脚本会注入实际地址 |
| `YUE_LIU_APP_SECRET` | 阅流评论接口使用的应用密钥；未配置时该接口返回配置提示 |
| `QC_BACKEND_URL` | 命令行工具连接的后端地址，需与实际端口一致 |
| `QC_API_KEY` | 命令行工具可携带的 API 密钥；按目标接口实际要求配置 |
| `COS_SECRET_ID` / `COS_SECRET_KEY` | 可选的对象存储发布工具凭证，本地剪辑无需配置 |

其他历史管理或集成变量见示例文件与对应工具源码。核心本地开发流程无需在启动脚本中补回旧账号或旧 JWT 密钥。不要将示例文件里的空值当作已经可用的服务配置。

曾在旧备份中出现的真实凭证应在对应服务撤销或轮换；删除源码中的凭证不会使旧凭证失效。

## 构建与打包

完成上面的环境和依赖准备后，在 `frontend/` 执行：

```bash
npm run tauri build
```

当前配置会依次准备后端运行环境、构建前端，再由 Tauri 打包：

1. `scripts/build-backend-runtime.sh` 下载 arm64 便携 Python，复制后端代码和开发虚拟环境中的依赖。
2. 尝试用 Cython 编译后端模块，并清理部分构建文件。
3. 生成 `src-tauri/backend-runtime/`，将其作为资源加入应用。
4. 执行前端构建，并生成应用包与 DMG 等配置的目标产物。

产物通常位于 `frontend/src-tauri/target/release/bundle/`。这些目录、便携 Python 压缩包、依赖和模型均不应提交到源码仓库。

**该打包流程尚未在本次整理后的干净环境中完整验证。** 开发虚拟环境与打包用 Python 的版本、架构和原生依赖兼容性需要核对；编译完成也不代表签名、公证或所有功能已经验证。

## 可选的命令行工具

`cli/` 提供转录、项目、字幕、时间线及导出命令。先启动后端，再在项目根目录使用：

```bash
backend/.venv/bin/python -m pip install typer httpx
backend/.venv/bin/python -m cli --help
backend/.venv/bin/python -m cli --backend http://127.0.0.1:18000 project --help
```

CLI 默认地址仍为 `http://localhost:8000`，所以连接桌面开发后端时应显式指定 `--backend`，或设置 `QC_BACKEND_URL`。这些额外 CLI 依赖尚未单独锁定，以上命令未作为完整端到端流程验证。

## 测试与当前验证范围

前端测试入口：

```bash
cd frontend
npm test
```

后端测试入口（项目根目录）：

```bash
backend/.venv/bin/python -m pip install pytest
backend/.venv/bin/python -m pytest backend/tests
```

本次源码迁移已经执行密钥扫描、Python 语法检查和启动脚本语法检查；没有据此宣称完整构建或全部测试通过。

目前已知 `backend/tests/test_auth_routes.py` 和 `test_auth_store.py` 引用了缺失的 `app.auth_store`。原网盘备份同样缺少该模块，因此这两个测试无法收集。需要先确认这些测试是否属于旧功能遗留，或从其他源码版本找回模块，再验证认证相关功能。

## 常见问题

### 为什么下载源码后还需要安装大量文件？

源码不附带运行环境、第三方依赖和模型。安装依赖、下载模型和生成打包资源后，磁盘占用会增加，这是源码体积与软件运行体积不同的原因。

### 界面能打开，但达芬奇没有响应？

确认达芬奇正在运行、项目与时间线已打开，并允许外部脚本访问。当前后端会尝试导入 `DaVinciResolveScript`，并检查 macOS 默认脚本模块路径；没有找到接口时可能进入模拟模式，界面可打开并不能证明已经连接达芬奇。

### 启动后连接不上后端？

先查看终端输出和 `${TMPDIR:-/tmp}/QuickClip-backend.log`。确认 Python 依赖已安装，后端状态接口可访问，并核对前后端使用的实际端口。模型尚未安装和后端进程尚未启动是不同问题。

### 为什么开发启动脚本重复安装 Python 依赖？

当前脚本仍使用旧的 `funasr` 导入检查，但该包未列入现有 `backend/requirements.txt`，因此可能重复触发安装。这是待整理的脚本问题；排查时可以使用上面的手动启动方式，不必为通过旧检查而盲目补装整个旧模型环境。

### 可以直接发布 Windows 安装包吗？

目前不能将 Windows 视为已经验证的平台。现有脚本、Python 路径、平台模块和打包资源包含 macOS 假设，尤其便携 Python 固定为 arm64 macOS；需要先适配和测试。

## 项目结构与参考资料

```text
backend/          Python 后端、模型安装逻辑和测试
  app/            达芬奇接口、转录、字幕、素材与音效管理
  data/samples/   示例转录与时间线数据
frontend/         React 桌面界面、Vite 配置与测试入口
  src-tauri/      Rust / Tauri 桌面程序与打包配置
  scripts/        开发启动、后端运行环境和 DMG 辅助脚本
cli/              可选命令行工具
tools/            管理、对象存储发布及调试工具
docs/             备份中的功能说明与发布说明
start-app.command 桌面开发启动入口
```

- 示例数据：[转录](backend/data/samples/sample_transcript.json)、[时间线](backend/data/samples/sample_timeline.json)。
- 更新机制：[GitHub Releases 更新说明](docs/github-releases-update.md)。
- `docs/` 中部分用户指南保留了旧版本的激活、下载和模型描述，阅读时请与当前源码核对；本 README 不承诺旧服务仍可用。

欢迎通过 [Issues](https://github.com/boxin299/quickclip/issues) 反馈问题，或提交 Pull Request。反馈时请附系统与芯片类型、启动方式、复现步骤和脱敏日志；请移除密钥、账户信息及私人媒体路径。

## 许可证

项目原创源码采用 [MIT 许可证](LICENSE)，版权署名为 `boxin299`。第三方字体和依赖不因本项目的 MIT 许可证而改变授权：详见 [第三方说明](THIRD_PARTY_NOTICES.md)、[Geist 许可证](GEIST-LICENSE.txt) 和 [MiSans 协议](MISANS-LICENSE.pdf)。
