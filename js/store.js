'use strict';

/* ==========================================================================
   Core Tune storefront — catalog + cart + order
   ========================================================================== */

const state = {
  site: {},
  products: [],
  category: 'all',
  query: '',
  cart: loadCart(),
  orderText: '',
};

const els = {};

const AVAIL = {
  in_stock: { label: 'In stock', cls: 'ok' },
  low_stock: { label: 'Low stock', cls: 'warn' },
  out_of_stock: { label: 'Out of stock', cls: 'bad' },
  preorder: { label: 'Preorder', cls: 'pre' },
};

function $(id) { return document.getElementById(id); }

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function loadCart() {
  try {
    const c = JSON.parse(localStorage.getItem('gw_cart') || '[]');
    return Array.isArray(c) ? c : [];
  } catch { return []; }
}
function saveCart() { localStorage.setItem('gw_cart', JSON.stringify(state.cart)); }

async function fetchJSON(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error('Failed to load ' + url + ' (' + res.status + ')');
  return res.json();
}

function money(p) {
  const sym = (p && p.currency) || state.site.currency || '$';
  const n = Number(p && p.price);
  if (!Number.isFinite(n)) return sym + ' 0';
  const frac = Math.abs(n % 1) > 1e-9;
  const s = n.toLocaleString('en-US', frac
    ? { minimumFractionDigits: 2, maximumFractionDigits: 2 }
    : { maximumFractionDigits: 0 });
  return sym + ' ' + s;
}

function findProduct(id) { return state.products.find((p) => p.id === id); }

function cartQty(id) {
  const it = state.cart.find((c) => c.id === id);
  return it ? it.qty : 0;
}
function cartCount() { return state.cart.reduce((a, c) => a + c.qty, 0); }
function cartSubtotal() {
  return state.cart.reduce((a, c) => {
    const p = findProduct(c.id);
    return a + (p ? Number(p.price) * c.qty : 0);
  }, 0);
}

function showToast(msg) {
  els.toast.textContent = msg;
  els.toast.classList.add('show');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => els.toast.classList.remove('show'), 2200);
}

/* ---- render ----------------------------------------------------------- */

function renderCategories() {
  const cats = ['all', ...new Set(state.products.map((p) => p.category).filter(Boolean))];
  els.chips.innerHTML = cats.map((c) => (
    `<button class="chip ${state.category === c ? 'active' : ''}" data-cat="${esc(c)}">${c === 'all' ? 'All' : esc(c)}</button>`
  )).join('');
}

function visibleProducts() {
  const q = state.query.trim().toLowerCase();
  return state.products.filter((p) => {
    if (state.category !== 'all' && p.category !== state.category) return false;
    if (!q) return true;
    const hay = [p.name, p.category, ...(p.specs || [])].join(' ').toLowerCase();
    return hay.includes(q);
  });
}

function cardHTML(p) {
  const av = AVAIL[p.availability] || AVAIL.in_stock;
  const out = p.availability === 'out_of_stock';
  const specs = (p.specs || []).slice(0, 4)
    .map((s) => `<span class="spec">${esc(s)}</span>`).join('');
  const img = p.image
    ? `<img src="${esc(p.image)}" alt="${esc(p.name)}" loading="lazy" onerror="this.style.display='none'">`
    : '';
  const catTag = p.category ? `<span class="cat-tag">${esc(p.category)}</span>` : '';
  return `
  <article class="card">
    <div class="card-media">
      <span class="media-fallback"><span class="mf-glyph">\u25c8</span><span class="mf-cat">${esc(p.category || 'Part')}</span></span>
      ${img}
      <span class="badge ${av.cls}">${esc(av.label)}</span>
    </div>
    <div class="card-body">
      ${catTag}
      <h3 class="card-name">${esc(p.name)}</h3>
      ${specs ? `<div class="specs">${specs}</div>` : ''}
      <div class="card-foot">
        <span class="price">${esc(money(p))}</span>
        <button class="btn-add ${out ? 'disabled' : ''}" data-add="${esc(p.id)}" ${out ? 'disabled' : ''}>${out ? 'Sold out' : 'Add'}</button>
      </div>
    </div>
  </article>`;
}

function renderProducts() {
  const list = visibleProducts();
  els.grid.innerHTML = list.map(cardHTML).join('');
  els.empty.hidden = list.length !== 0;
}

function renderCart() {
  const count = cartCount();
  els.cartCount.textContent = count;
  els.cartCount.style.display = count ? 'grid' : 'none';

  if (count === 0) {
    els.cartItems.hidden = true;
    els.cartEmpty.hidden = false;
    els.cartFoot.hidden = true;
    return;
  }

  els.cartItems.hidden = false;
  els.cartEmpty.hidden = true;
  els.cartFoot.hidden = false;

  els.cartItems.innerHTML = state.cart.map((c) => {
    const p = findProduct(c.id);
    if (!p) return '';
    return `
    <div class="cart-item">
      <div class="cart-item-media">
        ${p.image ? `<img src="${esc(p.image)}" alt="" onerror="this.style.display='none'">` : '\u25c8'}
      </div>
      <div class="cart-item-info">
        <p class="cart-item-name">${esc(p.name)}</p>
        <span class="cart-item-price">${esc(money(p))}</span>
        <div class="qty-controls">
          <button class="qty-btn" data-dec="${esc(c.id)}">\u2212</button>
          <span class="qty-val">${c.qty}</span>
          <button class="qty-btn" data-inc="${esc(c.id)}">+</button>
        </div>
      </div>
      <button class="cart-item-remove" data-rm="${esc(c.id)}">Remove</button>
    </div>`;
  }).join('');

  els.cartSubtotal.textContent = money({ price: cartSubtotal() });
}

function buildOrderText() {
  const lines = state.cart.map((c) => {
    const p = findProduct(c.id);
    if (!p) return null;
    return `${p.name} \u00d7 ${c.qty} = ${money({ price: Number(p.price) * c.qty })}`;
  }).filter(Boolean);
  const header = `New order \u2014 ${state.site.storeName || 'Core Tune'}`;
  lines.push('', `Total: ${money({ price: cartSubtotal() })}`);
  return [header, '', ...lines].join('\n');
}

function openOrderModal() {
  state.orderText = buildOrderText();
  els.orderText.value = state.orderText;
  const num = String(state.site.whatsapp || '').replace(/\D/g, '');
  if (num) {
    els.waBtn.hidden = false;
    els.waBtn.href = `https://wa.me/${num}?text=${encodeURIComponent(state.orderText)}`;
  } else {
    els.waBtn.hidden = true;
  }
  els.orderBackdrop.hidden = false;
}

/* ---- cart operations -------------------------------------------------- */

function addToCart(id) {
  const p = findProduct(id);
  if (!p || p.availability === 'out_of_stock') return;
  const it = state.cart.find((c) => c.id === id);
  if (it) it.qty += 1;
  else state.cart.push({ id, qty: 1 });
  saveCart();
  renderCart();
  showToast(`Added ${p.name}`);
}

function inc(id) {
  const it = state.cart.find((c) => c.id === id);
  if (it) { it.qty += 1; saveCart(); renderCart(); }
}
function dec(id) {
  const it = state.cart.find((c) => c.id === id);
  if (!it) return;
  it.qty -= 1;
  if (it.qty <= 0) state.cart = state.cart.filter((c) => c.id !== id);
  saveCart();
  renderCart();
}
function removeFromCart(id) {
  state.cart = state.cart.filter((c) => c.id !== id);
  saveCart();
  renderCart();
}

/* ---- events ----------------------------------------------------------- */

function bind() {
  els.chips.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    state.category = chip.dataset.cat;
    renderCategories();
    renderProducts();
  });

  els.searchInput.addEventListener('input', () => {
    state.query = els.searchInput.value;
    renderProducts();
  });

  els.clearSearchBtn.addEventListener('click', () => {
    els.searchInput.value = '';
    state.query = '';
    renderProducts();
  });

  els.grid.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-add]');
    if (btn) addToCart(btn.dataset.add);
  });

  els.cartItems.addEventListener('click', (e) => {
    const incB = e.target.closest('[data-inc]');
    const decB = e.target.closest('[data-dec]');
    const rmB = e.target.closest('[data-rm]');
    if (incB) inc(incB.dataset.inc);
    else if (decB) dec(decB.dataset.dec);
    else if (rmB) removeFromCart(rmB.dataset.rm);
  });

  els.cartBtn.addEventListener('click', () => {
    els.cartDrawer.classList.add('open');
    els.cartOverlay.hidden = false;
  });
  const closeCart = () => {
    els.cartDrawer.classList.remove('open');
    els.cartOverlay.hidden = true;
  };
  els.cartCloseBtn.addEventListener('click', closeCart);
  els.cartOverlay.addEventListener('click', closeCart);
  els.cartEmptyBtn.addEventListener('click', closeCart);

  els.checkoutBtn.addEventListener('click', openOrderModal);

  const closeOrder = () => { els.orderBackdrop.hidden = true; };
  els.orderCloseBtn.addEventListener('click', closeOrder);
  els.orderBackdrop.addEventListener('click', (e) => { if (e.target === els.orderBackdrop) closeOrder(); });

  els.copyOrderBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(state.orderText);
      showToast('Order copied');
    } catch {
      els.orderText.select();
      showToast('Press Ctrl+C to copy');
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeCart();
      els.orderBackdrop.hidden = true;
    }
  });
}

/* ---- apply site config ------------------------------------------------ */

function applySite() {
  const site = state.site || {};
  const name = site.storeName || 'Core Tune';
  const tag = site.tagline || 'PC parts, honest prices.';
  document.title = name;
  els.brandName.textContent = name;
  els.heroTitle.textContent = 'Build it. Ship it.';
  els.heroSub.textContent = tag;
  els.footerName.textContent = name;
  els.footerTag.textContent = 'Prices auto-sync from supplier PDFs.';
  if (site.email) {
    els.footerTag.textContent += ` \u00b7 ${site.email}`;
  }
  if (site.logo && els.brandLogo) {
    els.brandLogo.src = site.logo;
    els.brandLogo.hidden = false;
    if (els.brandMark) els.brandMark.hidden = true;
  }
}

/* ---- boot ------------------------------------------------------------- */

async function init() {
  els.grid = $('productGrid');
  els.chips = $('categoryChips');
  els.empty = $('emptyState');
  els.searchInput = $('searchInput');
  els.clearSearchBtn = $('clearSearchBtn');
  els.cartBtn = $('cartBtn');
  els.cartCount = $('cartCount');
  els.cartDrawer = $('cartDrawer');
  els.cartOverlay = $('cartOverlay');
  els.cartCloseBtn = $('cartCloseBtn');
  els.cartItems = $('cartItems');
  els.cartEmpty = $('cartEmpty');
  els.cartEmptyBtn = $('cartEmptyBtn');
  els.cartFoot = $('cartFoot');
  els.cartSubtotal = $('cartSubtotal');
  els.checkoutBtn = $('checkoutBtn');
  els.orderBackdrop = $('orderBackdrop');
  els.orderCloseBtn = $('orderCloseBtn');
  els.orderText = $('orderText');
  els.waBtn = $('waBtn');
  els.copyOrderBtn = $('copyOrderBtn');
  els.toast = $('toast');
  els.brandName = $('brandName');
  els.brandLogo = $('brandLogo');
  els.brandMark = $('brandMark');
  els.heroTitle = $('heroTitle');
  els.heroSub = $('heroSub');
  els.footerName = $('footerName');
  els.footerTag = $('footerTag');

  try {
    const [site, products] = await Promise.all([
      fetchJSON('data/site.json'),
      fetchJSON('data/products.json'),
    ]);
    state.site = site || {};
    state.products = Array.isArray(products) ? products : [];
  } catch (err) {
    console.error(err);
    els.grid.innerHTML = `<div class="empty"><p>Could not load the catalog. Check data/products.json.</p></div>`;
    return;
  }

  applySite();
  renderCategories();
  renderProducts();
  renderCart();
  bind();
}

init();
