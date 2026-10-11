import { lazy } from 'react';

export const workspaceRegistry = {
  sfx: {
    id: 'sfx',
    basePath: '/sfx',
    Component: lazy(() => import('./sfx/SfxWorkspace.jsx'))
  }
};

export function getWorkspaceKey(pathname) {
  if (pathname.startsWith(workspaceRegistry.sfx.basePath)) return workspaceRegistry.sfx.id;
  return 'main';
}
