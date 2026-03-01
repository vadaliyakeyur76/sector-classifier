# Sector Classifier — Gemini AI

Analyze 2000+ companies and classify them into revenue-based sectors using Google Gemini AI.

Upload an Excel/CSV of company names → AI analyzes each company's products, end-use applications, and revenue streams → organizes everything into sectors → export sector-wise Excel.

## Features

- **Deep per-company analysis** — products, applications, revenue streams, sector mapping
- **Smart batching** — configurable batch size (1-15) with auto-retry and rate limit handling
- **Sector-wise Excel export** — master sheet + summary + individual sheet per sector
- **Live filtering** — dropdown by sector, search by company name
- **Multiple Gemini models** — 2.5 Flash (fast), 2.5 Pro (accurate), and more

## Setup

```bash
# Clone the repo
git clone https://github.com/YOUR_USERNAME/sector-classifier.git
cd sector-classifier

# Install dependencies
npm install

# Run locally
npm run dev
```

Open http://localhost:5173 and enter your Gemini API key.

## Get a Gemini API Key

1. Go to [aistudio.google.com/apikey](https://aistudio.google.com/apikey)
2. Click "Create API Key"
3. Copy and paste into the app

## Deploy to Vercel (Free)

1. Push this repo to GitHub
2. Go to [vercel.com](https://vercel.com) → New Project → Import your GitHub repo
3. Click Deploy (zero config needed — Vercel auto-detects Vite)
4. Your app is live at `your-project.vercel.app`

## Deploy to Netlify (Free)

1. Push to GitHub
2. Go to [netlify.com](https://netlify.com) → New Site → Import from Git
3. Build command: `npm run build`
4. Publish directory: `dist`
5. Deploy

## How It Works

For each company, the AI:
1. Identifies key **products and services**
2. Determines **end-use applications** (where products are used)
3. Maps **revenue streams** (which verticals generate revenue)
4. Classifies into **1-4 sectors** based on the product-application-revenue chain

Example: A company making cooling systems sold to AWS/Azure data centers → classified as **"Data Centre"**, not just "HVAC" or "Manufacturing".

## Tech Stack

- React 18 + Vite
- Google Gemini API (client-side)
- PapaParse (CSV parsing)
- SheetJS (Excel read/write)

## Security Note

The API key is entered client-side and sent directly to Google's API. It is never stored or transmitted to any other server. For production use with multiple users, consider adding a backend proxy.
