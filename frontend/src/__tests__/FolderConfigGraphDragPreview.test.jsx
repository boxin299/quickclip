import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import FolderConfigGraph from '../components/FolderConfigGraph';

vi.mock('axios', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
  },
}));

describe('FolderConfigGraph drag preview', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    axios.get.mockImplementation((url) => {
      if (url.endsWith('/api/status')) {
        return Promise.resolve({ data: { connected: false } });
      }
      if (url.endsWith('/api/folder_config')) {
        return Promise.resolve({
          data: {
            local_folders: ['01素材', '02剪辑'],
            davinci_folders: [],
            mapping: {},
          },
        });
      }
      return Promise.resolve({ data: {} });
    });
    axios.post.mockResolvedValue({ data: {} });
  });

  it('moves the folder preview with the pointer instead of relying on transform animation', async () => {
    render(
      <FolderConfigGraph
        apiBaseUrl="http://localhost:8000"
        activePage="local"
        setActivePage={vi.fn()}
      />,
    );

    const folderRow = await screen.findByText('01素材');

    fireEvent.mouseDown(folderRow, { button: 0, clientX: 40, clientY: 50 });
    fireEvent.mouseMove(window, { clientX: 160, clientY: 180 });

    const dragPreview = await screen.findByTestId('folder-drag-preview');
    await waitFor(() => {
      expect(dragPreview.style.left).toBe('174px');
      expect(dragPreview.style.top).toBe('162px');
    });
    expect(dragPreview.style.transform).toBe('');
  });

  it('does not show the folder preview until the pointer moves beyond the drag threshold', async () => {
    render(
      <FolderConfigGraph
        apiBaseUrl="http://localhost:8000"
        activePage="local"
        setActivePage={vi.fn()}
      />,
    );

    const folderRow = await screen.findByText('01素材');

    fireEvent.mouseDown(folderRow, { button: 0, clientX: 40, clientY: 50 });
    expect(screen.queryByTestId('folder-drag-preview')).toBeNull();

    fireEvent.mouseMove(window, { clientX: 42, clientY: 52 });
    expect(screen.queryByTestId('folder-drag-preview')).toBeNull();

    fireEvent.mouseMove(window, { clientX: 52, clientY: 50 });

    const dragPreview = await screen.findByTestId('folder-drag-preview');
    await waitFor(() => {
      expect(dragPreview.style.left).toBe('66px');
      expect(dragPreview.style.top).toBe('32px');
    });
  });

  it('aligns the folder preview with the insertion line while hovering a valid drop target', async () => {
    render(
      <FolderConfigGraph
        apiBaseUrl="http://localhost:8000"
        activePage="local"
        setActivePage={vi.fn()}
      />,
    );

    const sourceLabel = await screen.findByText('01素材');
    const targetLabel = await screen.findByText('02剪辑');
    const targetRow = targetLabel.closest('[data-folder-tree-item]');
    targetRow.getBoundingClientRect = vi.fn(() => ({
      top: 100,
      bottom: 140,
      height: 40,
      left: 0,
      right: 300,
      width: 300,
      x: 0,
      y: 100,
      toJSON: () => {},
    }));

    fireEvent.mouseDown(sourceLabel, { button: 0, clientX: 40, clientY: 50 });
    fireEvent.mouseMove(targetRow, { clientX: 160, clientY: 130 });

    const dragPreview = await screen.findByTestId('folder-drag-preview');
    await waitFor(() => {
      expect(dragPreview.style.left).toBe('174px');
      expect(dragPreview.style.top).toBe('122px');
    });
  });
});

describe('FolderConfigGraph mapping selectors', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    axios.get.mockImplementation((url) => {
      if (url.endsWith('/api/status')) {
        return Promise.resolve({ data: { connected: false } });
      }
      if (url.endsWith('/api/folder_config')) {
        return Promise.resolve({
          data: {
            local_folders: ['01 原始素材', '01 原始素材/A机', '02 剪辑'],
            davinci_folders: ['原始素材', '原始素材/A机', '剪辑'],
            mapping: {},
          },
        });
      }
      return Promise.resolve({ data: {} });
    });
    axios.post.mockResolvedValue({ data: {} });
  });

  it('shows only top-level folders in mapping selectors until subfolders are enabled', async () => {
    render(
      <FolderConfigGraph
        apiBaseUrl="http://localhost:8000"
        activePage="mapping"
        setActivePage={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByText('-- 选择未映射的本地目录 --'));

    expect(screen.getByText('01 原始素材')).toBeTruthy();
    expect(screen.getByText('02 剪辑')).toBeTruthy();
    expect(screen.queryByText('01 原始素材/A机')).toBeNull();

    fireEvent.mouseDown(document.body);
    fireEvent.click(screen.getByText('显示子目录'));
    fireEvent.click(screen.getAllByText('-- 选择未映射的本地目录 --')[0]);

    expect(screen.getByText('01 原始素材/A机')).toBeTruthy();
  });
});

describe('FolderConfigGraph file tree actions', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    axios.get.mockImplementation((url) => {
      if (url.endsWith('/api/status')) {
        return Promise.resolve({ data: { connected: false } });
      }
      if (url.endsWith('/api/folder_config')) {
        return Promise.resolve({
          data: {
            local_folders: ['01素材', '02剪辑'],
            davinci_folders: [],
            mapping: {},
          },
        });
      }
      return Promise.resolve({ data: {} });
    });
    axios.post.mockResolvedValue({ data: {} });
    window.electronAPI = {
      selectDirectory: vi.fn().mockResolvedValue('/project'),
      readLocalFolders: vi.fn().mockResolvedValue(['导入素材', '导入素材/A机']),
    };
  });

  it('can remember not to show local folder delete confirmations again', async () => {
    render(
      <FolderConfigGraph
        apiBaseUrl="http://localhost:8000"
        activePage="local"
        setActivePage={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByText('01素材'));
    fireEvent.click(screen.getByLabelText('删除 01素材'));

    expect(screen.getByText('删除本地文件夹')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('不再显示删除确认'));
    fireEvent.click(screen.getByText('删除'));

    await waitFor(() => {
      expect(localStorage.getItem('folderConfig_skipLocalDeleteConfirm')).toBe('true');
    });

    fireEvent.click(screen.getByText('02剪辑'));
    fireEvent.click(screen.getByLabelText('删除 02剪辑'));

    expect(screen.queryByText('删除本地文件夹')).toBeNull();
    await waitFor(() => {
      expect(axios.post).toHaveBeenLastCalledWith(
        'http://localhost:8000/api/folder_config',
        expect.objectContaining({ local_folders: [] }),
      );
    });
  });

  it('uses an opaque danger button style when the selected row shows delete', async () => {
    render(
      <FolderConfigGraph
        apiBaseUrl="http://localhost:8000"
        activePage="local"
        setActivePage={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByText('01素材'));

    expect(screen.getByLabelText('删除 01素材').style.background).toBe('rgb(255, 59, 48)');
  });

  it('replaces the local folder structure when importing from disk', async () => {
    render(
      <FolderConfigGraph
        apiBaseUrl="http://localhost:8000"
        activePage="local"
        setActivePage={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByText('导入本地结构'));
    await screen.findByText('选择导入层级');
    fireEvent.click(screen.getByText('确认导入'));

    await waitFor(() => {
      expect(axios.post).toHaveBeenLastCalledWith(
        'http://localhost:8000/api/folder_config',
        expect.objectContaining({
          local_folders: ['导入素材', '导入素材/A机'],
        }),
      );
    });
  });

  it('supports Finder-style arrow navigation, Enter rename, and Command Delete', async () => {
    render(
      <FolderConfigGraph
        apiBaseUrl="http://localhost:8000"
        activePage="local"
        setActivePage={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByText('01素材'));
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    expect(screen.getByText('02剪辑').closest('[data-folder-tree-item]').style.background).toBe('var(--mac-accent)');

    fireEvent.keyDown(window, { key: 'ArrowUp' });
    expect(screen.getByText('01素材').closest('[data-folder-tree-item]').style.background).toBe('var(--mac-accent)');

    fireEvent.keyDown(window, { key: 'Enter' });
    expect(screen.getByDisplayValue('01素材')).toBeTruthy();

    fireEvent.keyDown(screen.getByDisplayValue('01素材'), { key: 'Escape' });
    fireEvent.keyDown(window, { key: 'Backspace', metaKey: true });

    await waitFor(() => {
      expect(axios.post).toHaveBeenLastCalledWith(
        'http://localhost:8000/api/folder_config',
        expect.objectContaining({ local_folders: ['02剪辑'] }),
      );
    });
  });

  it('commits rename and exits edit mode when pressing Enter inside the rename input', async () => {
    render(
      <FolderConfigGraph
        apiBaseUrl="http://localhost:8000"
        activePage="local"
        setActivePage={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByText('01素材'));
    fireEvent.keyDown(window, { key: 'Enter' });

    const renameInput = screen.getByDisplayValue('01素材');
    fireEvent.keyDown(renameInput, { key: 'Enter' });

    await waitFor(() => {
      expect(screen.queryByDisplayValue('01素材')).toBeNull();
    });
    expect(screen.getByText('01素材')).toBeTruthy();
  });

  it('keeps the renamed folder selected after committing a new name', async () => {
    render(
      <FolderConfigGraph
        apiBaseUrl="http://localhost:8000"
        activePage="local"
        setActivePage={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByText('01素材'));
    fireEvent.keyDown(window, { key: 'Enter' });

    const renameInput = screen.getByDisplayValue('01素材');
    fireEvent.change(renameInput, { target: { value: '01素材重命名' } });
    fireEvent.keyDown(renameInput, { key: 'Enter' });

    await waitFor(() => {
      expect(screen.getByText('01素材重命名').closest('[data-folder-tree-item]').style.background).toBe('var(--mac-accent)');
    });
  });

  it('keeps a visible folder selected after deleting the selected folder', async () => {
    localStorage.setItem('folderConfig_skipLocalDeleteConfirm', 'true');

    render(
      <FolderConfigGraph
        apiBaseUrl="http://localhost:8000"
        activePage="local"
        setActivePage={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByText('01素材'));
    fireEvent.keyDown(window, { key: 'Backspace', metaKey: true });

    await waitFor(() => {
      expect(screen.getByText('02剪辑').closest('[data-folder-tree-item]').style.background).toBe('var(--mac-accent)');
    });
  });

  it('uses left and right arrows to collapse and expand the selected folder', async () => {
    axios.get.mockImplementation((url) => {
      if (url.endsWith('/api/status')) {
        return Promise.resolve({ data: { connected: false } });
      }
      if (url.endsWith('/api/folder_config')) {
        return Promise.resolve({
          data: {
            local_folders: ['01素材', '01素材/A机', '02剪辑'],
            davinci_folders: [],
            mapping: {},
          },
        });
      }
      return Promise.resolve({ data: {} });
    });

    render(
      <FolderConfigGraph
        apiBaseUrl="http://localhost:8000"
        activePage="local"
        setActivePage={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByText('01素材'));
    expect(screen.getByText('A机')).toBeTruthy();

    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    expect(screen.queryByText('A机')).toBeNull();

    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(screen.getByText('A机')).toBeTruthy();
  });

  it('inserts a Command N sibling below the selected folder and selects the new folder', async () => {
    render(
      <FolderConfigGraph
        apiBaseUrl="http://localhost:8000"
        activePage="local"
        setActivePage={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByText('01素材'));
    fireEvent.keyDown(window, { key: 'n', metaKey: true });

    await waitFor(() => {
      expect(screen.getByDisplayValue('未命名文件夹')).toBeTruthy();
    });
    expect(axios.post).toHaveBeenLastCalledWith(
      'http://localhost:8000/api/folder_config',
      expect.objectContaining({
        local_folders: ['01素材', '未命名文件夹', '02剪辑'],
      }),
    );
  });

  it('closes rename mode when selecting another folder', async () => {
    render(
      <FolderConfigGraph
        apiBaseUrl="http://localhost:8000"
        activePage="local"
        setActivePage={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByText('01素材'));
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(screen.getByDisplayValue('01素材')).toBeTruthy();

    fireEvent.click(screen.getByText('02剪辑'));

    expect(screen.queryByDisplayValue('01素材')).toBeNull();
    expect(screen.getByText('02剪辑').closest('[data-folder-tree-item]').style.background).toBe('var(--mac-accent)');
  });

  it('copies the local folder structure into the DaVinci folder tree', async () => {
    render(
      <FolderConfigGraph
        apiBaseUrl="http://localhost:8000"
        activePage="davinci"
        setActivePage={vi.fn()}
      />,
    );

    await screen.findByText('媒体池箱结构');
    fireEvent.click(screen.getByText('复制本地结构'));

    await waitFor(() => {
      expect(axios.post).toHaveBeenLastCalledWith(
        'http://localhost:8000/api/folder_config',
        expect.objectContaining({
          local_folders: ['01素材', '02剪辑'],
          davinci_folders: ['01素材', '02剪辑'],
        }),
      );
    });
  });

  it('preserves the Resolve media pool read order when importing from the current project', async () => {
    axios.get.mockImplementation((url) => {
      if (url.endsWith('/api/status')) {
        return Promise.resolve({ data: { connected: true } });
      }
      if (url.endsWith('/api/folder_config')) {
        return Promise.resolve({
          data: {
            local_folders: [],
            davinci_folders: [],
            mapping: {},
          },
        });
      }
      if (url.endsWith('/api/project/media_pool_folders')) {
        return Promise.resolve({
          data: {
            folders: ['B素材', 'B素材/B2', 'A素材', '10交付', '2剪辑'],
          },
        });
      }
      return Promise.resolve({ data: {} });
    });

    render(
      <FolderConfigGraph
        apiBaseUrl="http://localhost:8000"
        activePage="davinci"
        setActivePage={vi.fn()}
      />,
    );

    await screen.findByText('媒体池箱结构');
    await waitFor(() => expect(axios.get).toHaveBeenCalledWith('http://localhost:8000/api/status'));

    fireEvent.click(screen.getByText('从当前项目导入'));
    await screen.findByText('选择导入层级 — 达芬奇');
    fireEvent.click(screen.getByText('确认导入'));

    await waitFor(() => {
      expect(axios.post).toHaveBeenLastCalledWith(
        'http://localhost:8000/api/folder_config',
        expect.objectContaining({
          davinci_folders: ['B素材', 'B素材/B2', 'A素材', '10交付', '2剪辑'],
        }),
      );
    });
  });

  it('moves a DaVinci folder into another folder when dropped on the row body', async () => {
    axios.get.mockImplementation((url) => {
      if (url.endsWith('/api/status')) {
        return Promise.resolve({ data: { connected: true } });
      }
      if (url.endsWith('/api/folder_config')) {
        return Promise.resolve({
          data: {
            local_folders: [],
            davinci_folders: ['A素材', 'B素材'],
            mapping: {},
          },
        });
      }
      return Promise.resolve({ data: {} });
    });

    render(
      <FolderConfigGraph
        apiBaseUrl="http://localhost:8000"
        activePage="davinci"
        setActivePage={vi.fn()}
      />,
    );

    const sourceLabel = await screen.findByText('A素材');
    const targetLabel = await screen.findByText('B素材');
    const targetRow = targetLabel.closest('[data-folder-tree-item]');
    targetRow.getBoundingClientRect = vi.fn(() => ({
      top: 100,
      bottom: 160,
      height: 60,
      left: 0,
      right: 300,
      width: 300,
      x: 0,
      y: 100,
      toJSON: () => {},
    }));

    fireEvent.mouseDown(sourceLabel, { button: 0, clientX: 40, clientY: 50 });
    fireEvent.mouseMove(targetRow, { clientX: 160, clientY: 130 });
    fireEvent.mouseUp(window);

    await waitFor(() => {
      expect(axios.post).toHaveBeenLastCalledWith(
        'http://localhost:8000/api/folder_config',
        expect.objectContaining({
          davinci_folders: ['B素材', 'B素材/A素材'],
        }),
      );
    });
  });
});
