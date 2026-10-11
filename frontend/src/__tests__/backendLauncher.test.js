import { describe, expect, it } from 'vitest';
import { ensureBackendReady } from '../backendLauncher';

describe('backend launcher', () => {
  it('resolves in the browser without requiring remote gates', async () => {
    delete window.__TAURI_INTERNALS__;
    delete window.__TAURI__;

    await expect(ensureBackendReady()).resolves.toBeUndefined();
  });
});
