# StackHire — India · US · UK · UAE Tech Job Scraper

Real-time job aggregator. No paid APIs. No user keys. 
Your backend scrapes Google Jobs, Naukri, LinkedIn India, Indeed India, 
Foundit (Monster India), and 20+ funded startup career pages — 
then serves everything to the frontend.

---

## QUICK START (your dev does this once)

```bash
# 1. Install dependencies
npm install

# 2. Run the backend
node server.js
```

Then open http://localhost:3001 in your browser.

**That's it.** The scraper starts automatically on launch.

---

## WHAT IT SCRAPES

| Source          | Method                        | India Coverage        |
|-----------------|-------------------------------|-----------------------|
| Google Jobs     | HTML + JSON-LD parse          | Naukri, LinkedIn, Indeed IN, Glassdoor, TimesJobs |
| Naukri.com      | Internal JSON API (no auth)   | Direct Naukri listings |
| Indeed India    | RSS feed (in.indeed.com)      | All Indian cities |
| LinkedIn India  | Guest Jobs API (no auth)      | Full India + UAE + UK + US |
| Foundit.in      | Internal JSON API (no auth)   | Former Monster India |
| Greenhouse      | Public board API (no auth)    | 20 funded Indian startups |

Total: **400–800+ jobs per scrape across IN/US/UK/UAE**
India ratio: **~60–70% of total**

---

## SCRAPE SCHEDULE

- Runs automatically on server start
- Auto-refreshes every **25 minutes**
- Hit POST `/api/refresh` to force a re-scrape anytime
- Frontend polls backend every 3s during active scraping

---

## API ENDPOINTS

| Endpoint               | Description                    |
|------------------------|--------------------------------|
| `GET /api/jobs`        | All jobs (filterable)          |
| `GET /api/jobs/:id`    | Single job with full description |
| `POST /api/refresh`    | Force re-scrape now            |
| `GET /api/status`      | Scraper status + source counts |

### Query params for `/api/jobs`
- `?country=IN` — filter by country (IN, US, UK, UAE)
- `?role=developer` — filter by role category
- `?hours=24` — filter by recency (hours)
- `?q=react` — full-text search

---

## PRODUCTION DEPLOY

```bash
# Install PM2
npm install -g pm2

# Run with auto-restart
pm2 start server.js --name stackhire

# Auto-start on reboot
pm2 startup
pm2 save
```

For a VPS (DigitalOcean / AWS / Render / Railway):
1. Push this folder to your server
2. Run `npm install && pm2 start server.js --name stackhire`
3. Point your domain to port 3001
4. The frontend at `/public/index.html` is auto-served

---

## ARCHITECTURE

```
Browser (public/index.html)
       │  polls /api/jobs every 3s during scrape
       ▼
Node.js Backend (server.js :3001)
       │
       ├── Google Jobs scraper     (18 queries × rotation)
       ├── Naukri API scraper      (16 keyword/city combos)
       ├── Indeed India RSS        (12 feeds)
       ├── LinkedIn Guest API      (10 searches)
       ├── Foundit.in API          (8 keywords)
       └── Greenhouse startup API  (20 startup career pages)
              │
              ▼
       In-memory cache (refreshed every 25 min)
       Deduplicated + sorted by recency
```

---

## ANTI-BLOCK MEASURES BUILT IN

- Rotates 5 different User-Agent strings
- Random delays between Google requests (800–1400ms)
- LinkedIn requests spaced 1500ms apart
- Naukri + Foundit batched 4 at a time

---

## ADDING MORE STARTUP CAREER PAGES

In `server.js`, find `GH_STARTUPS` array and add:

```js
{ token: 'your-greenhouse-slug', name: 'Company Name', country: 'IN', funded: 'Series B · $50M', color: '#hexcolor' },
```

The token is the slug from `boards.greenhouse.io/{token}` on their careers page.

---

## NOTES

- Google scraping respects robots.txt delays — don't reduce sleep times
- Naukri's internal API may change; check browser DevTools Network tab if it breaks
- LinkedIn guest API works without login for public job listings only
- This is for internal/personal use — check each platform's ToS for commercial use
