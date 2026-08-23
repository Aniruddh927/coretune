# Drop the supplier price PDF here.

Name it anything ending in `.pdf` — e.g. `price-list-2026-08-23.pdf`.

The newest PDF in this folder is processed automatically:

- **daily** at 03:00 UTC, and
- **on every push** to this folder.

The script matches each product's `searchKeys` (in `data/products.json`) against
the PDF text and updates the `price` field. Old PDFs can stay here or be deleted;
only the newest one is read. A `.last_processed` file tracks which PDF was already
applied so the same file is never double-counted.
