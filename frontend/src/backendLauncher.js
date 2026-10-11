import { initApiBaseUrl } from './config';

let backendPromise = null;

export async function ensureBackendReady() {
  if (backendPromise) return backendPromise;

  backendPromise = (async () => {
    const isTauri = typeof window !== 'undefined' && window.__TAURI_INTERNALS__;
    if (!isTauri) return;

    const { invoke } = await import('@tauri-apps/api/core');
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('后端启动超时，请稍后重试')), 70000)
    );

    await Promise.race([invoke('login_and_start_backend'), timeout]);
    await initApiBaseUrl();
  })();

  backendPromise.finally(() => {
    backendPromise = null;
  });
  return backendPromise;
}
