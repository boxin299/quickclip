import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('ExportView subfolder animation', () => {
  it('uses fixed max-height transitions instead of measured auto-height for subfolder options', () => {
    const source = readFileSync(resolve(__dirname, '../components/ExportView.jsx'), 'utf8');
    const subfolderBlock = source.slice(
      source.indexOf('key="subfolder-options"'),
      source.indexOf('<AnimatePresence mode="wait">'),
    );
    const customInputBlock = source.slice(
      source.indexOf('key="custom-subfolder-input"'),
      source.indexOf('placeholder="输入子文件夹名称..."'),
    );

    expect(source).toContain('SUBFOLDER_OPTIONS_MAX_HEIGHT');
    expect(source).toContain('CUSTOM_SUBFOLDER_INPUT_MAX_HEIGHT');
    expect(subfolderBlock).toContain('maxHeight');
    expect(customInputBlock).toContain('maxHeight');
    expect(subfolderBlock).not.toContain("height: 'auto'");
    expect(subfolderBlock).not.toContain('paddingTop: { duration');
    expect(subfolderBlock).not.toContain('paddingBottom: { duration');
    expect(customInputBlock).not.toContain("height: 'auto'");
    expect(customInputBlock).not.toContain('marginTop: 0');
  });
});
