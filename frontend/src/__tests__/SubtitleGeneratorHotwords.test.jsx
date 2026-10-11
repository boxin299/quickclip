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

describe('SubtitleGenerator hotword collections', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    axios.get.mockResolvedValue({
      data: {
        ready: true,
        models: [],
        missing_labels: [],
      },
    });
  });

  it('shows existing collections when opening the hotword manager', async () => {
    localStorage.setItem('sub_gen_enableAI', 'true');
    localStorage.setItem('noun_collections', JSON.stringify({ 品牌词: ['QuickClip'] }));
    localStorage.setItem('active_noun_collection', '品牌词');

    render(
      <SubtitleGenerator
        apiBaseUrl="http://localhost:8000"
        projectId="test-project"
      />,
    );

    fireEvent.click(screen.getByText('管理'));

    expect(await screen.findByText(/品牌词/)).toBeTruthy();
    await waitFor(() => expect(axios.get).toHaveBeenCalledWith('http://localhost:8000/api/backend/funasr/models'));
  });
});
