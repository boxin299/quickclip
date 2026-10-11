import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import SettingsView from '../components/SettingsView';

vi.mock('axios', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
  },
}));

vi.mock('../tauriAPI', () => ({
  default: {
    revealInFinder: vi.fn(),
    openUrl: vi.fn(),
  },
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
  stat: vi.fn(),
  readDir: vi.fn(),
  mkdir: vi.fn(),
  copyFile: vi.fn(),
  remove: vi.fn(),
}));

describe('SettingsView donate entry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    axios.get.mockImplementation((url) => {
      if (url.endsWith('/api/config')) {
        return Promise.resolve({ data: {} });
      }
      if (url.endsWith('/api/backend/funasr/models')) {
        return Promise.resolve({ data: { models: [] } });
      }
      if (url.endsWith('/api/skills/bundled')) {
        return Promise.resolve({ data: { skills: [] } });
      }
      if (url.endsWith('/api/status')) {
        return Promise.resolve({ data: { connected: false } });
      }
      if (url.endsWith('/api/backend/health')) {
        return Promise.resolve({ data: { python: { available: true }, ffmpeg: { available: true } } });
      }
      if (url.endsWith('/api/backend/funasr/models/install/progress')) {
        return Promise.resolve({ data: { running: false } });
      }
      return Promise.resolve({ data: {} });
    });
  });

  it('opens the donate QR image from settings and closes it', async () => {
    render(<SettingsView apiBaseUrl="http://localhost:8000" theme="auto" />);

    fireEvent.click(await screen.findByRole('button', { name: /打开赞赏码/ }));

    const dialog = screen.getByRole('dialog', { name: '赞赏支持' });
    const qrImage = within(dialog).getByAltText('赞赏二维码');
    expect(qrImage.getAttribute('src')).toMatch(/donate-qr\.png$/);

    fireEvent.click(within(dialog).getByRole('button', { name: '关闭赞赏码' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: '赞赏支持' })).toBeNull();
    });
  });
});
