<div align="center">

# ⚙️ **RISE Core API**
### *Backend for a B2B electronics storefront — NestJS + TypeScript*

<img src="https://img.shields.io/badge/framework-NestJS-red" />
<img src="https://img.shields.io/badge/language-TypeScript-blue" />
<img src="https://img.shields.io/badge/database-Prisma-informational" />
<img src="https://img.shields.io/badge/database-PostgreSQL-blue" />
<img src="https://img.shields.io/badge/runtime-Node.js-green" />

---

### 🖥️ Frontend Repo
👉 https://github.com/HannaAssaf/rise-storefront-web

</div>

---

## 📌 Overview

**RISE Core API** is a scalable backend API for a B2B electronics storefront (products, pricing, suppliers, orders).
Built with **NestJS** and **TypeScript**, with a **Prisma** layer present for database access.

---

## 🎯 Project Goal (Real Supplier API Integration)

The main goal of this project is to integrate a **real supplier API** and build a store catalogue based on the supplier’s data.

**Search-driven catalogue building (local-first approach):**

- Products are added to the **local database on-demand**, via **search** (not via manual catalogue entry).
- When a customer searches for an item, the system checks the **local catalogue first**:
  - ✅ If the product exists locally — return the **local product**.
  - ❌ If missing — query the **supplier API** and return results from the supplier’s catalogue.
- When a supplier product is selected/confirmed, it is **saved into the local database** so it becomes available as a local product for future searches.

This keeps the local catalogue clean and relevant, while still providing access to the supplier’s full range when needed.

---

## ✨ What this API is responsible for

- Local catalogue management (products stored in your database)
- Supplier API integration layer (fetching products when local results are missing)
- Persisting supplier products into the local database after selection
- Serving data to the storefront (frontend) via HTTP endpoints

---

<div align="center"> 🧡 <i> Built to demonstrate a real-world Next.js storefront integrated with a NestJS API (RISE Core).</i> </div>
