// Server-side commit for the Core Tune admin.
// The owner's GitHub PAT lives in Netlify env vars (never in a browser) and
// writes are gated behind a shared ADMIN_PASSWORD. No client-side token needed.

const OWNER = process.env.GITHUB_OWNER || 'Aniruddh927';
const REPO = process.env.GITHUB_REPO || 'coretune';
const BRANCH = process.env.GITHUB_BRANCH || 'main';

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
  const message = body.message || 'chore: update catalog via admin';
  if (!Array.isArray(files) || files.length === 0) return json(400, { error: 'files required' });

  try {
    const sha = await commitChanges(message, files, PAT);
    return json(200, { ok: true, sha });
  } catch (e) {
    return json(500, { error: String((e && e.message) || e) });
  }
};

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
