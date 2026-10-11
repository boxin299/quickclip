/**
 * 阅流审阅平台 API — 通过后端代理获取评论数据
 *
 * 所有签名/重定向/解析在后端完成，前端仅调用 /api/yueliu/comments 一个端点。
 */

import axios from 'axios';
import { API_BASE_URL } from './config';

/**
 * 从审阅分享链接获取全部时间戳评论
 * @param {string} inputUrl - 审阅分享链接 (短链接或完整链接)
 * @param {object} options
 * @param {function} options.onProgress - 进度回调 (step, detail)
 * @returns {object} { shareCode, shareName, files }
 */
export async function fetchReviewComments(inputUrl, { onProgress } = {}) {
  const report = (step, detail) => onProgress && onProgress(step, detail);

  report('loading', '正在获取审阅评论…');

  try {
    const resp = await axios.get(`${API_BASE_URL}/api/yueliu/comments`, {
      params: { url: inputUrl },
      timeout: 30000,
    });

    if (resp.data?.ok) {
      report('done', '');
      return resp.data;
    }

    throw new Error(resp.data?.error || '获取评论失败');
  } catch (e) {
    if (e.response?.data?.error) {
      throw new Error(e.response.data.error);
    }
    if (e.code === 'ECONNABORTED') {
      throw new Error('请求超时，请检查后端是否运行');
    }
    throw new Error(e.message || '网络错误，请稍后重试');
  }
}
