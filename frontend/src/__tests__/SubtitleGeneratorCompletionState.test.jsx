import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import SubtitleGenerator from '../components/SubtitleGenerator';

vi.mock('axios', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
  },
}));

describe('SubtitleGenerator completion state', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    axios.get.mockResolvedValue({
      data: {
        ready: true,
        preset: 'faster-whisper (small)',
        package: { label: '语音识别工具包' },
        profiles: [{ key: 'core', installed: true, ready: true }],
        models: [{ key: 'whisper', installed: true }],
        missing_labels: [],
      },
    });
    axios.post.mockImplementation((url) => {
      if (url.endsWith('/api/subtitle/transcribe')) {
        return Promise.resolve({
          data: {
            segments: [{ id: 0, start: 0, end: 1.2, text: '你好世界', words: [] }],
            transcript_id: 'tid-1',
            elapsed_seconds: 12.3,
          },
        });
      }
      return Promise.resolve({ data: {} });
    });
  });

  it('persists a non-loading workspace after transcription returns segments', async () => {
    const onWorkspaceStateChange = vi.fn();

    render(
      <SubtitleGenerator
        apiBaseUrl="http://localhost:8000"
        projectId="test-project"
        workspaceState={{
          sourceType: 'file',
          videoPath: '/tmp/audio.wav',
          modelStatusCached: {
            ready: true,
            profiles: [{ key: 'core', installed: true, ready: true }],
            models: [{ key: 'whisper', installed: true }],
            missing_labels: [],
          },
        }}
        onWorkspaceStateChange={onWorkspaceStateChange}
      />,
    );

    const startButton = await screen.findByRole('button', { name: /开始转录/ });
    await waitFor(() => expect(startButton.disabled).toBe(false));

    fireEvent.click(startButton);

    await waitFor(() => expect(axios.post).toHaveBeenCalledWith(
      'http://localhost:8000/api/subtitle/transcribe',
      expect.objectContaining({ video_path: '/tmp/audio.wav' }),
    ));
    await waitFor(() => {
      const latestDraft = onWorkspaceStateChange.mock.calls.at(-1)?.[0];
      expect(latestDraft?.loading).toBe(false);
      expect(latestDraft?.loadingStage).toBe('');
      expect(latestDraft?.loadingText).toBe('');
      expect(latestDraft?.segments?.[0]?.text).toBe('你好世界');
    });
  });

  it('does not show transcribing text when restored workspace already has segments', async () => {
    render(
      <SubtitleGenerator
        apiBaseUrl="http://localhost:8000"
        projectId="test-project"
        workspaceState={{
          sourceType: 'file',
          videoPath: '/tmp/audio.wav',
          loading: true,
          loadingText: '正在转录音频...',
          loadingStage: 'transcribing',
          loadingDetail: '正在处理你选择的本地音频/视频文件。',
          segments: [{ id: 0, start: 0, end: 1.2, text: '你好世界', words: [] }],
          modelStatusCached: {
            ready: true,
            profiles: [{ key: 'core', installed: true, ready: true }],
            models: [{ key: 'whisper', installed: true }],
            missing_labels: [],
          },
        }}
      />,
    );

    await waitFor(() => {
      expect(screen.queryByText('正在转录音频...')).toBeNull();
    });
  });
});
