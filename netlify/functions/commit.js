// Server-side commit for the Core Tune admin.
// The owner's GitHub PAT lives in Netlify env vars (never in a browser) and
// writes are gated behind a shared ADMIN_PASSWORD. File paths are strictly
// whitelisted so a leaked password can only touch catalog files, not HTML/JS/
// workflows.

const OWNER = process.env.GITHUB_OWNER || 'Aniruddh927';
const REPO = process.env.GITHUB_REPO || 'coretune';
const BRANCH = process.env.GITHUB_BRANCH || 'main';

const MAX_TEXT_BYTES = 1024 * 1024;       // 1 MB
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;  // 5 MB
const MAX_FILES = 100;

// magic-byte prefix for each allowed image type (content must match extension)
const IMAGE_MAGIC = {
  png:  [0x89, 0x50, 0x4e, 0x47],
  jpg:  [0xff, 0xd8, 0xff],
  jpeg: [0xff, 0xd8, 0xff],
  gif:  [0x47, 0x49, 0x46, 0x38],
  webp: [0x52, 0x49, 0x46, 0x46],
};

const json = (status, body) => ({
  statusCode: status,
  headers: {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  },
  body: JSON.stringify(body),
});

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
      body: '',
    };
  }
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });

  const PAT = process.env.GITHUB_PAT;
  const PASSWORD = process.env.ADMIN_PASSWORD;
  if (!PAT || !PASSWORD) {
    return json(500, { error: 'Server not configured: set GITHUB_PAT and ADMIN_PASSWORD env vars' });
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }

  if (body.action === 'verify') {
    return body.password === PASSWORD ? json(200, { ok: true }) : json(401, { error: 'Incorrect password' });
  }

  if (body.password !== PASSWORD) return json(401, { error: 'Incorrect password' });

  const files = body.files;
  const message = (typeof body.message === 'string' && body.message.slice(0, 200)) || 'chore: update catalog via admin';
  if (!Array.isArray(files) || files.length === 0) return json(400, { error: 'files required' });
  if (files.length > MAX_FILES) return json(400, { error: 'Too many files' });

  try { validateFiles(files); }
  catch (e) { return json(400, { error: String((e && e.message) || e) }); }

  try {
    const sha = await commitChanges(message, files, PAT);
    return json(200, { ok: true, sha });
  } catch (e) {
    return json(500, { error: String((e && e.message) || e) });
  }
};

function validateFiles(files) {
  for (const f of files) {
    if (!f || typeof f.path !== 'string' || f.path.length > 300) {
      throw new Error('Invalid file entry');
    }

    if (f.path === 'data/products.json' || f.path === 'data/site.json') {
      if (typeof f.content !== 'string') throw new Error('Invalid content for ' + f.path);
      if (Buffer.byteLength(f.content, 'utf8') > MAX_TEXT_BYTES) throw new Error('File too large: ' + f.path);
      continue;
    }

    const m = /^images\/[A-Za-z0-9._-]+\.(png|jpe?g|webp|gif)$/i.exec(f.path);
    if (!m) throw new Error('Path not allowed: ' + f.path);
    const ext = m[1].toLowerCase();

    if (f.content === null) continue; // image deletion

    if (!f.base64 || typeof f.content !== 'string') throw new Error('Image must be base64: ' + f.path);
    const buf = Buffer.from(f.content, 'base64');
    if (buf.length > MAX_IMAGE_BYTES) throw new Error('Image too large: ' + f.path);

    const magic = IMAGE_MAGIC[ext];
    if (magic && buf.length >= magic.length) {
      for (let i = 0; i < magic.length; i++) {
        if (buf[i] !== magic[i]) throw new Error('Image content does not match extension: ' + f.path);
      }
    }
  }
}

async function ghApi(path, opts, token) {
  const headers = {
    Authorization: 'Bearer ' + token,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (opts.body) headers['Content-Type'] = 'application/json';
  const res = await fetch('https://api.github.com' + path, {
    method: opts.method || 'GET',
    headers,
    body: opts.body,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) throw new Error((data && data.message) || ('GitHub API ' + res.status));
  return data;
}

function isFastForwardError(e) {
  return /fast.?forward|non-fast|behind|rejected|reference update/i.test(String((e && e.message) || ''));
}

async function commitChanges(message, files, token) {
  const base = `/repos/${encodeURIComponent(OWNER)}/${encodeURIComponent(REPO)}`;
  const MAX_RETRIES = 3;
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const ref = await ghApi(`${base}/git/ref/heads/${encodeURIComponent(BRANCH)}`, {}, token);
      const baseSha = ref.object.sha;
      const baseCommit = await ghApi(`${base}/git/commits/${baseSha}`, {}, token);
      const baseTree = baseCommit.tree.sha;

      const tree = [];
      for (const f of files) {
        if (f.content === null) {
          tree.push({ path: f.path, mode: '100644', type: 'blob', sha: null });
        } else if (f.base64) {
          const blob = await ghApi(`${base}/git/blobs`, {
            method: 'POST',
            body: JSON.stringify({ content: f.content, encoding: 'base64' }),
          }, token);
          tree.push({ path: f.path, mode: '100644', type: 'blob', sha: blob.sha });
        } else {
          tree.push({ path: f.path, mode: '100644', type: 'blob', content: f.content });
        }
      }

      const treeRes = await ghApi(`${base}/git/trees`, {
        method: 'POST',
        body: JSON.stringify({ base_tree: baseTree, tree }),
      }, token);
      const commitRes = await ghApi(`${base}/git/commits`, {
        method: 'POST',
        body: JSON.stringify({ message, tree: treeRes.sha, parents: [baseSha] }),
      }, token);
      await ghApi(`${base}/git/refs/heads/${encodeURIComponent(BRANCH)}`, {
        method: 'PATCH',
        body: JSON.stringify({ sha: commitRes.sha, force: false }),
      }, token);
      return commitRes.sha;
    } catch (e) {
      lastErr = e;
      if (isFastForwardError(e) && attempt < MAX_RETRIES) continue;
      throw e;
    }
  }
  throw lastErr;
}
