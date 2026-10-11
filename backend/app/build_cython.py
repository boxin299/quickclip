#!/usr/bin/env python3
"""Cython build script: compile .py source files to .so native shared libraries.

Usage: python build_cython.py <app_dir>
"""

import os
import shutil
import subprocess
import sys
from pathlib import Path


def build(target_dir: str) -> None:
    """Compile all .py files in *target_dir* to .so shared libraries via Cython."""
    app_path = Path(target_dir).resolve()
    if not app_path.is_dir():
        print(f"Error: {app_path} is not a directory")
        sys.exit(1)

    try:
        from Cython.Build import cythonize  # noqa: F401
    except ImportError:
        sys.exit("Cython is not installed. Run: pip install cython")

    # Absolute path of *this* script so we can exclude it from compilation.
    this_script = Path(__file__).resolve()

    # ---- 1. Collect all .py files, excluding this script and __init__.py ----
    # __init__.py is skipped because Cython cannot resolve a module named '__init__'.
    # It is a package marker with no business logic; it remains as plain text.
    py_files = sorted(
        p for p in app_path.rglob("*.py")
        if p.resolve() != this_script and p.name != "__init__.py"
    )

    if not py_files:
        print("No .py files found to compile.")
        return

    # ---- 2. Identify and pre-process main.py ----
    main_py_path = app_path / "main.py"
    app_main_py_path = app_path / "_app_main.py"
    has_main = main_py_path.exists() and main_py_path.resolve() != this_script
    main_renamed = False

    if has_main:
        if app_main_py_path.exists():
            print(f"  WARNING: removing stale _app_main.py from previous run")
            app_main_py_path.unlink()
        print(f"Renaming {main_py_path.name} -> {app_main_py_path.name}")
        shutil.move(str(main_py_path), str(app_main_py_path))
        main_renamed = True

    # ---- 3. Generate _cython_setup.py ----
    extension_lines: list[str] = []
    for py_file in py_files:
        # Calculate dotted module name relative to app_path
        rel = py_file.relative_to(app_path)
        module_name = str(rel.with_suffix("")).replace(os.sep, ".")

        # Determine the actual source file path for the extension
        if main_renamed and py_file == main_py_path:
            source_path = app_main_py_path
            module_name = "_app_main"
        else:
            source_path = py_file

        extension_lines.append(
            f"    Extension({repr(module_name)}, [{repr(str(source_path))}])"
        )

    _join_sep = ",\n"
    # NOTE: f-string interpolation: {{key}} → {key} in generated code
    setup_code = f'''import os, sys, sysconfig, re

# Fix sysroot: python-standalone's sysconfig may reference a stale Xcode SDK path
_correct_sdk = os.environ.get("SDKROOT", "")
if _correct_sdk:
    for _key in ("CFLAGS", "LDFLAGS", "BLDSHARED", "LDSHARED", "CC", "CXX"):
        _val = sysconfig.get_config_var(_key)
        if _val and "/Applications/Xcode" in _val:
            _patched = _val.replace(
                "/Applications/Xcode_15.2.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX14.2.sdk",
                _correct_sdk
            )
            _patched = re.sub(r'/Applications/Xcode[^ ]*\.sdk', _correct_sdk, _patched)
            sysconfig.get_config_vars()[_key] = _patched

from setuptools import Extension, setup
from Cython.Build import cythonize

extensions = [
{_join_sep.join(extension_lines)}
]

if __name__ == '__main__':
    setup(
        ext_modules=cythonize(
            extensions,
            compiler_directives={{
                "language_level": "3",
                "binding": True,
                "embedsignature": False,
                "annotation_typing": False,
            }},
            nthreads=0,
        ),
    )
'''

    setup_path = app_path / "_cython_setup.py"
    setup_path.write_text(setup_code, encoding="utf-8")

    # ---- 4. Invoke the build ----
    env = os.environ.copy()
    # Override SDKROOT and CFLAGS to use the system's Command Line Tools
    # (python-standalone's sysconfig may reference a stale Xcode SDK path)
    sdkroot = subprocess.run(["xcrun", "--show-sdk-path"], capture_output=True, text=True).stdout.strip()
    if sdkroot and os.path.isdir(sdkroot):
        env["SDKROOT"] = sdkroot
        env["CFLAGS"] = f"-O2 -fvisibility=hidden -isysroot {sdkroot}"
    else:
        env["CFLAGS"] = "-O2 -fvisibility=hidden"

    print(f"Compiling {len(py_files)} module(s) ...")
    result = subprocess.run(
        [sys.executable, str(setup_path), "build_ext", "--inplace"],
        cwd=str(app_path),
        env=env,
        capture_output=True,
        text=True,
    )

    if result.returncode != 0:
        print("Cython build failed:")
        print(result.stdout)
        print(result.stderr, file=sys.stderr)
        # Restore main.py on failure
        if main_renamed and app_main_py_path.exists():
            print("Restoring main.py ...")
            shutil.move(str(app_main_py_path), str(main_py_path))
        sys.exit(result.returncode)

    # ---- 5. Clean up on success ----
    print("Build succeeded. Cleaning up ...")

    # 5a. Remove the temporary setup script
    setup_path.unlink(missing_ok=True)

    # 5b. Remove all compiled .py source files
    for py_file in py_files:
        if py_file.exists():
            py_file.unlink()

    # 5c. Remove the renamed _app_main.py if it still exists
    if main_renamed and app_main_py_path.exists():
        app_main_py_path.unlink()

    # 5d. Remove Cython-generated .c intermediate files (top-level only)
    for c_file in app_path.glob("*.c"):
        c_file.unlink()

    # 5e. Remove the build/ directory
    build_dir = app_path / "build"
    if build_dir.exists():
        shutil.rmtree(build_dir)

    # 5f. Generate glue main.py
    if main_renamed:
        glue_path = app_path / "main.py"
        glue_path.write_text("from _app_main import app\n", encoding="utf-8")
        print(f"Generated glue {glue_path.name}")

    # ---- 6. Print output summary ----
    so_files = sorted(app_path.rglob("*.so"))
    if so_files:
        print(f"\nCompilation successful. {len(so_files)} .so file(s):")
        for so_file in so_files:
            size_kb = so_file.stat().st_size / 1024
            print(f"  {so_file.relative_to(app_path)}  ({size_kb:.1f} KB)")
    else:
        print("\nWarning: no .so files were produced.")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(f"Usage: {sys.argv[0]} <app_dir>", file=sys.stderr)
        sys.exit(1)
    build(sys.argv[1])
