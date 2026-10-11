import os
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))

import resolve_api


class FakeMediaPoolItem:
    def __init__(self, props):
        self.props = props

    def GetClipProperty(self, key=None):
        if key is None:
            return self.props
        return self.props.get(key, "")


class FakeTimelineItem:
    def __init__(self, clip_props=None, item_props=None):
        self.media_pool_item = FakeMediaPoolItem(clip_props or {})
        self.item_props = item_props or {}

    def GetMediaPoolItem(self):
        return self.media_pool_item

    def GetProperty(self, key=None):
        if key is None:
            return self.item_props
        return self.item_props.get(key, "")


class BlackBorderAnalysisTest(unittest.TestCase):
    def setUp(self):
        with patch.object(resolve_api, "RESOLVE_AVAILABLE", False):
            self.controller = resolve_api.ResolveController()

    def test_project_mismatch_display_text_is_used_for_default_scaling(self):
        item = FakeTimelineItem(
            clip_props={"Resolution": "1080x1920"},
            item_props={"Scaling": "0", "ZoomX": "1", "ZoomY": "1"},
        )

        analysis = self.controller._analyze_black_border_risk(
            item,
            timeline_w=1920,
            timeline_h=1080,
            mismatch_behavior=None,
            project_mismatch="Scale full frame with crop",
        )

        self.assertFalse(analysis["has_black_border"])

    def test_one_sided_crop_offsets_visible_rect_and_exposes_border(self):
        item = FakeTimelineItem(
            clip_props={"Resolution": "1920x1080"},
            item_props={
                "Scaling": "scaleToCrop",
                "ZoomX": "1",
                "ZoomY": "1",
                "CropLeft": "200",
            },
        )

        analysis = self.controller._analyze_black_border_risk(
            item,
            timeline_w=1920,
            timeline_h=1080,
            mismatch_behavior="scaleToCrop",
        )

        self.assertTrue(analysis["has_black_border"])

    def test_rotated_portrait_clip_uses_pixel_aspect_for_coverage(self):
        item = FakeTimelineItem(
            clip_props={"Resolution": "1080x1920"},
            item_props={
                "Scaling": "scaleToCrop",
                "ZoomX": "1.11",
                "ZoomY": "1.11",
                "RotationAngle": "45",
            },
        )

        analysis = self.controller._analyze_black_border_risk(
            item,
            timeline_w=1920,
            timeline_h=1080,
            mismatch_behavior="scaleToCrop",
        )

        self.assertFalse(analysis["has_black_border"])

    def test_safe_zone_threshold_is_measured_in_pixels_after_rotation(self):
        item = FakeTimelineItem(
            clip_props={"Resolution": "1080x1920"},
            item_props={
                "Scaling": "scaleToCrop",
                "ZoomX": "1.10",
                "ZoomY": "1.10",
                "RotationAngle": "45",
            },
        )

        analysis = self.controller._analyze_black_border_risk(
            item,
            timeline_w=1920,
            timeline_h=1080,
            mismatch_behavior="scaleToCrop",
            safe_zone=14,
        )

        self.assertFalse(analysis["has_black_border"])

    def test_zoom_rotation_and_crop_use_full_frame_transform_basis(self):
        item = FakeTimelineItem(
            clip_props={"Resolution": "1920x1080"},
            item_props={
                "Scaling": "scaleToCrop",
                "ZoomX": "1.3",
                "ZoomY": "1.3",
                "RotationAngle": "10",
                "CropLeft": "100",
            },
        )

        analysis = self.controller._analyze_black_border_risk(
            item,
            timeline_w=1920,
            timeline_h=1080,
            mismatch_behavior="scaleToCrop",
        )

        self.assertFalse(analysis["has_black_border"])

    def test_negative_rotation_with_anchor_does_not_mirror_coverage(self):
        item = FakeTimelineItem(
            clip_props={"Resolution": "1920x1080"},
            item_props={
                "Scaling": "scaleToCrop",
                "ZoomX": "1.4",
                "ZoomY": "1.4",
                "RotationAngle": "-10",
                "AnchorPointX": "-300",
                "AnchorPointY": "-150",
                "CropLeft": "100",
            },
        )

        analysis = self.controller._analyze_black_border_risk(
            item,
            timeline_w=1920,
            timeline_h=1080,
            mismatch_behavior="scaleToCrop",
            safe_zone=14,
        )

        self.assertFalse(analysis["has_black_border"])
        self.assertLess(analysis["analysis"]["rotation_deg"], 0)

    def test_resolve_y_axis_and_rotation_sign_match_lower_left_border(self):
        item = FakeTimelineItem(
            clip_props={"Resolution": "1920x1080"},
            item_props={
                "Scaling": "scaleToCrop",
                "ZoomX": "1.63",
                "ZoomY": "1.63",
                "PositionX": "238",
                "PositionY": "59",
                "RotationAngle": "-15.7",
                "AnchorPointX": "0",
                "AnchorPointY": "0",
                "CropLeft": "124.4",
            },
        )

        analysis = self.controller._analyze_black_border_risk(
            item,
            timeline_w=1920,
            timeline_h=1080,
            mismatch_behavior="scaleToCrop",
        )

        self.assertTrue(analysis["has_black_border"])
        inverse_points = analysis["analysis"]["inverse_viewport_points_px"]
        self.assertTrue(inverse_points[0]["inside_visible_bounds"])
        self.assertFalse(inverse_points[3]["inside_visible_bounds"])

    def test_safe_zone_threshold_checks_inset_corners_only_without_masks(self):
        item = FakeTimelineItem(
            clip_props={"Resolution": "1920x1080"},
            item_props={
                "Scaling": "scaleToCrop",
                "ZoomX": "1.63",
                "ZoomY": "1.63",
                "PositionX": "238",
                "PositionY": "125",
                "RotationAngle": "-15.7",
                "AnchorPointX": "0",
                "AnchorPointY": "0",
                "CropLeft": "124.4",
            },
        )

        analysis = self.controller._analyze_black_border_risk(
            item,
            timeline_w=1920,
            timeline_h=1080,
            mismatch_behavior="scaleToCrop",
            safe_zone=100,
        )

        self.assertFalse(analysis["has_black_border"])

    def test_rotation_anchor_affects_black_border_coverage(self):
        item = FakeTimelineItem(
            clip_props={"Resolution": "1920x1080"},
            item_props={
                "Scaling": "scaleToCrop",
                "ZoomX": "1.2",
                "ZoomY": "1.2",
                "RotationAngle": "5",
                "AnchorPointX": "-400",
                "AnchorPointY": "-200",
            },
        )

        analysis = self.controller._analyze_black_border_risk(
            item,
            timeline_w=1920,
            timeline_h=1080,
            mismatch_behavior="scaleToCrop",
        )

        self.assertTrue(analysis["has_black_border"])


if __name__ == "__main__":
    unittest.main()
