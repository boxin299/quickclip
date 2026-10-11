import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { stat, readDir, mkdir, copyFile, remove } from '@tauri-apps/plugin-fs';

const tauriAPI = {
    selectVideo: async () => {
        try {
            const selected = await open({
                multiple: false,
                filters: [{
                    name: '视频文件',
                    extensions: ['mp4', 'mov', 'avi', 'mkv', 'webm']
                }, {
                    name: '所有文件',
                    extensions: ['*']
                }]
            });
            return selected;
        } catch (e) {
            console.error('Failed to select video:', e);
            return null;
        }
    },
    
    selectDirectory: async (options = {}) => {
        try {
            const selected = await open({
                directory: true,
                multiple: false,
                title: options.title || '选择需要处理的本地文件夹'
            });
            return selected;
        } catch (e) {
            console.error('Failed to select directory:', e);
            return null;
        }
    },
    
    getFileInfo: async (filePath) => {
        try {
            const fileStat = await stat(filePath);
            return {
                path: filePath,
                size: fileStat.size,
                lastModified: fileStat.mtime ? fileStat.mtime.getTime() : Date.now()
            };
        } catch (e) {
            console.error('Failed to get file info:', e);
            return { path: filePath, size: 0, lastModified: Date.now() };
        }
    },
    
    readLocalFolders: async (basePath, maxDepth = 2) => {
        const folders = [];
        
        async function traverse(currentPath, currentDepth, relativePath) {
            if (currentDepth > maxDepth) return;
            try {
                const entries = await readDir(currentPath);
                for (const entry of entries) {
                    if (entry.isDirectory && !entry.name.startsWith('.')) {
                        const newRelative = relativePath ? `${relativePath}/${entry.name}` : entry.name;
                        folders.push(newRelative);
                        // Recurse into directory
                        await traverse(`${currentPath}/${entry.name}`, currentDepth + 1, newRelative);
                    }
                }
            } catch (e) {
                console.error(`Failed to read dir ${currentPath}:`, e);
            }
        }
        
        await traverse(basePath, 1, '');
        return folders;
    },

    openBilibiliLogin: async () => {
        try {
            return await invoke('open_bilibili_login');
        } catch (e) {
            console.error('Bilibili login error:', e);
            return { success: false };
        }
    },

    revealInFinder: async (path) => {
        try {
            await invoke('reveal_in_finder', { path });
            return { status: 'success' };
        } catch (e) {
            console.error('revealInFinder failed:', e);
            return { status: 'error', message: `打开目录失败: ${e}` };
        }
    },

    copySoundFile: async (sourcePath, destDir) => {
        try {
            await mkdir(destDir, { recursive: true });
        } catch (e) {
            console.error('mkdir failed:', e);
            return { status: 'error', message: `创建目录失败: ${e}` };
        }
        const filename = sourcePath.split('/').pop() || 'sound_effect';
        const destPath = `${destDir}/${filename}`;
        try {
            await copyFile(sourcePath, destPath);
            return { status: 'success', dest_path: destPath, filename };
        } catch (e) {
            console.error('copyFile failed:', e);
            return { status: 'error', message: `复制文件失败: ${e}` };
        }
    },

    deleteSoundFile: async (filePath) => {
        try {
            await remove(filePath);
            return { status: 'success' };
        } catch (e) {
            console.error('remove failed:', e);
            return { status: 'error', message: `删除文件失败: ${e}` };
        }
    },
};

export default tauriAPI;
