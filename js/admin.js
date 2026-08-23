'use strict';

/* ==========================================================================
   GreyWatt admin — edit catalog, commit straight to GitHub via the Trees API.
   Token stays in localStorage; content changes land as a single commit.
   ========================================================================== */

const admin = {
  token: '',
  owner: '',
  repo: '',
  branch: 'main',
  site: {},
  products: [],
  images: [],          // [{ name, path, sha }] from images/ dir
  refImages: new Set(), // image paths referenced by products at load
  dirty: false,
};

const TOKEN_KEY = 'gw_admin_token';
const els = {};

const AVAIL_OPTIONS = ['in_stock', 'low_stock', 'out_of_stock', 'preorder'];

function $(id) { return document.getElementById(id); }

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function showToast(msg) {
  els.toast.textContent = msg;
  els.toast.classList.add('show');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => els.toast.classList.remove('show'), 2600);
}

function splitList(v) { return String(v || '').split(',').map((s) => s.trim()).filter(Boolean); }

/* ---- GitHub API helpers ----------------------------------------------- */

function enc(s) { return encodeURIComponent(String(s)); }

async function gh(path, opts = {}) {
  const headers = {
    Authorization: 'Bearer ' + admin.token,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (opts.body) headers['Content-Type'] = 'application/json';
  const res = await fetch('https://api.github.com' + path, {
    method: opts.method || 'GET',
    headers,
    body: opts.body,
  });
  if (res.status === 404) return { notFound: true };
  const text = await res.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = text; } }
  if (!res.ok) {
    const msg = data && data.message ? data.message : ('GitHub API ' + res.status);
    throw new Error(msg);
  }
  return data;
}

function repoPath(p) {
  return p.split('/').map(enc).join('/');
}

async function readFileText(path) {
  const data = await gh(`/repos/${enc(admin.owner)}/${enc(admin.repo)}/contents/${repoPath(path)}`);
  if (data.notFound) return null;
  if (typeof data.content !== 'string') return null;
  const bin = atob(data.content.replace(/\n/g, ''));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

async function listImages() {
  const data = await gh(`/repos/${enc(admin.owner)}/${enc(admin.repo)}/contents/${repoPath('images')}`);
  if (data.notFound) return [];
  if (!Array.isArray(data)) return [];
  return data.filter((f) => f.type === 'file').map((f) => ({ name: f.name, path: f.path, sha: f.sha }));
}

async function commitChanges(message, files) {
  const base = `/repos/${enc(admin.owner)}/${enc(admin.repo)}`;
  const ref = await gh(`${base}/git/ref/heads/${enc(admin.branch)}`);
  if (ref.notFound) throw new Error('Branch not found: ' + admin.branch);
  const baseSha = ref.object.sha;
  const baseCommit = await gh(`${base}/git/commits/${baseSha}`);
  const baseTree = baseCommit.tree.sha;

  const tree = [];
  for (const f of files) {
    if (f.content === null) {
      tree.push({ path: f.path, mode: '100644', type: 'blob', sha: null });
    } else if (f.base64) {
      const blob = await gh(`${base}/git/blobs`, {
        method: 'POST',
        body: JSON.stringify({ content: f.content, encoding: 'base64' }),
      });
      tree.push({ path: f.path, mode: '100644', type: 'blob', sha: blob.sha });
    } else {
      tree.push({ path: f.path, mode: '100644', type: 'blob', content: f.content });
    }
  }

  const treeRes = await gh(`${base}/git/trees`, {
    method: 'POST',
    body: JSON.stringify({ base_tree: baseTree, tree }),
  });
  const commitRes = await gh(`${base}/git/commits`, {
    method: 'POST',
    body: JSON.stringify({ message, tree: treeRes.sha, parents: [baseSha] }),
  });
  await gh(`${base}/git/refs/heads/${enc(admin.branch)}`, {
    method: 'PATCH',
    body: JSON.stringify({ sha: commitRes.sha, force: false }),
  });
  return commitRes.sha;
}

/* ---- connect / load --------------------------------------------------- */

async function loadConfig() {
  try {
    const res = await fetch('data/site.json', { cache: 'no-store' });
    if (res.ok) {
      const site = await res.json();
      const g = site.github || {};
      els.cOwner.value = g.owner || '';
      els.cRepo.value = g.repo || '';
      els.cBranch.value = g.branch || 'main';
      els.sName.value = site.storeName || '';
      els.sTagline.value = site.tagline || '';
      els.sCurrency.value = site.currency || '';
      els.sWhatsapp.value = site.whatsapp || '';
      els.sEmail.value = site.email || '';
    }
  } catch (e) { console.warn('site.json not available', e); }
}

async function connect() {
  admin.owner = els.cOwner.value.trim();
  admin.repo = els.cRepo.value.trim();
  admin.branch = els.cBranch.value.trim() || 'main';
  admin.token = els.cToken.value.trim();

  if (!admin.owner || !admin.repo || !admin.token) {
    showToast('Owner, repo and token are required');
    return;
  }
  localStorage.setItem(TOKEN_KEY, admin.token);

  try {
    const [siteText, prodText] = await Promise.all([
      readFileText('data/site.json'),
      readFileText('data/products.json'),
    ]);
    admin.site = siteText ? JSON.parse(siteText) : {};
    const products = prodText ? JSON.parse(prodText) : [];
    admin.products = Array.isArray(products) ? products.map((p) => normalizeProduct(p)) : [];
    admin.images = await listImages();

    admin.refImages = new Set(
      admin.products.map((p) => p.image).filter((im) => typeof im === 'string' && im.startsWith('images/')),
    );

    // sync settings inputs from repo (authoritative)
    els.sName.value = admin.site.storeName || '';
    els.sTagline.value = admin.site.tagline || '';
    els.sCurrency.value = admin.site.currency || '';
    els.sWhatsapp.value = admin.site.whatsapp || '';
    els.sEmail.value = admin.site.email || '';
    els.cOwner.value = admin.owner;
    els.cRepo.value = admin.repo;
    els.cBranch.value = admin.branch;

    els.connectPanel.hidden = true;
    els.editorPanel.hidden = false;
    els.disconnectBtn.hidden = false;
    els.connStatus.textContent = '\u2713 ' + admin.owner + '/' + admin.repo;
    els.connStatus.classList.add('ok');
    els.repoLabel.textContent = admin.owner + '/' + admin.repo + ' @ ' + admin.branch;

    renderProducts();
    admin.dirty = false;
    updateDirty();
  } catch (e) {
    showToast('Connect failed: ' + e.message);
  }
}

function disconnect() {
  localStorage.removeItem(TOKEN_KEY);
  admin.token = '';
  els.cToken.value = '';
  admin.dirty = false;
  updateDirty();
  els.connectPanel.hidden = false;
  els.editorPanel.hidden = true;
  els.disconnectBtn.hidden = true;
  els.connStatus.textContent = 'Not connected';
  els.connStatus.classList.remove('ok');
}

/* ---- product model helpers -------------------------------------------- */

function normalizeProduct(p) {
  return {
    id: p.id || genId(),
    name: p.name || '',
    category: p.category || '',
    price: Number(p.price) || 0,
    availability: p.availability || 'in_stock',
    stock: p.stock != null ? Number(p.stock) : 0,
    image: p.image || '',
    specs: Array.isArray(p.specs) ? p.specs : [],
    searchKeys: Array.isArray(p.searchKeys) ? p.searchKeys : [],
    _upload: null,
  };
}

function genId() { return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

function cleanProduct(p) {
  return {
    id: p.id,
    name: p.name,
    category: p.category || '',
    price: Number(p.price) || 0,
    availability: p.availability || 'in_stock',
    stock: p.stock != null ? Number(p.stock) : 0,
    image: p.image || '',
    specs: p.specs || [],
    searchKeys: p.searchKeys || [],
  };
}

/* ---- render ----------------------------------------------------------- */

function availSelect(current) {
  return AVAIL_OPTIONS.map((a) => (
    `<option value="${a}" ${a === current ? 'selected' : ''}>${a.replace(/_/g, ' ')}</option>`
  )).join('');
}

function productHTML(p, idx) {
  const preview = p._upload ? p._upload.dataUrl : p.image;
  return `
  <div class="product-editor">
    <div class="pe-head">
      <div class="pe-thumb">${preview ? `<img src="${esc(preview)}" alt="">` : '\u25c8'}</div>
      <div class="pe-title">
        <input data-idx="${idx}" data-field="name" value="${esc(p.name)}" placeholder="Part name">
        <div class="pe-cat">${esc(p.category || 'no category')}</div>
      </div>
      <button class="pe-remove" data-rm="${idx}">Remove</button>
    </div>
    <div class="pe-body">
      <label class="pe-field col-6"><span>Category</span>
        <input data-idx="${idx}" data-field="category" value="${esc(p.category)}" list="catList" placeholder="CPU, GPU, RAM…">
      </label>
      <label class="pe-field col-3"><span>Price</span>
        <input data-idx="${idx}" data-field="price" type="number" step="0.01" min="0" value="${p.price}">
      </label>
      <label class="pe-field col-3"><span>Availability</span>
        <select data-idx="${idx}" data-field="availability">${availSelect(p.availability)}</select>
      </label>
      <label class="pe-field col-3"><span>Stock</span>
        <input data-idx="${idx}" data-field="stock" type="number" min="0" value="${p.stock}">
      </label>
      <label class="pe-field col-9"><span>Image (URL or path)</span>
        <input data-idx="${idx}" data-field="image" value="${esc(p.image)}" placeholder="images/part.jpg or https://…">
      </label>
      <div class="pe-field col-3"><span>&nbsp;</span>
        <label class="file-btn">
          Upload image
          <input type="file" accept="image/*" data-upload="${idx}" hidden>
        </label>
      </div>
      <label class="pe-field col-6"><span>Specs (comma separated)</span>
        <input data-idx="${idx}" data-field="specs" value="${esc(p.specs.join(', '))}" placeholder="6 cores, 4.7 GHz, AM5">
      </label>
      <label class="pe-field col-6"><span>PDF search keys (comma separated)</span>
        <input data-idx="${idx}" data-field="searchKeys" value="${esc(p.searchKeys.join(', '))}" placeholder="7600X, Ryzen 5 7600X">
      </label>
    </div>
  </div>`;
}

function renderProducts() {
  els.productList.innerHTML =
    `<datalist id="catList">${[...new Set(admin.products.map((p) => p.category).filter(Boolean))].map((c) => `<option value="${esc(c)}">`).join('')}</datalist>` +
    admin.products.map((p, i) => productHTML(p, i)).join('');
}

/* ---- events ----------------------------------------------------------- */

function onFieldChange(idx, field, value) {
  const p = admin.products[idx];
  if (!p) return;
  if (field === 'price') p.price = value === '' ? 0 : Number(value);
  else if (field === 'stock') p.stock = value === '' ? 0 : Number(value);
  else if (field === 'specs') p.specs = splitList(value);
  else if (field === 'searchKeys') p.searchKeys = splitList(value);
  else p[field] = value;
  admin.dirty = true;
  updateDirty();
}

function addProduct() {
  admin.products.push(normalizeProduct({}));
  admin.dirty = true;
  updateDirty();
  renderProducts();
}

function removeProduct(idx) {
  const p = admin.products[idx];
  if (!p) return;
  if (!confirm('Remove "' + (p.name || 'this part') + '"?')) return;
  admin.products.splice(idx, 1);
  admin.dirty = true;
  updateDirty();
  renderProducts();
}

function onUpload(idx, file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const dataUrl = reader.result;
    admin.products[idx]._upload = {
      file,
      dataUrl,
      base64: dataUrl.split(',')[1],
      ext: (file.name.match(/\.\w+$/) || ['.jpg'])[0].toLowerCase(),
    };
    admin.dirty = true;
    updateDirty();
    renderProducts();
  };
  reader.readAsDataURL(file);
}

function slug(s) {
  return String(s || 'part').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'part';
}

async function save() {
  const btn = els.saveBtn;
  btn.disabled = true;
  const old = btn.textContent;
  btn.textContent = 'Saving…';
  try {
    const files = [];
    const referenced = new Set();

    for (const p of admin.products) {
      if (p._upload) {
        const path = `images/${Date.now()}-${slug(p.name)}${p._upload.ext}`;
        files.push({ path, content: p._upload.base64, base64: true });
        p.image = path;
        p._upload = null;
      }
      if (typeof p.image === 'string' && p.image.startsWith('images/')) referenced.add(p.image);
    }

    // delete previously-referenced repo images that are now unused
    const toDelete = admin.images
      .map((f) => f.path)
      .filter((path) => admin.refImages.has(path) && !referenced.has(path));
    for (const path of toDelete) files.push({ path, content: null });

    const site = {
      ...admin.site,
      storeName: els.sName.value.trim(),
      tagline: els.sTagline.value.trim(),
      currency: els.sCurrency.value.trim() || '$',
      whatsapp: els.sWhatsapp.value.trim(),
      email: els.sEmail.value.trim(),
      github: {
        owner: admin.owner,
        repo: admin.repo,
        branch: admin.branch,
      },
    };

    files.push({ path: 'data/products.json', content: JSON.stringify(admin.products.map(cleanProduct), null, 2) });
    files.push({ path: 'data/site.json', content: JSON.stringify(site, null, 2) });

    await commitChanges('chore: update catalog via admin', files);

    admin.site = site;
    admin.images = await listImages();
    admin.refImages = new Set(admin.products.map((p) => p.image).filter((im) => im.startsWith('images/')));
    admin.dirty = false;
    updateDirty();
    renderProducts();
    showToast('Saved \u2014 deployed to GitHub Pages shortly');
  } catch (e) {
    showToast('Save failed: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

function updateDirty() {
  els.unsavedBar.hidden = !admin.dirty;
}

/* ---- bind ------------------------------------------------------------- */

function bind() {
  els.connectForm.addEventListener('submit', (e) => {
    e.preventDefault();
    connect();
  });

  els.disconnectBtn.addEventListener('click', disconnect);
  els.addProductBtn.addEventListener('click', addProduct);
  els.saveBtn.addEventListener('click', save);

  els.productList.addEventListener('input', (e) => {
    const t = e.target;
    if (t.dataset && t.dataset.idx != null && t.dataset.field) {
      onFieldChange(Number(t.dataset.idx), t.dataset.field, t.value);
    }
  });
  els.productList.addEventListener('change', (e) => {
    const t = e.target;
    if (t.dataset && t.dataset.upload != null && t.files && t.files[0]) {
      onUpload(Number(t.dataset.upload), t.files[0]);
      return;
    }
    if (t.dataset && t.dataset.idx != null && t.dataset.field) {
      onFieldChange(Number(t.dataset.idx), t.dataset.field, t.value);
    }
  });
  els.productList.addEventListener('click', (e) => {
    const rm = e.target.closest('[data-rm]');
    if (rm) removeProduct(Number(rm.dataset.rm));
  });

  // mark dirty on settings edits
  ['sName', 'sTagline', 'sCurrency', 'sWhatsapp', 'sEmail'].forEach((id) => {
    els[id].addEventListener('input', () => { admin.dirty = true; updateDirty(); });
  });

  window.addEventListener('beforeunload', (e) => {
    if (admin.dirty) { e.preventDefault(); e.returnValue = ''; }
  });
}

/* ---- boot ------------------------------------------------------------- */

function init() {
  els.connectPanel = $('connectPanel');
  els.editorPanel = $('editorPanel');
  els.connectForm = $('connectForm');
  els.cOwner = $('cOwner');
  els.cRepo = $('cRepo');
  els.cBranch = $('cBranch');
  els.cToken = $('cToken');
  els.connStatus = $('connStatus');
  els.disconnectBtn = $('disconnectBtn');
  els.addProductBtn = $('addProductBtn');
  els.saveBtn = $('saveBtn');
  els.productList = $('productList');
  els.unsavedBar = $('unsavedBar');
  els.repoLabel = $('repoLabel');
  els.toast = $('toast');
  ['sName', 'sTagline', 'sCurrency', 'sWhatsapp', 'sEmail'].forEach((id) => { els[id] = $(id); });

  loadConfig().then(() => {
    const token = localStorage.getItem(TOKEN_KEY);
    if (token) els.cToken.value = token;
    // auto-connect if we already have token + repo info
    if (token && els.cOwner.value && els.cRepo.value) {
      admin.token = token;
      connect();
    }
  });
  bind();
}

init();
