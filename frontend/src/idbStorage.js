/**
 * IndexedDB 存储工具 — 替代 localStorage 存储大型转录数据
 * localStorage 限制 ~5-10MB，IndexedDB 可存储 GB 级别数据
 */

const DB_NAME = 'quickclip-storage';
const DB_VERSION = 1;
const STORE_NAME = 'transcript-workspace';

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'projectId' });
      }
    };
    request.onsuccess = (event) => resolve(event.target.result);
    request.onerror = (event) => reject(event.target.error);
  });
}

export async function saveWorkspace(projectId, data) {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.put({ projectId, data, updatedAt: Date.now() });
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve(true);
      tx.onerror = (e) => reject(e.target.error);
    });
  } catch (err) {
    // 降级到 localStorage
    try {
      const key = `quickclip:transcript-workspace:${projectId || 'default'}`;
      localStorage.setItem(key, JSON.stringify(data));
    } catch {}
    return false;
  }
}

export async function loadWorkspace(projectId) {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const result = await new Promise((resolve, reject) => {
      const req = store.get(projectId);
      req.onsuccess = () => resolve(req.result);
      req.onerror = (e) => reject(e.target.error);
    });
    if (result?.data) return result.data;
    // 回退到 localStorage 读取旧数据
    const key = `quickclip:transcript-workspace:${projectId || 'default'}`;
    const raw = localStorage.getItem(key);
    if (raw) {
      const data = JSON.parse(raw);
      // 迁移到 IndexedDB
      saveWorkspace(projectId, data);
      localStorage.removeItem(key);
      return data;
    }
    return null;
  } catch (err) {
    // 降级到 localStorage
    try {
      const key = `quickclip:transcript-workspace:${projectId || 'default'}`;
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }
}

export async function removeWorkspace(projectId) {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(projectId);
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve(true);
      tx.onerror = (e) => reject(e.target.error);
    });
  } catch {
    const key = `quickclip:transcript-workspace:${projectId || 'default'}`;
    localStorage.removeItem(key);
    return false;
  }
}
