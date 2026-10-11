# DaVinci Resolve 文本驱动剪辑工具

> 这份介绍由 AI 代写，作者目前比较忙，暂时没有逐句手工润色，后续会继续补充和优化。

QuickClip 是一款面向 DaVinci Resolve 的文本驱动剪辑工具，基于 `React + Tauri + FastAPI + faster-whisper` 构建。它把转录、字幕、时间线编辑、审阅意见、素材整理和导出流程放到同一个本地工作台里，让剪辑更接近「先看文本，再定画面」的工作方式。

项目默认本地可用，不需要账号登录、设备绑定或云端许可服务。核心目标很简单：

- 把视频里的语音快速转成带时间戳的文本。
- 让你直接在文本上做粗剪和筛选。
- 把字幕、审阅、检查、导出串成一条完整工作流。
- 尽量把素材、模型和数据留在本地。

## 核心功能

- 本地音频转录，支持时间线音频或本地文件
- 词级 / 段级文本选择，快速生成新时间线或追加到现有时间线
- 字幕编辑、搜索替换、SRT 导出、达芬奇时间线插入
- 自动同步字幕，支持时间线变化和变速对齐
- 同步审阅，拉取阅流评论并写入时间线标记
- 时间线检查，扫描夹帧、黑帧和黑边风险
- 文件层级管理，整理达芬奇媒体池结构
- 素材打包，自动收集当前时间线引用的素材
- 剪贴导入，自动把复制的图片写入项目并导入媒体池
- 音效库，支持索引、试听、标签、收藏、拖拽和插入时间线
- 偏好设置，集中管理运行环境、模型和更新

## 适用场景

- 访谈、口播、播客、课程类内容的粗剪
- 字幕制作和字幕对齐
- 客户审阅意见整理
- 成片交付前的时间线检查
- 项目素材归档和交接

## 当前状态

当前版本已经覆盖完整的日常辅助剪辑链路，重点能力包括：

- 本地 FastAPI 后端
- Tauri + React 桌面前端
- 本地 `faster-whisper` 转录
- 文本驱动粗剪
- 字幕编辑与导入
- 时间线检查与导出
- 音效库与剪贴导入
- DaVinci Resolve 接口联动

## 项目结构

```text
.
├── backend
│   ├── app
│   │   ├── __init__.py
│   │   ├── main.py
│   │   ├── resolve_api.py
│   │   ├── timeline_generator.py
│   │   └── transcriber.py
│   ├── data
│   │   ├── samples
│   │   ├── transcripts
│   │   └── videos
│   └── requirements.txt
├── docs
├── frontend
│   ├── public
│   │   └── index.html
│   ├── src-tauri
│   │   └── src
│   ├── scripts
│   ├── src
│   │   ├── components
│   │   ├── App.css
│   │   ├── App.js
│   │   ├── index.css
│   │   └── index.js
│   └── package.json
└── README.md
```

## 当前能力

### 后端

- `POST /api/subtitle/transcribe`
  - 从本地文件或时间线音频生成转录结果
- `POST /api/timeline/generate`
  - 根据选中文本生成时间线数据
- `POST /api/timeline/apply-edit`
  - 将文本选择结果应用到达芬奇时间线
- `POST /api/subtitle/insert-timeline`
  - 将字幕插入达芬奇时间线
- `POST /api/timeline/check`
  - 扫描时间线问题
- `POST /api/export/render`
  - 触发达芬奇渲染导出
- `POST /api/sound-effects/insert-to-timeline`
  - 将音效插入当前时间线

### 前端

- 导入本地视频或音频路径
- 展示带时间戳的转录文本
- 按说话人筛选和管理文本
- 选择句子或词语生成时间线
- 编辑字幕并导出 SRT
- 浏览音效库并拖入时间线

## 环境要求

- macOS 优先
- Python 3.10+
- Node.js 18+
- npm 9+

## 启动方式

### 一键启动桌面软件

在项目根目录直接运行：

```bash
./start-app.command
```

说明：

- 该脚本会进入 `frontend`
- 自动执行 `npm run tauri dev`
- `tauri` 会调用 `frontend/scripts/dev-with-backend.sh`
- 该脚本会优先使用 `backend/.venv/bin/python`
- 后端模型缓存固定到 `backend/data/modelscope`

如果你在 Finder 中使用，也可以直接双击 `start-app.command`。

### 1. 启动后端

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python3 app/main.py
```

启动后可访问：

- API: [http://localhost:8000](http://localhost:8000)
- Swagger: [http://localhost:8000/docs](http://localhost:8000/docs)

### 2. 启动前端

```bash
cd frontend
npm install
npm run tauri dev
```

说明：

- `npm run tauri dev` 会同时拉起 Vite 开发服务和 Tauri 桌面端
- 前端开发服务默认运行在 `http://localhost:3000`
- 前端默认请求后端 `http://localhost:8000`

## 本地转录说明

后端默认优先使用 `faster-whisper`。

如果本机尚未正确安装模型依赖，代码会退回到模拟模式，便于先验证前后端流程：

- 视频导入
- 转录结果展示
- 文本删除
- timeline 生成

等基础链路跑通后，再切回真实模型即可。

## 示例数据

已提供示例文件：

- `backend/data/samples/sample_transcript.json`
- `backend/data/samples/sample_timeline.json`

可用于前端联调和接口格式确认。

## 后续计划

- 继续完善 GitHub 文档和截图说明
- 补充更完整的安装包下载与使用教程
- 优化首次启动和模型安装体验
- 继续打磨字幕、审阅和音效库细节
- 增加更多实际剪辑案例说明

## 开源副本与本地配置

本仓库仅保留 QuickClip 桌面应用的源码、测试、构建脚本及前端资源；宣传网站 `web/` 不纳入本次发布。Python 虚拟环境、编译缓存、语音模型、个人转录记录、登录会话、数据库和其他应用的参考副本不纳入源码仓库。按上文安装依赖；模型由项目对应的模型下载流程获取。打包时需要先生成后端运行环境。

启动脚本不再包含管理员密码哈希、JWT 密钥或阅流应用密钥。需要阅流评论功能时，先在终端设置 `YUE_LIU_APP_SECRET`，再运行启动脚本。其余集成凭证也应在本机按对应服务配置。变量名称见 `.env.example`；该文件不会被启动脚本自动加载。请不要提交填入真实值的配置文件。

旧副本中的真实凭证应在对应服务撤销或轮换；从源码删除凭证不会使旧凭证失效。

## 迁移验证范围

该源码副本来自网盘备份。已执行密钥扫描、Python 语法检查和启动脚本语法检查；尚未完成安装依赖后的完整构建与功能验证。备份中保留的认证测试引用 `app.auth_store`，但当前备份未包含该模块，因此这些测试无法收集。请先核对该模块是旧测试遗留还是缺失源码，再将本副本作为可复现发布版本。

## 许可证

项目原创代码采用 [MIT 许可证](LICENSE)，版权署名为 `boxin299`。第三方依赖和字体资源仍遵循各自的许可条款。
