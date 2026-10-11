import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TranscriptProjectTabs } from '../components/TranscriptProjectManager';

describe('TranscriptProjectTabs', () => {
  const projects = [
    { id: 'one', name: '项目一', segment_count: 3 },
    { id: 'two', name: '项目二', segment_count: 5 },
  ];

  it('prevents project actions while disabled', () => {
    const onSwitch = vi.fn();
    const onClose = vi.fn();
    const onRefresh = vi.fn();
    const onManage = vi.fn();

    const { container } = render(
      <TranscriptProjectTabs
        projects={projects}
        activeId="one"
        resolveStatus={{ project: '剪辑项目' }}
        disabled
        disabledReason="自动同步字幕运行中，请先关闭后再切换项目"
        onSwitch={onSwitch}
        onClose={onClose}
        onRefresh={onRefresh}
        onManage={onManage}
      />,
    );

    fireEvent.click(screen.getByText('项目二'));
    fireEvent.click(screen.getAllByRole('button')[0]);
    fireEvent.click(screen.getByLabelText('刷新转录项目列表'));
    fireEvent.click(screen.getByText('管理'));

    expect(onSwitch).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(onRefresh).not.toHaveBeenCalled();
    expect(onManage).not.toHaveBeenCalled();
  });
});
