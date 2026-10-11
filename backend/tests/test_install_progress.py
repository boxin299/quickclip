import copy
import unittest
from unittest import mock

from app import transcriber
from app.transcriber import get_install_progress


class TestInstallProgressRealtime(unittest.TestCase):
    """安装进度应实时反映当前阶段的下载字节数，而非被全局磁盘扫描覆盖。

    回归背景：_download_url 逐 64KB 平滑写入内存计数 _progress[0]["downloaded_bytes"]。
    旧实现 get_install_progress() 在下载中用全局磁盘扫描 _scan_local_model_bytes()
    覆盖该值。问题：
      - 磁盘扫描是"全局累计"（含已下完的 whisper ~502MB），而 downloaded_bytes 是
        "当前阶段"语义。到 DIAR 阶段时，扫描值 502MB 把当前阶段计数覆盖、并把 total
        抬到 502MB，进度条卡在 ~100% 不动。
      - 正在下载的 *.part 文件 DIAR 用精确文件名 exists() 判断 → 不计入，直到 rename
        才跳变。
    修复：内存计数为准，磁盘扫描不再覆盖；仅保留 _all_models_installed() 完成兜底。
    """

    def setUp(self):
        self._saved = copy.deepcopy(transcriber._progress[0])

    def tearDown(self):
        transcriber._progress[0] = self._saved

    def test_stage_counter_not_overwritten_by_global_disk_scan(self):
        # DIAR 阶段：当前阶段总量 ~41MB，emb 下到一半（内存计数 20MB）
        transcriber._progress[0] = {
            "running": True,
            "stage": "diarization",
            "detail": "下载说话人嵌入模型…",
            "error": None,
            "finished": False,
            "total_bytes": 42 * 1024 * 1024,
            "downloaded_bytes": 20 * 1024 * 1024,
            "speed": 1024,
        }

        # 模型未全部就绪；磁盘扫描返回全局累计值（whisper 已下完 ~502MB）
        with mock.patch.object(transcriber, "_all_models_installed", return_value=False), \
                mock.patch.object(transcriber, "_scan_local_model_bytes",
                                  return_value=502 * 1024 * 1024):
            p = get_install_progress()

        # 上报值应反映当前阶段的平滑进度，不被全局扫描值 502MB 覆盖
        self.assertEqual(
            p["downloaded_bytes"], 20 * 1024 * 1024,
            f"当前阶段进度被全局磁盘扫描覆盖，变成 {p['downloaded_bytes']} 字节",
        )
        # total 不应被抬高到全局累计值，否则进度条恒为 ~100%
        self.assertEqual(
            p["total_bytes"], 42 * 1024 * 1024,
            f"当前阶段 total 被磁盘扫描抬高到 {p['total_bytes']} 字节，进度条会卡在满格",
        )

    def test_completion_guard_still_works(self):
        # 所有模型已就绪时，无论内存里残留什么状态，都应标记完成
        transcriber._progress[0] = {
            "running": True, "stage": "diarization", "detail": "…",
            "error": None, "finished": False,
            "total_bytes": 42 * 1024 * 1024, "downloaded_bytes": 10 * 1024 * 1024, "speed": 0,
        }
        with mock.patch.object(transcriber, "_all_models_installed", return_value=True):
            p = get_install_progress()
        self.assertFalse(p["running"])
        self.assertTrue(p["finished"])
        self.assertEqual(p["stage"], "done")


if __name__ == "__main__":
    unittest.main()
