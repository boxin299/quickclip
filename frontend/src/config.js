// API 地址 — 支持开发/生产环境动态端口发现
let _resolved = import.meta.env.VITE_API_BASE_URL || 'http://127.0.0.1:18000';

export let API_BASE_URL = _resolved;

function buildBaseUrl(port) {
    return `http://127.0.0.1:${port}`;
}

async function probePort(port, timeout = 300) {
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);
        const resp = await fetch(`${buildBaseUrl(port)}/api/status`, {
            signal: controller.signal,
            mode: 'cors',
        });
        clearTimeout(timer);
        if (!resp.ok) return null;
        const data = await resp.json();
        if (data.status === 'ok') return port;
    } catch {
        // 端口不可达或不是目标服务
    }
    return null;
}

export async function probeEndpoint(baseUrl, endpoint, timeout = 400) {
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);
        const resp = await fetch(`${baseUrl}${endpoint}`, {
            signal: controller.signal,
            mode: 'cors',
        });
        clearTimeout(timer);
        return resp.ok;
    } catch {
        return false;
    }
}

export async function findApiBaseUrlForEndpoint(endpoint, preferredBaseUrl = API_BASE_URL) {
    const candidates = [];
    if (preferredBaseUrl) {
        candidates.push(preferredBaseUrl.replace(/\/$/, ''));
    }
    for (let i = 0; i < 20; i += 1) {
        candidates.push(buildBaseUrl(18000 + i));
    }

    const uniqueCandidates = [...new Set(candidates)];
    for (const candidate of uniqueCandidates) {
        if (await probeEndpoint(candidate, endpoint)) {
            API_BASE_URL = candidate;
            return candidate;
        }
    }

    return preferredBaseUrl;
}

export async function initApiBaseUrl() {
    // 1) Tauri 模式：始终通过 invoke 获取后端真实端口（端口可能不是默认的 18000）
    if (typeof window !== 'undefined' && window.__TAURI_INTERNALS__) {
        try {
            const { invoke } = await import('@tauri-apps/api/core');
            const port = await invoke('get_backend_port');
            if (port && port > 0) {
                API_BASE_URL = `http://127.0.0.1:${port}`;
                return API_BASE_URL;
            }
        } catch {
            // Tauri invoke 不可用
        }
    }

    // 2) 环境变量已注入（dev-with-backend.sh 或非 Tauri 开发模式）
    if (import.meta.env.VITE_API_BASE_URL) {
        API_BASE_URL = import.meta.env.VITE_API_BASE_URL;
        return API_BASE_URL;
    }

    // 3) 浏览器开发模式：先快速试默认端口，失败再并行扫候选端口
    const defaultPort = await probePort(18000);
    if (defaultPort) {
        API_BASE_URL = buildBaseUrl(18000);
        return API_BASE_URL;
    }
    const candidates = Array.from({ length: 19 }, (_, i) => 18001 + i);
    const results = await Promise.all(candidates.map(p => probePort(p)));
    const found = results.find(p => p !== null);
    if (found) {
        API_BASE_URL = buildBaseUrl(found);
        console.log(`[config] 自动发现后端端口: ${found}`);
    }

    return API_BASE_URL;
}
