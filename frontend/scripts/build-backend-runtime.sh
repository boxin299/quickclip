#!/bin/bash
# ==============================================================
# 后端运行时打包脚本
# 将 Python 后端代码和依赖复制到 src-tauri/backend-runtime/
# Tauri 打包时会将该目录包含进 .app bundle 的 Resources 中
# ==============================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FRONTEND_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ROOT_DIR="$(cd "$FRONTEND_DIR/.." && pwd)"
BACKEND_DIR="$ROOT_DIR/backend"
RUNTIME_DIR="$FRONTEND_DIR/src-tauri/backend-runtime"
VENV_LIB="$BACKEND_DIR/.venv/lib"

echo "=== 准备后端运行时 ==="

if [ ! -d "$BACKEND_DIR/app" ]; then
    echo "ERROR: 后端代码目录不存在: $BACKEND_DIR/app"
    exit 1
fi

# 1. 清理旧的运行时目录
rm -rf "$RUNTIME_DIR"
mkdir -p "$RUNTIME_DIR"

# 2. 下载并解压便携 Python 3.9（独立于系统 Python，确保兼容性）
#    注意：必须在 Cython 编译之前完成，编译过程依赖此 Python
echo "准备便携 Python 3.9..."
PYTHON_STANDALONE_URL="https://github.com/astral-sh/python-build-standalone/releases/download/20241016/cpython-3.9.20+20241016-aarch64-apple-darwin-install_only.tar.gz"
PYTHON_TARBALL="$RUNTIME_DIR/../python-standalone.tar.gz"
if [ ! -f "$PYTHON_TARBALL" ]; then
    echo "  下载 $PYTHON_STANDALONE_URL ..."
    curl -sL "$PYTHON_STANDALONE_URL" -o "$PYTHON_TARBALL"
fi
rm -rf "$RUNTIME_DIR/python"
mkdir -p "$RUNTIME_DIR/python"
echo "  解压便携 Python..."
tar xzf "$PYTHON_TARBALL" -C "$RUNTIME_DIR/python" --strip-components=1
if [ -f "$RUNTIME_DIR/python/bin/python3.9" ] && [ ! -f "$RUNTIME_DIR/python/bin/python3" ]; then
    ln -sf python3.9 "$RUNTIME_DIR/python/bin/python3"
fi
echo "  便携 Python 准备完成"

# 3. 复制后端应用代码
echo "复制后端代码..."
cp -r "$BACKEND_DIR/app" "$RUNTIME_DIR/app"

# 4. 用 Cython 编译 .py → .so（保护源码为原生机器码）
#    注意: binding=True 确保 FastAPI 能正确读取函数签名
echo "安装 Cython 到便携 Python..."
"$RUNTIME_DIR/python/bin/python3" -m pip install --quiet --no-warn-script-location 'cython==3.0.12' 2>/dev/null || {
    echo "  Cython 安装不可用，使用 .pyc 编译回退"
}
if "$RUNTIME_DIR/python/bin/python3" -c "import Cython" 2>/dev/null; then
    echo "Cython 就绪，开始编译..."
    cp "$BACKEND_DIR/app/build_cython.py" "$RUNTIME_DIR/app/build_cython.py"
    if "$RUNTIME_DIR/python/bin/python3" "$RUNTIME_DIR/app/build_cython.py" "$RUNTIME_DIR/app"; then
        echo "  已编译为 .so 原生共享库（binding=True，保留函数签名）"
    else
        echo "  Cython 编译失败，回退到 .pyc"
        rm -f "$RUNTIME_DIR/app/build_cython.py"
        PYTHON_BIN="$BACKEND_DIR/.venv/bin/python3"
        if [ -x "$PYTHON_BIN" ]; then
            "$PYTHON_BIN" -O -m compileall -b "$RUNTIME_DIR/app" 2>/dev/null || true
            find "$RUNTIME_DIR/app" -name "*.py" ! -name "__init__.py" ! -name "main.py" -delete
            echo "  已编译为 .pyc（回退）"
        fi
    fi
    rm -f "$RUNTIME_DIR/app/build_cython.py"
else
    echo "  Cython 不可用，回退到 .pyc 编译..."
    PYTHON_BIN="$BACKEND_DIR/.venv/bin/python3"
    if [ -x "$PYTHON_BIN" ]; then
        "$PYTHON_BIN" -O -m compileall -b "$RUNTIME_DIR/app" 2>/dev/null || true
        find "$RUNTIME_DIR/app" -name "*.py" ! -name "__init__.py" ! -name "main.py" -delete
        echo "  已编译为 .pyc"
    else
        echo "  venv Python 不可用 ($PYTHON_BIN)，跳过编译"
    fi
fi

# 5. 复制 requirements.txt（供参考）
cp "$BACKEND_DIR/requirements.txt" "$RUNTIME_DIR/"

# 6. 创建空的 data 目录结构（配置文件由应用首次运行时自动生成）
echo "创建 data 目录结构..."
mkdir -p "$RUNTIME_DIR/data/"{transcripts,videos,samples}
touch "$RUNTIME_DIR/data/transcripts/.gitkeep"
touch "$RUNTIME_DIR/data/videos/.gitkeep"
# 仅复制示例文件
if [ -f "$BACKEND_DIR/data/samples/sample_transcript.json" ]; then
    cp "$BACKEND_DIR/data/samples/sample_transcript.json" "$RUNTIME_DIR/data/samples/"
fi
if [ -f "$BACKEND_DIR/data/samples/sample_timeline.json" ]; then
    cp "$BACKEND_DIR/data/samples/sample_timeline.json" "$RUNTIME_DIR/data/samples/"
fi
echo "  已排除所有运行时配置文件（auth_store/config/clip_import/project_registry/sfx_meta 等）"
# 确保不该打包的配置/数据文件被删除
rm -f "$RUNTIME_DIR/data/clip_import_config.json"

# 注意：说话人分离和 whisper 模型默认不打包（体积太大），首次使用时自动下载到 ~/.quickclip/
echo "注意: sherpa-onnx 和 faster-whisper 模型默认不打包，首次使用时将从网络下载"

# 7. 复制 Python 依赖（site-packages）
echo "复制 Python 依赖..."
mkdir -p "$RUNTIME_DIR/lib"
if [ -d "$VENV_LIB" ]; then
    PYTHON_VERSION=$(ls "$VENV_LIB" 2>/dev/null | head -1)
    if [ -n "$PYTHON_VERSION" ] && [ -d "$VENV_LIB/$PYTHON_VERSION/site-packages" ]; then
        cp -r "$VENV_LIB/$PYTHON_VERSION/site-packages" "$RUNTIME_DIR/lib/"
        echo "  已复制 Python $PYTHON_VERSION 依赖包"
    else
        echo "  未找到虚拟环境的 site-packages，依赖将不会被打包"
    fi
else
    echo "  虚拟环境不存在 ($VENV_LIB)，依赖将不会被打包"
    echo "  请先运行 backend/.venv/bin/pip install -r backend/requirements.txt"
fi

# 8. 移除未使用的包（开发/测试依赖，非运行时所需）
echo "移除未使用的依赖包..."
UNUSED_PACKAGES=(
    # funasr 生态 — transcriber.py 未实际 import，仅作为可用性字符串引用
    "funasr" "funasr_onnx" "funasr-*"
    # funasr 的间接依赖
    "scipy" "scipy-*"
    "sklearn" "scikit_learn" "scikit_learn-*"
    "librosa" "librosa-*"
    "numba" "numba-*"
    "llvmlite" "llvmlite-*"
    "pynndescent" "pynndescent-*"
    "umap-learn" "umap_learn-*"
    "networkx" "networkx-*"
    "pooch" "pooch-*"
    # 独立安装但未使用
    # 注意: jieba 已被字幕词组分割（subtitle_speed_tracker）使用，不可移除
    "modelscope" "modelscope-*"
    "sympy" "sympy-*"
    "mpmath" "mpmath-*"
    "sentencepiece" "sentencepiece-*"
    "aliyunsdkcore" "aliyunsdkcore-*"
    "oss2" "oss2-*"
    "redis" "redis-*"
    "google" "google-*"
    "pygments" "pygments-*"
    # "torio" 不能删！torchaudio.io 依赖它
    # "torchgen" 不能删！torch.utils._python_dispatch 依赖它，删除会导致 torch 无法 import
    "hydra" "hydra*"
    "omegaconf" "omegaconf-*"
    # 开发/构建工具
    "pip" "pip-*"
    "setuptools" "setuptools-*"
    "pytest" "_pytest" "pytest-*"
    "coverage" "coverage-*"
    "wheel" "wheel-*"
    "distutils" "distutils-*"
    "pkg_resources"
    # 开发/构建工具（续）
)
for dir_pattern in "${UNUSED_PACKAGES[@]}"; do
    rm -rf "$RUNTIME_DIR/lib/site-packages/$dir_pattern"
done
echo "  已移除未使用的依赖包"

# 9. 清理 torch 中的构建时/测试文件（C++ 头文件、cmake、测试）
echo "清理 torch 构建时文件..."
rm -rf "$RUNTIME_DIR/lib/site-packages/torch/include"    # C++ 头文件 ~58MB
rm -rf "$RUNTIME_DIR/lib/site-packages/torch/share"      # cmake 配置
rm -rf "$RUNTIME_DIR/lib/site-packages/torch/test"       # 测试用例
rm -rf "$RUNTIME_DIR/lib/site-packages/torch/_inductor"  # JIT 编译器（推理不需要）
# NOTE: torch/testing/ MUST NOT be removed — torch.autograd.gradcheck
# imports torch.testing at startup, so it's a runtime dependency, not a dev-only module.
echo "  已清理 torch 冗余文件"
echo ""

# 10. 计算大小
runtime_size=$(du -sh "$RUNTIME_DIR" 2>/dev/null | awk '{print $1}')
echo ""
echo "=== 后端运行时准备完成 ==="
echo "  位置: $RUNTIME_DIR"
echo "  大小: ${runtime_size:-未知}"
echo ""
echo "  Tauri 构建时会自动将该目录包含进应用包中。"
echo "  运行时，应用会自动查找系统 python3 并加载打包的依赖。"
