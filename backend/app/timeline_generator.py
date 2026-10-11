"""
时间线生成器模块
根据编辑后的转录数据生成达芬奇时间线JSON
"""

import json
from typing import List, Dict, Any
from pathlib import Path


class TimelineGenerator:
    """时间线生成器类"""
    
    def __init__(self, frame_rate: int = 24):
        """初始化时间线生成器
        
        Args:
            frame_rate: 帧率（默认 24，应从达芬奇项目设置获取）
        """
        self.frame_rate = frame_rate
        self.default_transition_frames = 0
    
    def set_frame_rate(self, fps: int):
        """
        设置帧率
        
        Args:
            fps: 帧率 (24, 25, 30, 60 等)
        """
        self.frame_rate = fps
    
    def _seconds_to_frames(self, seconds: float) -> int:
        """
        将秒数转换为帧数
        
        Args:
            seconds: 时间（秒）
        
        Returns:
            帧数
        """
        return int(seconds * self.frame_rate)
    
    def _frames_to_timecode(self, frames: int) -> str:
        """
        将帧数转换为时间码格式
        
        Args:
            frames: 帧数
        
        Returns:
            时间码字符串 (HH:MM:SS:FF)
        """
        hours = frames // (self.frame_rate * 3600)
        frames %= self.frame_rate * 3600
        minutes = frames // (self.frame_rate * 60)
        frames %= self.frame_rate * 60
        seconds = frames // self.frame_rate
        frames %= self.frame_rate
        
        return f"{hours:02d}:{minutes:02d}:{seconds:02d}:{frames:02d}"
    
    def generate(self, segments: List[Dict], video_path: str) -> Dict[str, Any]:
        """
        根据转录片段生成时间线
        
        Args:
            segments: 转录片段列表（包含编辑状态）
            video_path: 源视频路径
        
        Returns:
            时间线JSON数据
        """
        valid_segments = [s for s in segments if not s.get('deleted', False)]
        
        print(f"[INFO] 生成时间线: {len(valid_segments)}/{len(segments)} 个有效片段")
        
        timeline_clips = []
        current_timeline_position = 0
        
        for idx, segment in enumerate(valid_segments):
            start_frame = self._seconds_to_frames(segment['start'])
            end_frame = self._seconds_to_frames(segment['end'])
            duration_frames = end_frame - start_frame
            
            timeline_start_frame = current_timeline_position
            timeline_end_frame = current_timeline_position + duration_frames
            
            clip = {
                "clip_id": idx,
                "source_file": video_path,
                "source_start_frame": start_frame,
                "source_end_frame": end_frame,
                "source_start_timecode": self._frames_to_timecode(start_frame),
                "source_end_timecode": self._frames_to_timecode(end_frame),
                "timeline_start_frame": timeline_start_frame,
                "timeline_end_frame": timeline_end_frame,
                "timeline_start_timecode": self._frames_to_timecode(timeline_start_frame),
                "timeline_end_timecode": self._frames_to_timecode(timeline_end_frame),
                "duration_frames": duration_frames,
                "duration_seconds": round(duration_frames / self.frame_rate, 3),
                "text": segment['text'],
                "bold": segment.get('bold', False),
                "original_segment_id": segment['id']
            }
            
            timeline_clips.append(clip)
            current_timeline_position = timeline_end_frame
        
        total_duration_frames = current_timeline_position
        total_duration_seconds = total_duration_frames / self.frame_rate
        
        timeline = {
            "version": "1.0",
            "video_path": video_path,
            "frame_rate": self.frame_rate,
            "total_clips": len(timeline_clips),
            "total_duration_frames": total_duration_frames,
            "total_duration_seconds": round(total_duration_seconds, 3),
            "total_duration_timecode": self._frames_to_timecode(total_duration_frames),
            "clips": timeline_clips,
            "deleted_segments": [
                {"id": s['id'], "text": s['text'], "start": s['start'], "end": s['end']}
                for s in segments if s.get('deleted', False)
            ]
        }
        
        print(f"[INFO] 时间线生成完成: 总时长 {total_duration_seconds:.2f} 秒")
        return timeline
    
    def generate_edl(self, timeline: Dict) -> str:
        """
        生成EDL格式的时间线（用于导入其他软件）
        
        Args:
            timeline: 时间线JSON数据
        
        Returns:
            EDL格式字符串
        """
        edl_lines = [
            "TITLE: DaVinci Resolve Export",
            "FCM: NON-DROP FRAME",
            ""
        ]
        
        for idx, clip in enumerate(timeline.get('clips', [])):
            edl_lines.append(
                f"{idx+1:03d}  AX       V     C        "
                f"{clip['source_start_timecode']} {clip['source_end_timecode']} "
                f"{clip['timeline_start_timecode']} {clip['timeline_end_timecode']}"
            )
            edl_lines.append(f"* FROM CLIP NAME: {Path(clip['source_file']).name}")
            edl_lines.append(f"* COMMENT: {clip['text']}")
            edl_lines.append("")
        
        return "\n".join(edl_lines)
    
    def generate_fcp_xml(self, timeline: Dict) -> str:
        """
        生成FCP XML格式的时间线（Final Cut Pro兼容）
        
        Args:
            timeline: 时间线JSON数据
        
        Returns:
            FCP XML格式字符串
        """
        xml_lines = [
            '<?xml version="1.0" encoding="UTF-8"?>',
            '<!DOCTYPE fcpxml>',
            '<fcpxml version="1.9">',
            '    <resources>',
            f'        <asset id="r1" src="file://{timeline["video_path"]}"/>',
            '    </resources>',
            '    <library>',
            '        <event>',
            '            <project name="Text-Driven Edit">',
            f'                <sequence duration="{timeline["total_duration_seconds"]}s" format="r1">',
            '                    <spine>',
        ]
        
        for clip in timeline.get('clips', []):
            offset_seconds = clip['timeline_start_frame'] / timeline['frame_rate']
            text_preview = clip['text'][:30] if len(clip['text']) > 30 else clip['text']
            xml_lines.append(
                f'                        <clip name="{text_preview}..." '
                f'duration="{clip["duration_seconds"]}s" offset="{offset_seconds}s"/>'
            )
        
        xml_lines.extend([
            '                    </spine>',
            '                </sequence>',
            '            </project>',
            '        </event>',
            '    </library>',
            '</fcpxml>',
        ])
        
        return "\n".join(xml_lines)


if __name__ == "__main__":
    test_segments = [
        {"id": 0, "start": 0.0, "end": 3.5, "text": "大家好，欢迎观看本期视频", "deleted": False, "bold": False},
        {"id": 1, "start": 3.5, "end": 7.2, "text": "今天我们来聊一聊达芬奇软件", "deleted": True, "bold": False},
        {"id": 2, "start": 7.2, "end": 12.0, "text": "达芬奇是一款非常强大的软件", "deleted": False, "bold": True},
        {"id": 3, "start": 12.0, "end": 16.8, "text": "它被广泛应用于电影行业", "deleted": False, "bold": False},
    ]
    
    generator = TimelineGenerator()
    generator.set_frame_rate(24)
    
    timeline = generator.generate(test_segments, "/path/to/video.mp4")
    print(json.dumps(timeline, ensure_ascii=False, indent=2))
    
    print("\n--- EDL 格式 ---")
    print(generator.generate_edl(timeline))
    
    print("\n--- FCP XML 格式 ---")
    print(generator.generate_fcp_xml(timeline))
