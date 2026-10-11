export const SYSTEM_DAVINCI_FOLDERS = ['时间线', '时间线备份'];

const collator = new Intl.Collator(['zh-CN', 'en-US'], {
  numeric: true,
  sensitivity: 'base',
});

export function naturalCompare(a, b) {
  return collator.compare(String(a || ''), String(b || ''));
}

export function uniquePreserveOrder(values) {
  const seen = new Set();
  const result = [];
  (values || []).forEach((value) => {
    if (!value || seen.has(value)) return;
    seen.add(value);
    result.push(value);
  });
  return result;
}

export function sortLocalFolderPaths(paths) {
  return uniquePreserveOrder(paths).sort((a, b) => {
    const aParts = String(a).split('/');
    const bParts = String(b).split('/');
    const max = Math.max(aParts.length, bParts.length);
    for (let i = 0; i < max; i += 1) {
      if (aParts[i] === undefined) return -1;
      if (bParts[i] === undefined) return 1;
      const compared = naturalCompare(aParts[i], bParts[i]);
      if (compared !== 0) return compared;
    }
    return 0;
  });
}

export function mergeLocalFolders(existingPaths, importedPaths) {
  return sortLocalFolderPaths([...(existingPaths || []), ...(importedPaths || [])]);
}

export function mergeDavinciFolders(existingPaths, importedPaths) {
  return uniquePreserveOrder([...(existingPaths || []), ...(importedPaths || [])]);
}

export function appendSystemDavinciFolders(paths) {
  const regular = uniquePreserveOrder(paths).filter((path) => !SYSTEM_DAVINCI_FOLDERS.includes(path));
  return uniquePreserveOrder([...regular, ...SYSTEM_DAVINCI_FOLDERS]);
}

export function getAllParentPaths(paths, { sort = false } = {}) {
  const allPaths = new Set(paths || []);
  (paths || []).forEach((path) => {
    const parts = String(path).split('/');
    let currentPath = '';
    for (let i = 0; i < parts.length - 1; i += 1) {
      currentPath = currentPath ? `${currentPath}/${parts[i]}` : parts[i];
      allPaths.add(currentPath);
    }
  });
  const result = Array.from(allPaths);
  return sort ? sortLocalFolderPaths(result) : result;
}

export function getPathDepth(path) {
  if (!path || path === 'ROOT') return 0;
  return String(path).split('/').filter(Boolean).length;
}

function stripLeadingFolderNumber(segment) {
  return String(segment || '').replace(/^\s*(?:\d{2,}|\d+[\s._\-、)）]+)\s*/u, '');
}

function normalizeNameForMatch(value) {
  return stripLeadingFolderNumber(value)
    .toLowerCase()
    .replace(/[\s._\-—–/\\、，,()（）[\]【】]+/gu, '');
}

function normalizePathForMatch(path) {
  return String(path || '')
    .split('/')
    .map(normalizeNameForMatch)
    .filter(Boolean)
    .join('/');
}

function levenshteinDistance(a, b) {
  const left = Array.from(a || '');
  const right = Array.from(b || '');
  const rows = left.length + 1;
  const cols = right.length + 1;
  const matrix = Array.from({ length: rows }, () => Array(cols).fill(0));

  for (let i = 0; i < rows; i += 1) matrix[i][0] = i;
  for (let j = 0; j < cols; j += 1) matrix[0][j] = j;

  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost,
      );
    }
  }

  return matrix[left.length][right.length];
}

function similarityScore(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.86;
  const maxLength = Math.max(Array.from(a).length, Array.from(b).length);
  if (maxLength === 0) return 0;
  return 1 - (levenshteinDistance(a, b) / maxLength);
}

function scorePathMatch(localPath, davinciPath) {
  const localNormalizedPath = normalizePathForMatch(localPath);
  const davinciNormalizedPath = normalizePathForMatch(davinciPath);
  const localLeaf = normalizeNameForMatch(String(localPath || '').split('/').pop());
  const davinciLeaf = normalizeNameForMatch(String(davinciPath || '').split('/').pop());

  const pathScore = similarityScore(localNormalizedPath, davinciNormalizedPath);
  const leafScore = similarityScore(localLeaf, davinciLeaf) * 0.94;
  const depthPenalty = Math.abs(getPathDepth(localPath) - getPathDepth(davinciPath)) * 0.08;
  return Math.max(pathScore, leafScore) - depthPenalty;
}

function isCoveredByIncludeSub(path, mappings) {
  return Object.entries(mappings || {}).some(([mappedPath, config]) => {
    const includeSub = typeof config === 'object' ? config.include_sub !== false : true;
    return includeSub && path.startsWith(`${mappedPath}/`);
  });
}

export function buildAutoFolderMappings({
  localPaths,
  davinciPaths,
  existingMappings = {},
  maxDepth = 1,
  minScore = 0.78,
} = {}) {
  const candidates = getAllParentPaths(localPaths || [], { sort: true })
    .filter((path) => path && getPathDepth(path) > 0 && getPathDepth(path) <= maxDepth)
    .filter((path) => !existingMappings[path] && !isCoveredByIncludeSub(path, existingMappings));
  const targets = getAllParentPaths(davinciPaths || [], { sort: true })
    .filter((path) => path && getPathDepth(path) > 0 && getPathDepth(path) <= maxDepth)
    .filter((path) => !SYSTEM_DAVINCI_FOLDERS.includes(path));
  const usedTargets = new Set(
    Object.values(existingMappings || {}).map((config) => (
      typeof config === 'object' ? config.target : config
    )).filter(Boolean),
  );
  const nextMappings = {};
  const matches = [];

  candidates.forEach((localPath) => {
    let bestTarget = '';
    let bestScore = 0;

    targets.forEach((davinciPath) => {
      if (usedTargets.has(davinciPath)) return;
      const score = scorePathMatch(localPath, davinciPath);
      if (score > bestScore) {
        bestScore = score;
        bestTarget = davinciPath;
      }
    });

    if (bestTarget && bestScore >= minScore) {
      usedTargets.add(bestTarget);
      nextMappings[localPath] = {
        target: bestTarget,
        include_sub: getPathDepth(localPath) < maxDepth ? false : true,
      };
      matches.push({ localPath, davinciPath: bestTarget });
    }
  });

  return { mappings: nextMappings, matches };
}

export function canReorderFolderPaths(paths, sourcePath, targetPath, position = 'before') {
  const folders = paths || [];
  if (!sourcePath || !targetPath || sourcePath === targetPath || targetPath === 'ROOT') return false;
  if (targetPath.startsWith(`${sourcePath}/`)) return false;
  if (!folders.some((path) => path === sourcePath || path.startsWith(`${sourcePath}/`))) return false;
  if (!folders.some((path) => path === targetPath || path.startsWith(`${targetPath}/`))) return false;

  const targetParent = position === 'inside'
    ? targetPath
    : targetPath.split('/').slice(0, -1).join('/');
  const sourceLeaf = sourcePath.split('/').pop();
  const nextSourceRoot = targetParent ? `${targetParent}/${sourceLeaf}` : sourceLeaf;
  const remaining = folders.filter((path) => path !== sourcePath && !path.startsWith(`${sourcePath}/`));
  return !remaining.some((path) => path === nextSourceRoot || path.startsWith(`${nextSourceRoot}/`));
}

export function getFolderDropPosition(rect, clientY) {
  if (!rect) return 'before';
  const topEdge = rect.top + rect.height * 0.25;
  const bottomEdge = rect.top + rect.height * 0.75;
  if (clientY <= topEdge) return 'before';
  if (clientY >= bottomEdge) return 'after';
  return 'inside';
}

export function getFolderDropLineY(rect, position = 'before') {
  if (!rect) return null;
  if (position === 'inside') return null;
  return position === 'after' ? rect.bottom : rect.top;
}

export function getDragGhostPosition(clientX, clientY, dropLineY = null, previewHeight = 36) {
  const alignedY = Number.isFinite(dropLineY)
    ? Number(dropLineY) - Number(previewHeight || 0) / 2
    : Number(clientY || 0) - Number(previewHeight || 0) / 2;

  return {
    x: Math.max(12, Number(clientX || 0) + 14),
    y: Math.max(12, alignedY),
  };
}

export function reorderFolderPaths(paths, sourcePath, targetPath, position = 'before') {
  if (!canReorderFolderPaths(paths, sourcePath, targetPath, position)) {
    return paths || [];
  }

  const folders = paths || [];

  const sourceItems = folders.filter((path) => path === sourcePath || path.startsWith(`${sourcePath}/`));
  if (sourceItems.length === 0) return folders;

  const remaining = folders.filter((path) => !sourceItems.includes(path));
  const targetParent = position === 'inside'
    ? targetPath
    : targetPath.split('/').slice(0, -1).join('/');
  const sourceLeaf = sourcePath.split('/').pop();
  const nextSourceRoot = targetParent ? `${targetParent}/${sourceLeaf}` : sourceLeaf;
  const movedItems = sourceItems.map((path) => (
    path === sourcePath ? nextSourceRoot : `${nextSourceRoot}${path.slice(sourcePath.length)}`
  ));
  const targetIndex = remaining.findIndex((path) => path === targetPath || path.startsWith(`${targetPath}/`));
  if (targetIndex < 0) return [...remaining, ...sourceItems];

  let insertIndex = targetIndex;
  if (position === 'inside' || position === 'after') {
    insertIndex = targetIndex + 1;
    while (
      insertIndex < remaining.length
      && targetPath !== 'ROOT'
      && remaining[insertIndex].startsWith(`${targetPath}/`)
    ) {
      insertIndex += 1;
    }
  }

  const next = [...remaining];
  next.splice(insertIndex, 0, ...movedItems);
  return next;
}
