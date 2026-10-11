import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import TranscribeView from '../components/TranscribeView';

vi.mock('axios', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
  },
}));

describe('TranscribeView model preflight', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  it('does not start transcription when speech model is missing', async () => {
    axios.get.mockResolvedValue({
      data: {
        ready: false,
        missing_labels: ['Whisper (small)'],
      },
    });

    render(
      <TranscribeView
        importedVideos={[{ path: '/tmp/audio.wav', name: 'audio.wav' }]}
        onTranscriptReady={vi.fn()}
        apiBaseUrl="http://localhost:8000"
        projectId="test-project"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '开始转录并生成云文档' }));

    expect(await screen.findByText(/语音识别模型未安装/)).toBeTruthy();
    expect(axios.post).not.toHaveBeenCalledWith(
      'http://localhost:8000/api/transcribe/path',
      null,
      expect.anything(),
    );
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '开始转录并生成云文档' }).disabled).toBe(false);
    });
  });
});
