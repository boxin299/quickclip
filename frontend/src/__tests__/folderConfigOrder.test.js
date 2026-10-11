import { describe, expect, it } from 'vitest';
import {
  buildAutoFolderMappings,
  appendSystemDavinciFolders,
  canReorderFolderPaths,
  getFolderDropLineY,
  getFolderDropPosition,
  getDragGhostPosition,
  getAllParentPaths,
  mergeDavinciFolders,
  mergeLocalFolders,
  reorderFolderPaths,
  sortLocalFolderPaths,
} from '../components/folderConfigOrder';

describe('folderConfigOrder', () => {
  it('sorts imported local folders by number and first letter within each level', () => {
    expect(sortLocalFolderPaths([
      '10交付',
      '2剪辑',
      '1素材/B-roll',
      '1素材/A-roll',
      '01参考',
    ])).toEqual([
      '01参考',
      '1素材/A-roll',
      '1素材/B-roll',
      '2剪辑',
      '10交付',
    ]);
  });

  it('merges local imports into a natural sorted unique list', () => {
    expect(mergeLocalFolders(['10交付', '2剪辑'], ['1素材', '2剪辑'])).toEqual([
      '1素材',
      '2剪辑',
      '10交付',
    ]);
  });

  it('merges imported DaVinci folders without changing their read order', () => {
    expect(mergeDavinciFolders(['包装'], ['原始素材', '音频', '原始素材/B机'])).toEqual([
      '包装',
      '原始素材',
      '音频',
      '原始素材/B机',
    ]);
  });

  it('appends system DaVinci folders after the existing manual order', () => {
    expect(appendSystemDavinciFolders(['B素材', 'A素材', '时间线'])).toEqual([
      'B素材',
      'A素材',
      '时间线',
      '时间线备份',
    ]);
  });

  it('collects parent paths without reordering manual folder order', () => {
    expect(getAllParentPaths(['B/2', 'A/1'])).toEqual(['B/2', 'A/1', 'B', 'A']);
  });

  it('collects sorted parent paths with parents before children for selectors', () => {
    expect(getAllParentPaths([
      '02 剪辑',
      '01 原始素材/B机',
      '01 原始素材',
      '01 原始素材/A机',
    ], { sort: true })).toEqual([
      '01 原始素材',
      '01 原始素材/A机',
      '01 原始素材/B机',
      '02 剪辑',
    ]);
  });

  it('auto maps numbered local top-level folders to unnumbered DaVinci folders', () => {
    expect(buildAutoFolderMappings({
      localPaths: ['00 筹备', '01 原始素材', '02 代理素材', '03 音频'],
      davinciPaths: ['原始素材', '代理素材', '音频', '包装'],
      existingMappings: {},
      maxDepth: 1,
    })).toEqual({
      mappings: {
        '01 原始素材': { target: '原始素材', include_sub: true },
        '02 代理素材': { target: '代理素材', include_sub: true },
        '03 音频': { target: '音频', include_sub: true },
      },
      matches: [
        { localPath: '01 原始素材', davinciPath: '原始素材' },
        { localPath: '02 代理素材', davinciPath: '代理素材' },
        { localPath: '03 音频', davinciPath: '音频' },
      ],
    });
  });

  it('auto maps up to second-level paths when requested', () => {
    expect(buildAutoFolderMappings({
      localPaths: ['01 原始素材', '01 原始素材/A机', '01 原始素材/A机/卡1'],
      davinciPaths: ['原始素材', '原始素材/A机', '原始素材/A机/卡1'],
      existingMappings: {},
      maxDepth: 2,
    }).matches).toEqual([
      { localPath: '01 原始素材', davinciPath: '原始素材' },
      { localPath: '01 原始素材/A机', davinciPath: '原始素材/A机' },
    ]);
  });

  it('drags folders to a new position in the same level without nesting', () => {
    expect(reorderFolderPaths([
      'A',
      'A/child',
      'B',
      'C',
    ], 'C', 'A')).toEqual([
      'C',
      'A',
      'A/child',
      'B',
    ]);
  });

  it('can drag an earlier folder after a later sibling', () => {
    expect(reorderFolderPaths([
      'A',
      'A/child',
      'B',
      'C',
    ], 'A', 'B', 'after')).toEqual([
      'B',
      'A',
      'A/child',
      'C',
    ]);
  });

  it('nests a dragged folder when dropping it inside another folder', () => {
    expect(reorderFolderPaths([
      'A',
      'A/child',
      'B',
      'B/existing',
      'C',
    ], 'C', 'A', 'inside')).toEqual([
      'A',
      'A/child',
      'A/C',
      'B',
      'B/existing',
    ]);
  });

  it('does not allow dropping a folder into its own descendant', () => {
    const folders = ['A', 'A/child', 'B'];

    expect(reorderFolderPaths(folders, 'A', 'A/child', 'inside')).toEqual(folders);
    expect(canReorderFolderPaths(folders, 'A', 'A/child', 'inside')).toBe(false);
  });

  it('detects whether the pointer is in the before or after drop zone', () => {
    const rect = { top: 100, height: 40 };

    expect(getFolderDropPosition(rect, 110)).toBe('before');
    expect(getFolderDropPosition(rect, 120)).toBe('inside');
    expect(getFolderDropPosition(rect, 130)).toBe('after');
  });

  it('gets the visual insertion line height from the drop target edge', () => {
    const rect = { top: 100, bottom: 140 };

    expect(getFolderDropLineY(rect, 'before')).toBe(100);
    expect(getFolderDropLineY(rect, 'after')).toBe(140);
  });

  it('places the drag preview beside the pointer and vertically aligned to it', () => {
    expect(getDragGhostPosition(100, 200)).toEqual({ x: 114, y: 182 });
    expect(getDragGhostPosition(-20, -30)).toEqual({ x: 12, y: 12 });
  });

  it('aligns the drag preview vertically with the insertion line when available', () => {
    expect(getDragGhostPosition(100, 200, 140, 36)).toEqual({ x: 114, y: 122 });
  });
});
