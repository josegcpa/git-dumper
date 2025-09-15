import { compileRegex, fetchFileContent, formatSectionHeader, getRepoInfo, getTree, getLatestCommitSHA, compareCommits } from './lib.js';
// Git Dumper - Client-side implementation
// Uses GitHub REST API to list files and dump text contents with optional regex filtering.

(function () {
  const els = {
    repoUrl: document.getElementById('repoUrl'),
    branch: document.getElementById('branch'),
    regex: document.getElementById('regex'),
    token: document.getElementById('token'),
    maxSizeKB: document.getElementById('maxSizeKB'),
    ignoreCommon: document.getElementById('ignoreCommon'),
    dumpBtn: document.getElementById('dumpBtn'),
    cancelBtn: document.getElementById('cancelBtn'),
    clearBtn: document.getElementById('clearBtn'),
    clearLocalStorageBtn: document.getElementById('clearLocalStorageBtn'),
    copyBtn: document.getElementById('copyBtn'),
    downloadBtn: document.getElementById('downloadBtn'),
    output: document.getElementById('output'),
    status: document.getElementById('status'),
    progress: document.getElementById('progress'),
  };

  let abortController = null;
  const DEFAULT_MAX_FILE_BYTES = 1024 * 1024; // 1MB default safety cap
  const COMMON_IGNORES = [
    'node_modules/', 'dist/', 'build/', '.git/', '.github/', '.next/', 'out/', 'coverage/',
    '.venv/', 'venv/', '__pycache__/', 'target/', 'vendor/', 'bin/', 'obj/', '.idea/', '.vscode/'
  ];

  // Simple localStorage cache per owner/repo/ref
  function cacheKey(owner, repo, ref) {
    return `git-dumper:${owner}/${repo}@${ref}`;
  }
  function loadCache(owner, repo, ref) {
    try {
      const raw = localStorage.getItem(cacheKey(owner, repo, ref));
      if (!raw) return null;
      const data = JSON.parse(raw);
      // { files: { [path]: string }, owner, repo, ref, commit }
      if (!data || typeof data !== 'object') return null;
      if (!data.files || typeof data.files !== 'object') data.files = {};
      return data;
    } catch { return null; }
  }
  function saveCache(owner, repo, ref, obj) {
    try { localStorage.setItem(cacheKey(owner, repo, ref), JSON.stringify(obj)); } catch { /* ignore */ }
  }

  function setStatus(msg) {
    els.status.innerHTML = msg || '';
  }
  function setProgress(percent) {
    if (percent == null) {
      els.progress.classList.add('hidden');
    } else {
      els.progress.classList.remove('hidden');
      els.progress.value = Math.max(0, Math.min(100, percent));
    }
  }
  function enableUI(enabled) {
    els.dumpBtn.disabled = !enabled;
    els.cancelBtn.disabled = enabled;
    els.repoUrl.disabled = !enabled;
    els.branch.disabled = !enabled;
    els.regex.disabled = !enabled;
    els.token.disabled = !enabled;
    if (els.maxSizeKB) els.maxSizeKB.disabled = !enabled;
    if (els.ignoreCommon) els.ignoreCommon.disabled = !enabled;
  }
  function clearOutput() {
    els.output.value = '';
    setStatus('');
    setProgress(null);
  }

  function parseRepoUrl(url) {
    try {
      const u = new URL(url);
      // Support URLs like https://github.com/OWNER/REPO or with .git suffix
      if (u.hostname !== 'github.com') return null;
      const parts = u.pathname.replace(/\.git$/i, '').split('/').filter(Boolean);
      if (parts.length < 2) return null;
      const [owner, repo] = parts;
      return { owner, repo };
    } catch (e) {
      return null;
    }
  }

  // fetchJson, isProbablyText and other helpers now live in lib.js and are imported above.

  function updateDownloadLink(content, owner, repo, ref) {
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    els.downloadBtn.href = url;
    const name = `${owner}-${repo}-${ref}-dump.txt`;
    els.downloadBtn.download = name;
    els.downloadBtn.textContent = `Download ${name}`;
  }

  function shouldIgnorePath(path) {
    if (!els.ignoreCommon || !els.ignoreCommon.checked) return false;
    return COMMON_IGNORES.some(prefix => path.startsWith(prefix));
  }

  function getMaxBytes() {
    const n = parseInt(els.maxSizeKB?.value, 10);
    if (Number.isFinite(n) && n > 0) return n * 1024;
    return DEFAULT_MAX_FILE_BYTES;
  }

  async function dumpRepo() {
    const url = els.repoUrl.value.trim();
    if (!url) { setStatus('Please enter a GitHub repository URL.'); return; }
    const parsed = parseRepoUrl(url);
    if (!parsed) { setStatus('Invalid GitHub repository URL. Expected https://github.com/OWNER/REPO'); return; }
    const { owner, repo } = parsed;

    let regex = null;
    try {
      regex = compileRegex(els.regex.value.trim());
    } catch (e) {
      setStatus(e.message);
      setProgress(null);
      return;
    }

    enableUI(false);
    setStatus('Fetching repository info...');
    setProgress(1);

    abortController = new AbortController();
    const signal = abortController.signal;
    const token = els.token.value.trim() || null;
    const maxBytes = getMaxBytes();

    try {
      const repoInfo = await getRepoInfo(owner, repo, token, signal);
      const ref = (els.branch.value.trim() || repoInfo.default_branch || 'main');
      setStatus(`Listing files from ${owner}/${repo}@${ref}...`);

      const treeRes = await getTree(owner, repo, ref, token, signal);
      if (!treeRes.tree || !Array.isArray(treeRes.tree)) throw new Error('Unexpected tree response');
      const files = treeRes.tree.filter(i => i.type === 'blob');

      // Apply ignore patterns first, then regex
      const afterIgnore = files.filter(f => !shouldIgnorePath(f.path));
      const candidateFiles = regex ? afterIgnore.filter(f => regex.test(f.path)) : afterIgnore;
      if (candidateFiles.length === 0) {
        setStatus('No files matched the criteria.');
        setProgress(null);
        enableUI(true);
        return;
      }

      // Fetch only what changed using commit comparison and use cache for the rest
      const latestSha = await getLatestCommitSHA(owner, repo, ref, token, signal);
      let cache = loadCache(owner, repo, ref);
      let changedSet = null;
      if (cache && cache.commit && latestSha && cache.commit !== latestSha) {
        try {
          const cmp = await compareCommits(owner, repo, cache.commit, latestSha, token, signal);
          if (Array.isArray(cmp.files)) {
            changedSet = new Set(cmp.files.map(f => f.filename));
            // handle removals/renames
            cmp.files.forEach(f => {
              if (f.status === 'removed' && cache.files) delete cache.files[f.filename];
              if (f.status === 'renamed' && f.previous_filename && cache.files) delete cache.files[f.previous_filename];
            });
          }
        } catch (_) {
          // Fallback to refetch all
          changedSet = null;
        }
      } else if (cache && cache.commit && latestSha && cache.commit === latestSha) {
        // No changes between cached commit and latest; use cache for all
        changedSet = new Set();
      }

      if (!cache) cache = { files: {}, owner, repo, ref, commit: latestSha || null };

      let dumped = '';
      let processed = 0;
      let included = 0;
      for (const file of candidateFiles) {
        if (signal.aborted) throw new Error('Operation cancelled');
        const useCache = changedSet && !changedSet.has(file.path) && typeof cache.files[file.path] === 'string';
        let content = null;
        let headerSize = (typeof file.size === 'number') ? file.size : undefined;

        if (useCache) {
          content = cache.files[file.path];
        } else {
          setStatus(`Fetching ${file.path} (${processed + 1}/${candidateFiles.length})...`);
          try {
            const { text, skipped, path, size } = await fetchFileContent(owner, repo, file.path, ref, token, signal, maxBytes);
            if (!skipped && typeof text === 'string') {
              content = text;
              headerSize = (typeof size === 'number') ? size : headerSize;
              cache.files[file.path] = text;
            } else if (skipped) {
              content = `# Skipped: ${file.path}`;
            }
          } catch (e) {
            content = `# Error: ${e.message}`;
          }
        }

        if (typeof content === 'string') {
          dumped += formatSectionHeader(file.path, headerSize) + content + '\n\n';
          included++;
        }

        processed++;
        setProgress(Math.round((processed / candidateFiles.length) * 100));
      }

      // Update cache commit pointer
      if (latestSha) cache.commit = latestSha;
      saveCache(owner, repo, ref, cache);

      els.output.value = dumped.trim();
      console.log(localStorage)
      setStatus(`Done. Included ${included} files out of ${candidateFiles.length}. (cached: ${Object.keys(cache.files||{}).length})`);
      setProgress(null);
      updateDownloadLink(els.output.value, owner, repo, ref);
    } catch (e) {
      if (e.name === 'AbortError') {
        setStatus('Cancelled.');
        setProgress(null);
      } else {
        if (e.message.includes('403')) {
          console.log(e.message);
          setStatus("Error: API rate limit exceeded. Authenticated requests get a higher rate limit. Check out the <a href=\"https://docs.github.com/en/rest/overview/resources-in-the-rest-api#rate-limiting\" target='_blank'>documentation</a> for more details.");
          setProgress(null);
        } else {
          setStatus(`Error: ${e.message}`);
          setProgress(null);
        }
      }
    } finally {
      enableUI(true);
      abortController = null;
    }
  }

  // Wire up UI
  els.dumpBtn.addEventListener('click', () => {
    dumpRepo();
  });
  els.cancelBtn.addEventListener('click', () => {
    if (abortController) abortController.abort();
  });
  els.clearBtn.addEventListener('click', () => {
    clearOutput();
  });
  els.copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(els.output.value || '');
      setStatus('Copied to clipboard.');
    } catch (e) {
      setStatus('Failed to copy. Select and copy manually.');
    }
  });
  els.clearLocalStorageBtn.addEventListener('click', () => {
    localStorage.clear();
    setStatus('Local storage cleared.');
  });

  // Enhance UX: prefill regex with common example
  if (!els.regex.value) {
    els.regex.value = '\\.(py|js|ts|tsx|jsx|json|md|txt|css|html)$';
  }

  // Allow URL-driven invocation for static "API-like" usage
  async function autoRunFromQuery() {
    const q = new URLSearchParams(window.location.search);
    const owner = q.get('owner');
    const repo = q.get('repo');
    if (!owner || !repo) return;

    // Prefill form from query
    els.repoUrl.value = `https://github.com/${owner}/${repo}`;
    const branch = q.get('branch');
    const regex = q.get('regex');
    const maxSizeKB = q.get('maxSizeKB');
    const ignoreCommon = q.get('ignoreCommon'); // '1' | '0' | null
    const token = q.get('token'); // optional; use only if you understand the risks
    if (branch) els.branch.value = branch;
    if (regex) els.regex.value = regex;
    if (maxSizeKB && Number.isFinite(+maxSizeKB)) els.maxSizeKB.value = String(+maxSizeKB);
    if (ignoreCommon !== null) els.ignoreCommon.checked = ignoreCommon !== '0';
    if (token) els.token.value = token;

    const mode = q.get('mode'); // 'raw' | 'download' | null
    await dumpRepo();

    let text = els.output.value || '';
    if (!text) {
      // Surface status text in raw mode if dump failed/empty
      text = els.status?.innerText || '';
    }
    if (mode === 'raw') {
      // Replace page content with plain text
      document.head.innerHTML = '';
      document.body.innerHTML = '';
      const pre = document.createElement('pre');
      pre.style.whiteSpace = 'pre-wrap';
      pre.style.margin = '0';
      pre.textContent = text;
      document.body.appendChild(pre);
      document.title = `${owner}/${repo} dump`;
    } else if (mode === 'download') {
      // Trigger download of the prepared blob link
      els.downloadBtn?.click();
    }
  }

  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', () => { autoRunFromQuery().catch(() => {}); });
  } else {
    // DOM is already ready (e.g., module at end of body); run now
    autoRunFromQuery().catch(() => {});
  }
})();
