# Core Tune

A black/grey static storefront for selling PC parts, hosted free on GitHub Pages.
No backend. Products live in one JSON file; images in one folder; prices update
automatically from a daily supplier PDF; a shareable admin page lets anyone edit
stock, prices, availability, and images straight from the browser.

## What's inside

| Path | Purpose |
| --- | --- |
| `index.html` | Storefront — catalog, search, category filters, cart, WhatsApp/copy checkout |
| `admin.html` | Shareable editor — update prices, availability, images; add/remove parts |
| `data/products.json` | **The file you edit** — name, price, availability, stock, image, specs |
| `data/site.json` | Store name, tagline, currency, WhatsApp number, GitHub repo info |
| `images/` | Product images (drop files here, reference them as `images/name.png`) |
| `prices/` | Drop the daily supplier PDF here |
| `scripts/update_prices.mjs` | Parses the newest PDF → updates `products.json` prices |
| `.github/workflows/` | Deploy + daily price update automations |

## 1. Deploy to GitHub

1. Create a repo on GitHub (e.g. `core-tune`) — **public** (free Pages; a
   private repo needs GitHub Pro for Pages).
2. Push this folder:

   ```bash
   cd core-tune
   git init
   git add -A
   git commit -m "init store"
   git branch -M main
   git remote add origin https://github.com/YOURNAME/core-tune.git
   git push -u origin main
   ```

3. The `Deploy to GitHub Pages` action runs automatically. Then enable Pages:
   **Settings → Pages → Source → "Deploy from a branch" → Branch `gh-pages` / root → Save.**
4. Your site is live at `https://YOURNAME.github.io/core-tune/` in ~1 minute.

## 2. Add products + images

Edit **`data/products.json`** directly on GitHub (or in the admin page). Each item:

```json
{
  "id": "gpu-4070s",
  "name": "NVIDIA GeForce RTX 4070 Super",
  "category": "GPU",
  "price": 599,
  "availability": "in_stock",
  "stock": 5,
  "image": "images/rtx-4070-super.png",
  "specs": ["12 GB GDDR6X", "7168 CUDA cores"],
  "searchKeys": ["RTX 4070 Super", "4070 Super"]
}
```

- `availability` → `in_stock` | `low_stock` | `out_of_stock` | `preorder`
- `image` → a path inside `images/` or any full URL
- `searchKeys` → strings the PDF parser looks for to match this product (use exact
  name variants/SKUs as they appear in the supplier sheet)
- `price` is a number; symbol comes from `currency` in `site.json`

Drop image files into `images/` (GitHub UI: **Add file → Upload files**).

## 3. Daily price auto-update from a PDF

1. Upload the supplier price PDF into `prices/` (any `.pdf` filename).
2. That's it — the `Price Update` workflow runs **on upload** and **daily at
   03:00 UTC**, extracts text, matches `searchKeys`, rewrites `price` in
   `products.json`, commits, and redeploys.

The parser prefers currency-denominated amounts (`$219`, `₹12,999`), then decimal
amounts (`219.00`), then the last standalone integer on the matching line. If a
product isn't matching correctly, tighten its `searchKeys` to the exact string in
the PDF, or open an issue with a sample line.

Test the parser locally:

```bash
cd scripts
npm install
node update_prices.mjs --dry-run   # preview
node update_prices.mjs             # apply
```

## 4. Share the admin page

1. Open `admin.html` on the live site once yourself.
2. Create a **fine-grained** personal access token:
   GitHub → Settings → Developer settings → Personal access tokens → Fine-grained → Generate.
   - Repository access: **only this repo**
   - Permissions: **Contents → Read and write**
3. Paste the token into the admin page and click **Connect**. It's stored only in
   that browser (`localStorage`), never sent anywhere but GitHub.
4. Share the admin URL (`…/admin.html`) with whoever updates stock. They paste the
   same token once, then edit prices, availability, upload/remove images, and
   add/remove parts. **Save changes** writes one commit and redeploys.

> No token access for the person? They can still edit `data/products.json` and
> upload images directly on github.com — the site redeploys automatically.

## Customise

- **Currency / store name / WhatsApp:** edit `data/site.json` or the admin page.
  Set `whatsapp` to a full number with country code (e.g. `919876543210`) to get a
  "Send on WhatsApp" checkout button; leave empty for copy-order only.
- **Colours:** CSS variables at the top of `css/style.css` (`--accent`, etc.).
- **Schedule:** edit the `cron` line in `.github/workflows/price-update.yml`.
