import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildSfxInsertToTimelinePayload, getInitialSfxExpandedFolders } from '../workspaces/sfx/SfxWorkspace.jsx';

describe('sound effects UI polish', () => {
  it('keeps library folders collapsed by default', () => {
    const tree = [
      {
        fullPath: '/library/Impacts',
        children: [{ fullPath: '/library/Impacts/Cinematic', children: [] }],
      },
      {
        fullPath: '/library/Whoosh',
        children: [{ fullPath: '/library/Whoosh/Fast', children: [] }],
      },
    ];

    expect([...getInitialSfxExpandedFolders(tree)]).toEqual([]);
  });

  it('defines high-contrast primary setting buttons for light mode', () => {
    const css = readFileSync(resolve(__dirname, '../App.css'), 'utf8');

    expect(css).toMatch(/\[data-theme='light'\]\s+\.sfx-set-btn\.primary\s*\{/);
    expect(css).toMatch(/\[data-theme='light'\]\s+\.sfx-set-btn\.primary[\s\S]*color:\s*#fff/i);
    expect(css).toMatch(/\[data-theme='light'\]\s+\.sfx-set-btn\.primary:hover:not\(:disabled\)\s*\{/);
  });

  it('keeps the sidebar top fade short enough to preserve the first section label', () => {
    const css = readFileSync(resolve(__dirname, '../App.css'), 'utf8');

    expect(css).toMatch(/\.main-workspace\s+\.nav-body\s*\{[\s\S]*black\s+10px/);
    expect(css).not.toMatch(/\.main-workspace\s+\.nav-body\s*\{[\s\S]*black\s+95%/);
  });

  it('sends source relative path when inserting an asset to the timeline', () => {
    const payload = buildSfxInsertToTimelinePayload(
      { path: '/library/Foley/Steps/wood.wav', relativePath: 'Foley/Steps/wood.wav' },
      { inPoint: 0.4, outPoint: 1.2 },
    );

    expect(payload).toMatchObject({
      source_path: '/library/Foley/Steps/wood.wav',
      source_relative_path: 'Foley/Steps/wood.wav',
      in_point: 0.4,
      out_point: 1.2,
      track_index: 0,
    });
  });
});
