 

export function compileRegex(pattern) {
  if (!pattern) return null;
  try {
    return new RegExp(pattern);
  } catch (e) {
    throw new Error(`Invalid regex: ${e.message}`);
  }
}

export async function fetchJson(url, token, signal) {
  const headers = { Accept: 'application/vnd.github+json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(url, { headers, signal });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${res.statusText}: ${text}`);
  }
  return res.json();
}

function isProbablyText(u8) {
  // Heuristic to skip binary files
  if (!u8 || !u8.length) return true;
  let zero = 0, high = 0;
  const sample = u8.subarray(0, Math.min(4096, u8.length));
  for (let i = 0; i < sample.length; i++) {
    const b = sample[i];
    if (b === 0) zero++;
    if (b < 7 || (b > 13 && b < 32) || b === 255) high++;
  }
  if (zero > 0) return false;
  if (high / sample.length > 0.3) return false;
  return true;
}

export async function fetchFileContent(owner, repo, path, ref, token, signal, maxBytes) {
  // Use the contents API to get base64 and detect size easily
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(ref)}`;
  const data = await fetchJson(url, token, signal);
  if (Array.isArray(data)) {
    throw new Error(`Path resolved to a directory unexpectedly: ${path}`);
  }
  if (data.size && maxBytes && data.size > maxBytes) {
    return { skipped: true, reason: `File too large (${data.size} bytes)`, path, size: data.size };
  }
  if (data.encoding !== 'base64' || typeof data.content !== 'string') {
    // Fallback: try raw
    const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(ref)}/${path}`;
    const res = await fetch(rawUrl, { signal, headers: token ? { Authorization: `Bearer ${token}` } : undefined });
    if (!res.ok) return { skipped: true, reason: `Failed to fetch raw`, path };
    const buf = new Uint8Array(await res.arrayBuffer());
    if (!isProbablyText(buf)) return { skipped: true, reason: 'Binary file', path };
    const text = new TextDecoder('utf-8', { fatal: false }).decode(buf);
    return { text, path, size: buf.length };
  }
  // Decode base64
  const binStr = atob(data.content.replace(/\n/g, ''));
  const u8 = new Uint8Array(binStr.length);
  for (let i = 0; i < binStr.length; i++) u8[i] = binStr.charCodeAt(i);
  if (!isProbablyText(u8)) return { skipped: true, reason: 'Binary file', path };
  const text = new TextDecoder('utf-8', { fatal: false }).decode(u8);
  return { text, path, size: data.size ?? u8.length };
}

export function formatSectionHeader(path, size) {
  const divider = '-'.repeat(80);
  const sizeStr = (typeof size === 'number') ? ` (${size} bytes)` : '';
  return `${divider}\n# FILE: ${path}${sizeStr}\n${divider}\n`;
}

export async function getRepoInfo(owner, repo, token, signal) {
  const url = `https://api.github.com/repos/${owner}/${repo}`;
  return fetchJson(url, token, signal);
}

export async function getTree(owner, repo, ref, token, signal) {
  const url = `https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`;
  return fetchJson(url, token, signal);
}

// Commits/compare helpers
export async function getLatestCommitSHA(owner, repo, ref, token, signal) {
  // GET /repos/{owner}/{repo}/commits/{ref}
  const url = `https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`;
  const data = await fetchJson(url, token, signal);
  return data?.sha;
}

export async function compareCommits(owner, repo, base, head, token, signal) {
  // GET /repos/{owner}/{repo}/compare/{base}...{head}
  const url = `https://api.github.com/repos/${owner}/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`;
  return fetchJson(url, token, signal);
}

// Ignore utilities (portable)
export const COMMON_IGNORES = [
  'node_modules/', 'dist/', 'build/', '.git/', '.github/', '.next/', 'out/', 'coverage/',
  '.venv/', 'venv/', '__pycache__/', 'target/', 'vendor/', 'bin/', 'obj/', '.idea/', '.vscode/'
];

export function shouldIgnorePath(path, { ignoreCommon = true, extraIgnores = [] } = {}) {
  const prefixes = [
    ...(ignoreCommon ? COMMON_IGNORES : []),
    ...(Array.isArray(extraIgnores) ? extraIgnores : [])
  ];
  return prefixes.some(prefix => path.startsWith(prefix));
}

// Headless dump function (no DOM). Returns { text, included, count }.
export async function dumpRepoHeadless({ owner, repo, regex = null, token = null, signal, maxBytes = 1024 * 1024, branch = null, ignoreCommon = true, extraIgnores = [] } = {}) {
  const rx = regex ? compileRegex(regex) : null;

  const repoInfo = await getRepoInfo(owner, repo, token, signal);
  const ref = (branch || repoInfo.default_branch || 'main');

  const treeRes = await getTree(owner, repo, ref, token, signal);
  if (!treeRes.tree || !Array.isArray(treeRes.tree)) throw new Error('Unexpected tree response');
  const files = treeRes.tree.filter(i => i.type === 'blob');

  const afterIgnore = files.filter(f => !shouldIgnorePath(f.path, { ignoreCommon, extraIgnores }));
  const candidateFiles = rx ? afterIgnore.filter(f => rx.test(f.path)) : afterIgnore;
  if (candidateFiles.length === 0) return { text: '', included: 0, count: 0 };

  let dumped = '';
  let included = 0;
  for (const file of candidateFiles) {
    if (signal?.aborted) throw new Error('Operation cancelled');
    try {
      const { text, skipped, path, size } = await fetchFileContent(owner, repo, file.path, ref, token, signal, maxBytes);
      if (!skipped && typeof text === 'string') {
        const headerSize = (typeof size === 'number') ? size : (typeof file.size === 'number' ? file.size : undefined);
        dumped += formatSectionHeader(path, headerSize) + text + '\n\n';
        included++;
      }
    } catch (e) {
      const headerSize = (typeof file.size === 'number') ? file.size : undefined;
      dumped += formatSectionHeader(file.path, headerSize) + `# Error: ${e.message}\n\n`;
    }
  }

  return { text: dumped.trim(), included, count: candidateFiles.length };
}
