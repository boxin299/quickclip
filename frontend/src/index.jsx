/**
 * React 应用入口文件
 */

// 在 React 渲染前设置 data-theme，确保 CSS 变量从一开始就是正确的
(function initTheme() {
    try {
        const saved = localStorage.getItem('app-theme');
        if (saved === 'dark' || saved === 'light') {
            document.documentElement.setAttribute('data-theme', saved);
        } else {
            const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
            document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');
        }
    } catch {}
})();

import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import './index.css';
import App from './App';
import tauriAPI from './tauriAPI';
import { initApiBaseUrl } from './config';

// 注入 Tauri API 到全局变量，以兼容原有的 Electron 代码
window.electronAPI = tauriAPI;

class RootErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, errorMessage: '' };
  }

  static getDerivedStateFromError(error) {
    return {
      hasError: true,
      errorMessage: error?.message || '未知错误',
    };
  }

  componentDidCatch(error, errorInfo) {
    console.error('应用运行时错误:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#111',
          color: '#fff',
          padding: '24px'
        }}>
          <div style={{
            width: '100%',
            maxWidth: '760px',
            background: 'rgba(255,255,255,0.05)',
            border: '1px solid rgba(255,255,255,0.12)',
            borderRadius: '16px',
            padding: '24px'
          }}>
            <div style={{ fontSize: '20px', fontWeight: 600, marginBottom: '12px' }}>页面运行异常</div>
            <div style={{ fontSize: '14px', lineHeight: 1.6, opacity: 0.9, marginBottom: '16px' }}>
              软件没有退出，但前端渲染时发生了错误。请把下面这条错误信息发给我，我继续定位。
            </div>
            <pre className="allow-text-selection" style={{
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              background: 'rgba(0,0,0,0.3)',
              borderRadius: '12px',
              padding: '16px',
              fontSize: '12px',
              margin: 0
            }}>
              {this.state.errorMessage}
            </pre>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

async function bootstrap() {
    await initApiBaseUrl();

    const container = document.getElementById('root');
    if (!container) return;
    const root = ReactDOM.createRoot(container);
    root.render(
        <React.StrictMode>
            <RootErrorBoundary>
                <BrowserRouter>
                    <App />
                </BrowserRouter>
            </RootErrorBoundary>
        </React.StrictMode>
    );
}

bootstrap();
