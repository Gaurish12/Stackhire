/**
 * StackHire Backend Scraper Server
 * ─────────────────────────────────────────────────────────────────────────────
 * Scrapes Google Jobs, Naukri, Indeed India, LinkedIn India, GulfTalent, Reed UK
 * Zero paid APIs. Zero user keys. Runs on your server.
 *
 * INSTALL:  npm install express cors axios cheerio
 * RUN:      node server.js
 * PORT:     3001  (change PORT env var)
 * ─────────────────────────────────────────────────────────────────────────────
 */

const express  = require('express');
const cors     = require('cors');
const axios    = require('axios');
const cheerio  = require('cheerio');
const crypto   = require('crypto');

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

// Rotate user-agents so Google / Naukri don't block a single UA
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
];
const rUA = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

// Base headers that mimic a real browser
const baseHeaders = (extra = {}) => ({
  'User-Agent': rUA(),
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-IN,en;q=0.9,hi;q=0.7',
  'Accept-Encoding': 'gzip, deflate, br',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Upgrade-Insecure-Requests': '1',
  ...extra,
});

// In-memory job cache — refreshed every 25 minutes
let CACHE = {
  jobs: [],
  lastFetch: 0,
  status: {}, // source → {count, ok, error}
  inProgress: false,
};
const CACHE_TTL = 25 * 60 * 1000; // 25 min

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────
function uid(prefix, str) {
  return prefix + '_' + crypto.createHash('md5').update(str).digest('hex').slice(0, 10);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

const ROLE_KW = {
  ai:        ['machine learning','ml ','llm','deep learning','nlp','data science','computer vision','mlops','ai engineer','research scientist','generative','prompt engineer'],
  data:      ['data engineer','data analyst','analytics engineer','etl','data pipeline','databricks','snowflake','bigquery','dbt','airflow','bi engineer','business intelligence'],
  architect: ['solutions architect','cloud architect','principal engineer','staff engineer','platform engineer','devops','site reliability','sre ','infrastructure engineer','tech lead'],
  designer:  ['product designer','ux designer','ui designer','ui/ux','figma','visual designer','motion designer','brand designer','design lead'],
  qa:        ['qa engineer','quality assurance','test automation','sdet','software tester','quality engineer','testing engineer'],
  developer: ['frontend','front-end','react','vue','angular','ios developer','android developer','mobile developer','web developer','full stack','fullstack','backend developer'],
  engineer:  ['software engineer','sde ','software developer','backend engineer','site engineer'],
};
function classRole(text) {
  const t = (text || '').toLowerCase();
  for (const [role, kws] of Object.entries(ROLE_KW)) {
    if (kws.some(k => t.includes(k))) return role;
  }
  return 'engineer';
}

function classWork(text) {
  const t = (text || '').toLowerCase();
  if (t.includes('hybrid'))           return 'hybrid';
  if (t.includes('remote'))           return 'remote';
  if (t.includes('work from home') || t.includes('wfh')) return 'remote';
  return 'onsite';
}

function classType(text) {
  const t = (text || '').toLowerCase();
  if (t.includes('contract') || t.includes('freelance') || t.includes('c2h')) return 'contract';
  if (t.includes('part time') || t.includes('part-time')) return 'part-time';
  return 'full-time';
}

function detectCountry(text, fallback = 'IN') {
  const t = (text || '').toLowerCase();
  if (t.includes('india') || t.includes('bangalore') || t.includes('bengaluru') ||
      t.includes('mumbai') || t.includes('hyderabad') || t.includes('chennai') ||
      t.includes('delhi') || t.includes('pune') || t.includes('noida') ||
      t.includes('gurugram') || t.includes('gurgaon') || t.includes('kolkata') ||
      t.includes('ahmedabad') || t.includes('jaipur') || t.includes('kochi'))
    return 'IN';
  if (t.includes('dubai') || t.includes('abu dhabi') || t.includes('uae') ||
      t.includes('united arab') || t.includes('sharjah') || t.includes('riyadh') ||
      t.includes('gulf') || t.includes('doha') || t.includes('manama'))
    return 'UAE';
  if (t.includes('london') || t.includes('manchester') || t.includes('edinburgh') ||
      t.includes('birmingham') || t.includes('bristol') || t.includes('leeds') ||
      t.includes('united kingdom') || t.includes(' uk ') || t.includes('glasgow'))
    return 'UK';
  if (t.includes('new york') || t.includes('san francisco') || t.includes('seattle') ||
      t.includes('austin') || t.includes('boston') || t.includes('chicago') ||
      t.includes('united states') || t.includes(', ca') || t.includes(', ny'))
    return 'US';
  return fallback;
}

function hoursAgo(dateStr) {
  if (!dateStr) return 48;
  try {
    const d = new Date(dateStr);
    if (isNaN(d)) return 48;
    return Math.max(0, Math.round((Date.now() - d.getTime()) / 3_600_000));
  } catch { return 48; }
}

// Extract skills from text
const SKILLS_LIST = [
  'Python','JavaScript','TypeScript','React','Node.js','AWS','GCP','Azure','Go','Rust','Java','Kotlin',
  'Swift','Docker','Kubernetes','Terraform','PostgreSQL','MySQL','MongoDB','Redis','GraphQL','REST',
  'Vue.js','Next.js','Django','FastAPI','Spring Boot','Rails','Scala','Spark','Airflow','dbt',
  'Snowflake','TensorFlow','PyTorch','SQL','Git','CI/CD','Linux','Flutter','Angular','PHP','Laravel',
  'C++','C#','.NET','Golang','Hadoop','Kafka','Elasticsearch','RabbitMQ','gRPC','Solidity',
];
function extractSkills(text) {
  const t = (text || '').toLowerCase();
  return SKILLS_LIST.filter(s => t.includes(s.toLowerCase())).slice(0, 6);
}

function parseRelativeDate(text) {
  if (!text) return null;
  const t = text.toLowerCase().trim();
  const now = Date.now();
  if (t.includes('just') || t.includes('today') || t.includes('1 hour') || t.includes('now'))
    return new Date(now - 2 * 3600000).toISOString();
  const hoursMatch = t.match(/(\d+)\s*hour/);
  if (hoursMatch) return new Date(now - parseInt(hoursMatch[1]) * 3600000).toISOString();
  const daysMatch = t.match(/(\d+)\s*day/);
  if (daysMatch) return new Date(now - parseInt(daysMatch[1]) * 86400000).toISOString();
  const weeksMatch = t.match(/(\d+)\s*week/);
  if (weeksMatch) return new Date(now - parseInt(weeksMatch[1]) * 7 * 86400000).toISOString();
  const monthsMatch = t.match(/(\d+)\s*month/);
  if (monthsMatch) return new Date(now - parseInt(monthsMatch[1]) * 30 * 86400000).toISOString();
  return new Date(now - 72 * 3600000).toISOString();
}

// ─────────────────────────────────────────────────────────────────────────────
// SCRAPER 1: GOOGLE JOBS
// Hits Google's organic search with &ibp=htl;jobs query param which returns
// the Jobs carousel in the HTML — parse the structured ld+json blobs
// ─────────────────────────────────────────────────────────────────────────────
const GOOGLE_QUERIES = [
  // INDIA — highest priority, most diverse
  { q: 'software engineer jobs Bangalore India site:naukri.com OR site:linkedin.com OR site:indeed.co.in', country: 'IN' },
  { q: 'software developer jobs Mumbai India site:naukri.com OR site:foundit.in OR site:linkedin.com',     country: 'IN' },
  { q: 'data engineer jobs Hyderabad India site:naukri.com OR site:linkedin.com',                          country: 'IN' },
  { q: 'frontend developer jobs India React TypeScript site:naukri.com OR site:linkedin.com',              country: 'IN' },
  { q: 'backend developer jobs Pune Noida Gurgaon India site:naukri.com',                                  country: 'IN' },
  { q: 'AI ML engineer jobs Bangalore Delhi India site:linkedin.com OR site:naukri.com',                   country: 'IN' },
  { q: 'devops cloud engineer jobs India AWS GCP site:naukri.com OR site:linkedin.com',                    country: 'IN' },
  { q: 'full stack developer jobs India site:naukri.com OR site:foundit.in',                               country: 'IN' },
  { q: 'QA automation engineer jobs India site:naukri.com OR site:linkedin.com',                           country: 'IN' },
  { q: 'product designer UX jobs Bangalore India site:linkedin.com OR site:indeed.co.in',                  country: 'IN' },
  { q: 'solutions architect jobs India site:naukri.com OR site:linkedin.com',                              country: 'IN' },
  { q: 'tech lead engineering manager jobs India site:linkedin.com',                                       country: 'IN' },
  // UAE
  { q: 'software engineer jobs Dubai UAE site:linkedin.com OR site:bayt.com OR site:gulftalent.com',       country: 'UAE' },
  { q: 'developer jobs Abu Dhabi UAE site:linkedin.com OR site:naukrigulf.com',                            country: 'UAE' },
  // UK
  { q: 'software engineer jobs London UK site:linkedin.com OR site:reed.co.uk OR site:totaljobs.com',      country: 'UK' },
  { q: 'data engineer jobs Manchester Bristol UK site:linkedin.com OR site:reed.co.uk',                    country: 'UK' },
  // US
  { q: 'software engineer jobs San Francisco New York site:linkedin.com OR site:indeed.com',               country: 'US' },
  { q: 'AI ML engineer jobs United States site:linkedin.com OR site:lever.co',                             country: 'US' },
];

async function scrapeGoogleJobs(queryObj) {
  const { q, country } = queryObj;
  const url = `https://www.google.com/search?q=${encodeURIComponent(q)}&gl=in&hl=en&num=20`;
  try {
    const resp = await axios.get(url, {
      headers: baseHeaders({
        'Referer': 'https://www.google.com/',
        'sec-ch-ua': '"Chromium";v="123","Not?A_Brand";v="8"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
      }),
      timeout: 12000,
      maxRedirects: 3,
    });

    const html  = resp.data;
    const $     = cheerio.load(html);
    const jobs  = [];

    // Method 1: Extract JSON-LD structured data (Google Jobs carousel)
    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const data = JSON.parse($(el).text());
        const items = Array.isArray(data) ? data : [data];
        for (const item of items) {
          const list = item['@type'] === 'ItemList' ? (item.itemListElement || []).map(e => e.item) : [];
          const jobs2 = item['@type'] === 'JobPosting' ? [item] : list.filter(i => i?.['@type'] === 'JobPosting');
          for (const j of jobs2) {
            if (!j.title) continue;
            const loc   = j.jobLocation?.address?.addressLocality || j.jobLocation?.address?.addressRegion || country;
            const cname = j.hiringOrganization?.name || 'Company';
            const desc  = (j.description || '').replace(/<[^>]*>/g, ' ').trim().slice(0, 400);
            jobs.push({
              id:           uid('gj', j.title + cname + loc),
              title:        j.title,
              company:      cname,
              location:     loc,
              country:      detectCountry(loc, country),
              workMode:     classWork((j.jobLocationType || '') + ' ' + (j.title || '') + ' ' + desc),
              jobType:      classType(j.employmentType || ''),
              roleCategory: classRole(j.title + ' ' + desc),
              skills:       extractSkills(desc + ' ' + j.title),
              hoursAgo:     hoursAgo(j.datePosted),
              postedDate:   j.datePosted,
              platform:     'google',
              platformLabel:'Google Jobs',
              platformColor:'#4285f4',
              applyUrl:     j.url || j.identifier?.url || '',
              salary:       j.baseSalary?.value?.value ? formatSalary(j.baseSalary) : null,
              salaryNum:    j.baseSalary?.value?.value || null,
              excerpt:      desc.slice(0, 200),
              description:  desc,
              logo:         `https://logo.clearbit.com/${cname.toLowerCase().replace(/\s+/g, '')}.com`,
              funded:       null,
              source:       'google_structured',
            });
          }
        }
      } catch (_) {}
    });

    // Method 2: Parse organic search result snippets (fallback when structured data absent)
    if (jobs.length < 3) {
      $('div.g, div[data-sokoban-container]').each((_, el) => {
        const titleEl   = $(el).find('h3').first();
        const linkEl    = $(el).find('a[href]').first();
        const snippetEl = $(el).find('div[data-sncf], span[class*="st"], div.IsZvec').first();
        const title     = titleEl.text().trim();
        const href      = linkEl.attr('href') || '';
        const snippet   = snippetEl.text().trim();

        if (!title || title.length < 5) return;
        // Filter to job-looking titles only
        const isJob = /engineer|developer|designer|analyst|architect|manager|qa|devops|lead/i.test(title);
        if (!isJob) return;

        // Extract company from URL or snippet
        let company = 'Company';
        const domainMatch = href.match(/\/\/(www\.)?([^/]+)/);
        if (domainMatch) {
          const d = domainMatch[2];
          if (d.includes('linkedin'))       company = extractCompanyFromSnippet(snippet) || 'Company (LinkedIn)';
          else if (d.includes('naukri'))    company = extractCompanyFromSnippet(snippet) || 'Company (Naukri)';
          else if (d.includes('indeed'))    company = extractCompanyFromSnippet(snippet) || 'Company (Indeed)';
          else if (d.includes('glassdoor')) company = extractCompanyFromSnippet(snippet) || 'Company (Glassdoor)';
          else company = d.replace('www.','').split('.')[0];
        }

        jobs.push({
          id:           uid('gs', title + href),
          title,
          company,
          location:     extractLocation(snippet, country),
          country,
          workMode:     classWork(title + ' ' + snippet),
          jobType:      classType(snippet),
          roleCategory: classRole(title + ' ' + snippet),
          skills:       extractSkills(title + ' ' + snippet),
          hoursAgo:     extractTimeFromSnippet(snippet),
          postedDate:   null,
          platform:     'google',
          platformLabel:'Google Jobs',
          platformColor:'#4285f4',
          applyUrl:     href.startsWith('http') ? href : ('https://google.com' + href),
          salary:       extractSalaryFromSnippet(snippet),
          salaryNum:    null,
          excerpt:      snippet.slice(0, 200),
          description:  snippet,
          logo:         null,
          funded:       null,
          source:       'google_organic',
        });
      });
    }

    return jobs;
  } catch (err) {
    console.error(`[Google] Error for "${q}":`, err.message);
    return [];
  }
}

function formatSalary(baseSalary) {
  try {
    const v = baseSalary?.value?.value;
    const unit = (baseSalary?.value?.unitText || 'YEAR').toUpperCase();
    if (!v) return null;
    if (unit === 'YEAR') return `₹${Math.round(v / 100000)}L/yr`;
    return `₹${v}/month`;
  } catch { return null; }
}

function extractCompanyFromSnippet(text) {
  // Look for "Company Name · X days ago" or "at Company Name"
  const m1 = text.match(/^([^·\n]+?)[\s·]/);
  if (m1 && m1[1].length < 40 && m1[1].length > 2) return m1[1].trim();
  const m2 = text.match(/(?:at|@)\s+([A-Z][^\n·,]{2,30})/);
  if (m2) return m2[1].trim();
  return null;
}

function extractLocation(text, fallback = 'India') {
  const locs = ['Bangalore','Bengaluru','Mumbai','Hyderabad','Chennai','Delhi','Pune','Noida',
    'Gurgaon','Gurugram','Kolkata','Ahmedabad','Jaipur','Kochi','Dubai','Abu Dhabi',
    'London','Manchester','New York','San Francisco','Seattle','Austin','Remote'];
  for (const loc of locs) {
    if (text.toLowerCase().includes(loc.toLowerCase())) return loc;
  }
  return fallback;
}

function extractTimeFromSnippet(text) {
  const t = (text || '').toLowerCase();
  const hm = t.match(/(\d+)\s*hour/);  if (hm) return parseInt(hm[1]);
  const dm = t.match(/(\d+)\s*day/);   if (dm) return parseInt(dm[1]) * 24;
  const wm = t.match(/(\d+)\s*week/);  if (wm) return parseInt(wm[1]) * 168;
  const mm = t.match(/(\d+)\s*month/); if (mm) return parseInt(mm[1]) * 720;
  return 72;
}

function extractSalaryFromSnippet(text) {
  const m = text.match(/(?:₹|Rs\.?|INR|lpa|LPA|lakh|£|\$|USD)[\s\d,.-]+(?:lakh|L|k|K)?/i);
  return m ? m[0].trim() : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// SCRAPER 2: NAUKRI.COM  — JSON API endpoint (no auth, CORS-open)
// Naukri exposes an internal API used by their own SPA
// ─────────────────────────────────────────────────────────────────────────────
const NAUKRI_SEARCHES = [
  { keyword: 'software engineer',         location: 'india',     exp: '0-5' },
  { keyword: 'software developer',        location: 'india',     exp: '0-5' },
  { keyword: 'frontend developer react',  location: 'bangalore', exp: '0-4' },
  { keyword: 'backend developer',         location: 'india',     exp: '1-6' },
  { keyword: 'data engineer',             location: 'india',     exp: '1-5' },
  { keyword: 'ai ml engineer',            location: 'india',     exp: '0-5' },
  { keyword: 'devops engineer',           location: 'india',     exp: '1-6' },
  { keyword: 'full stack developer',      location: 'india',     exp: '0-5' },
  { keyword: 'qa automation engineer',    location: 'india',     exp: '1-5' },
  { keyword: 'product designer',          location: 'india',     exp: '0-4' },
  { keyword: 'cloud architect',           location: 'india',     exp: '4-10' },
  { keyword: 'solutions architect',       location: 'india',     exp: '5-12' },
  { keyword: 'software engineer',         location: 'mumbai',    exp: '0-5' },
  { keyword: 'developer',                 location: 'hyderabad', exp: '0-5' },
  { keyword: 'software engineer',         location: 'noida',     exp: '0-5' },
  { keyword: 'software engineer',         location: 'pune',      exp: '0-5' },
];

async function scrapeNaukri({ keyword, location, exp }) {
  const url = `https://www.naukri.com/jobapi/v3/search?noOfResults=20&urlType=search_by_key_loc&searchType=adv&keyword=${encodeURIComponent(keyword)}&location=${encodeURIComponent(location)}&experience=${encodeURIComponent(exp)}&pageNo=1&k=${encodeURIComponent(keyword)}&l=${encodeURIComponent(location)}&seoKey=${encodeURIComponent(keyword.replace(/\s+/g, '-'))}-jobs-in-india&src=jobsearchDesk&latLong=`;
  try {
    const resp = await axios.get(url, {
      headers: {
        ...baseHeaders(),
        'appid':         '109',
        'systemid':      'Naukri',
        'Referer':       'https://www.naukri.com/',
        'Origin':        'https://www.naukri.com',
        'Content-Type':  'application/json',
      },
      timeout: 10000,
    });
    const data = resp.data;
    const jobList = data?.jobDetails || data?.jobs || [];
    return jobList.map(j => ({
      id:           uid('nk', j.jobId || j.id || j.title + j.companyName),
      title:        j.title || j.jobTitle || '',
      company:      j.companyName || j.company?.label || 'Company',
      location:     (j.placeholders?.find(p => p.type === 'location')?.label) || j.location || location,
      country:      'IN',
      workMode:     classWork((j.title || '') + ' ' + (j.tagsAndSkills || '')),
      jobType:      classType(j.jobType || ''),
      roleCategory: classRole(j.title + ' ' + (j.tagsAndSkills || '')),
      skills:       (j.tagsAndSkills || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 6),
      hoursAgo:     hoursAgo(j.footerPlaceholderLabel || parseRelativeDate(j.createdDate)),
      postedDate:   j.createdDate || null,
      platform:     'naukri',
      platformLabel:'Naukri',
      platformColor:'#ff7555',
      applyUrl:     j.jdURL ? `https://www.naukri.com${j.jdURL}` : `https://www.naukri.com`,
      salary:       j.placeholders?.find(p => p.type === 'salary')?.label || null,
      salaryNum:    null,
      excerpt:      j.jobDescription?.slice(0, 200) || '',
      description:  j.jobDescription || '',
      logo:         j.logoPath || null,
      funded:       null,
      source:       'naukri_api',
    }));
  } catch (err) {
    console.error(`[Naukri] Error "${keyword}" in "${location}":`, err.message);
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SCRAPER 3: INDEED INDIA — RSS feed (public, no auth)
// ─────────────────────────────────────────────────────────────────────────────
const INDEED_SEARCHES = [
  { q: 'software engineer',      l: 'Bangalore%2C+Karnataka' },
  { q: 'react developer',        l: 'Mumbai%2C+Maharashtra' },
  { q: 'data engineer',          l: 'Hyderabad%2C+Telangana' },
  { q: 'backend developer',      l: 'Pune%2C+Maharashtra' },
  { q: 'machine learning',       l: 'Bangalore%2C+Karnataka' },
  { q: 'devops engineer',        l: 'India' },
  { q: 'full stack developer',   l: 'Delhi%2C+India' },
  { q: 'ios developer',          l: 'India' },
  { q: 'android developer',      l: 'India' },
  { q: 'product designer',       l: 'Bangalore%2C+Karnataka' },
  { q: 'software engineer',      l: 'Dubai' },
  { q: 'software engineer',      l: 'London' },
];

async function scrapeIndeed({ q, l }) {
  const url = `https://in.indeed.com/rss?q=${q.replace(/\s+/g, '+')}&l=${l}&radius=25&sort=date&limit=20`;
  try {
    const resp = await axios.get(url, {
      headers: baseHeaders({ 'Accept': 'application/rss+xml,application/xml,text/xml,*/*' }),
      timeout: 10000,
    });
    const $ = cheerio.load(resp.data, { xmlMode: true });
    const jobs = [];
    $('item').each((_, el) => {
      const title      = $(el).find('title').text().replace(/<!\[CDATA\[|\]\]>/g, '').trim();
      const link       = $(el).find('link').text().trim() || $(el).find('guid').text().trim();
      const desc       = $(el).find('description').text().replace(/<[^>]*>/g, ' ').replace(/<!\[CDATA\[|\]\]>/g, '').trim();
      const pubDate    = $(el).find('pubDate').text().trim();
      const location2  = $(el).find('location, indeed\\:location, georss\\:point').text().trim()
                      || l.replace('%2C+', ', ').replace('+', ' ');
      if (!title || title.length < 4) return;

      // Extract company from title "Job Title - Company"
      let company = 'Company';
      const titleParts = title.split(' - ');
      if (titleParts.length >= 2) company = titleParts[titleParts.length - 1].trim();

      jobs.push({
        id:           uid('in', title + link),
        title:        titleParts[0].trim() || title,
        company,
        location:     location2,
        country:      detectCountry(location2, l.includes('Dubai') ? 'UAE' : l.includes('London') ? 'UK' : 'IN'),
        workMode:     classWork(title + ' ' + desc),
        jobType:      classType(desc),
        roleCategory: classRole(title + ' ' + desc),
        skills:       extractSkills(title + ' ' + desc),
        hoursAgo:     hoursAgo(pubDate ? new Date(pubDate).toISOString() : null),
        postedDate:   pubDate ? new Date(pubDate).toISOString() : null,
        platform:     'indeed',
        platformLabel:'Indeed',
        platformColor:'#003a9b',
        applyUrl:     link || 'https://in.indeed.com',
        salary:       extractSalaryFromSnippet(desc),
        salaryNum:    null,
        excerpt:      desc.slice(0, 220),
        description:  desc,
        logo:         null,
        funded:       null,
        source:       'indeed_rss',
      });
    });
    return jobs;
  } catch (err) {
    console.error(`[Indeed] Error "${q}" in "${l}":`, err.message);
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SCRAPER 4: LINKEDIN INDIA — public job search (no auth for search results)
// ─────────────────────────────────────────────────────────────────────────────
const LI_SEARCHES = [
  { keywords: 'Software Engineer',    location: 'India',           geoId: '102713980' },
  { keywords: 'React Developer',      location: 'Bangalore',       geoId: '105214831' },
  { keywords: 'Data Engineer',        location: 'Hyderabad',       geoId: '105556991' },
  { keywords: 'Backend Developer',    location: 'Mumbai',          geoId: '106164952' },
  { keywords: 'Machine Learning',     location: 'India',           geoId: '102713980' },
  { keywords: 'DevOps Engineer',      location: 'India',           geoId: '102713980' },
  { keywords: 'Frontend Developer',   location: 'Pune',            geoId: '106967049' },
  { keywords: 'Software Engineer',    location: 'Dubai',           geoId: '105756167' },
  { keywords: 'Software Engineer',    location: 'London',          geoId: '90009496'  },
  { keywords: 'Software Engineer',    location: 'United States',   geoId: '103644278' },
];

async function scrapeLinkedIn({ keywords, location, geoId }) {
  const url = `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=${encodeURIComponent(keywords)}&location=${encodeURIComponent(location)}&geoId=${geoId}&f_TPR=r604800&position=1&pageNum=0&start=0&count=20`;
  try {
    const resp = await axios.get(url, {
      headers: baseHeaders({
        'Referer': 'https://www.linkedin.com/jobs/',
        'sec-fetch-site': 'same-origin',
      }),
      timeout: 12000,
    });
    const $ = cheerio.load(resp.data);
    const jobs = [];
    $('li').each((_, el) => {
      const title    = $(el).find('.base-search-card__title').text().trim()
                    || $(el).find('h3').text().trim();
      const company  = $(el).find('.base-search-card__subtitle, .hidden-nested-link').first().text().trim()
                    || 'Company';
      const loc      = $(el).find('.job-search-card__location').text().trim()
                    || $(el).find('.base-search-card__metadata').text().trim()
                    || location;
      const href     = $(el).find('a.base-card__full-link, a[data-tracking-control-name]').attr('href') || '';
      const posted   = $(el).find('time').attr('datetime') || '';
      const logoSrc  = $(el).find('img').attr('data-delayed-url') || $(el).find('img').attr('src') || null;

      if (!title || title.length < 4) return;
      jobs.push({
        id:           uid('li', title + company + loc),
        title,
        company,
        location:     loc,
        country:      detectCountry(loc, location.includes('Dubai') ? 'UAE' : location.includes('London') ? 'UK' : location.includes('United States') ? 'US' : 'IN'),
        workMode:     classWork(title + ' ' + loc),
        jobType:      'full-time',
        roleCategory: classRole(title),
        skills:       extractSkills(title),
        hoursAgo:     hoursAgo(posted),
        postedDate:   posted || null,
        platform:     'linkedin',
        platformLabel:'LinkedIn',
        platformColor:'#0a66c2',
        applyUrl:     href || `https://www.linkedin.com/jobs/search?keywords=${encodeURIComponent(keywords)}&location=${encodeURIComponent(location)}`,
        salary:       null,
        salaryNum:    null,
        excerpt:      '',
        description:  '',
        logo:         logoSrc,
        funded:       null,
        source:       'linkedin_guest',
      });
    });
    return jobs;
  } catch (err) {
    console.error(`[LinkedIn] Error "${keywords}" in "${location}":`, err.message);
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SCRAPER 5: FOUNDIT (formerly Monster India) — public JSON API
// ─────────────────────────────────────────────────────────────────────────────
async function scrapeFoundit() {
  const searches = [
    'software engineer', 'react developer', 'data engineer', 'devops',
    'python developer', 'java developer', 'full stack', 'android developer',
  ];
  const jobs = [];
  for (const kw of searches) {
    try {
      const url = `https://www.foundit.in/middleware/jobsearch/v2/search?searchId=&query=${encodeURIComponent(kw)}&location=India&experience=0,5&limit=15&start=0&sort=1`;
      const resp = await axios.get(url, {
        headers: baseHeaders({ 'Referer': 'https://www.foundit.in/', 'Origin': 'https://www.foundit.in' }),
        timeout: 9000,
      });
      const list = resp.data?.data?.jobSearchResponse?.data || [];
      for (const j of list) {
        jobs.push({
          id:           uid('fi', j.jobId || j.id || j.jobTitle),
          title:        j.jobTitle || j.title || '',
          company:      j.company?.name || j.companyName || 'Company',
          location:     j.locations?.[0] || j.location || 'India',
          country:      'IN',
          workMode:     classWork(j.jobTitle + ' ' + (j.keySkills?.join(' ') || '')),
          jobType:      classType(j.jobType || ''),
          roleCategory: classRole(j.jobTitle + ' ' + (j.keySkills?.join(' ') || '')),
          skills:       j.keySkills?.slice(0, 6) || extractSkills(j.jobTitle),
          hoursAgo:     hoursAgo(j.postedDate || j.postingDate),
          postedDate:   j.postedDate || null,
          platform:     'foundit',
          platformLabel:'Foundit',
          platformColor:'#e84c1e',
          applyUrl:     j.jobUrl ? `https://www.foundit.in${j.jobUrl}` : 'https://www.foundit.in',
          salary:       j.salary || null,
          salaryNum:    null,
          excerpt:      j.jobDescription?.slice(0, 200) || '',
          description:  j.jobDescription || '',
          logo:         j.company?.logoUrl || null,
          funded:       null,
          source:       'foundit_api',
        });
      }
      await sleep(300); // be polite between requests
    } catch (err) {
      console.error(`[Foundit] Error "${kw}":`, err.message);
    }
  }
  return jobs;
}

// ─────────────────────────────────────────────────────────────────────────────
// SCRAPER 6: GREENHOUSE (startup career pages) — batch of curated India-based
// ─────────────────────────────────────────────────────────────────────────────
const GH_STARTUPS = [
  // India
  { token: 'razorpaysoftwareprivatelimited', name: 'Razorpay',    country: 'IN', funded: 'Series F · $375M', color: '#2f55d4' },
  { token: 'zepto',                          name: 'Zepto',        country: 'IN', funded: 'Series G · $665M', color: '#ff5c00' },
  { token: 'groww',                          name: 'Groww',        country: 'IN', funded: 'Series F · $251M', color: '#5367ff' },
  { token: 'meesho',                         name: 'Meesho',       country: 'IN', funded: 'Series F · $570M', color: '#9c27b0' },
  { token: 'browserstack',                   name: 'BrowserStack', country: 'IN', funded: 'Series B · $200M', color: '#ff6631' },
  { token: 'darwinbox',                      name: 'Darwinbox',    country: 'IN', funded: 'Series D · $72M',  color: '#f36b21' },
  { token: 'chargebee',                      name: 'Chargebee',    country: 'IN', funded: 'Series H · $250M', color: '#f47b20' },
  { token: 'hasura',                         name: 'Hasura',       country: 'IN', funded: 'Series C · $100M', color: '#1c78e5' },
  { token: 'postman',                        name: 'Postman',      country: 'IN', funded: 'Series D · $225M', color: '#ef5b25' },
  { token: 'unacademy',                      name: 'Unacademy',    country: 'IN', funded: 'Series G · $440M', color: '#08bd80' },
  // UAE
  { token: 'careem',                         name: 'Careem',       country: 'UAE', funded: 'Acquired · $3.1B', color: '#3ddc84' },
  { token: 'tabby',                          name: 'Tabby',        country: 'UAE', funded: 'Series D · $200M', color: '#f5a623' },
  { token: 'kitopi',                         name: 'Kitopi',       country: 'UAE', funded: 'Series C · $415M', color: '#ff2d55' },
  // UK
  { token: 'revolut',                        name: 'Revolut',      country: 'UK', funded: 'Series E · $800M',  color: '#0075eb' },
  { token: 'monzo',                          name: 'Monzo',        country: 'UK', funded: 'Series I · $500M',  color: '#ff4f64' },
  { token: 'gocardless',                     name: 'GoCardless',   country: 'UK', funded: 'Series G · $312M',  color: '#0e4d92' },
  // US
  { token: 'stripe',                         name: 'Stripe',       country: 'US', funded: 'Series I · $600M',  color: '#6772e5' },
  { token: 'notion',                         name: 'Notion',       country: 'US', funded: 'Series C · $275M',  color: '#1a1a1a' },
  { token: 'anthropic',                      name: 'Anthropic',    country: 'US', funded: 'Series E · $7.3B',  color: '#c4500a' },
  { token: 'deel',                           name: 'Deel',         country: 'US', funded: 'Series D · $425M',  color: '#7c4dff' },
];

async function scrapeGreenhouse(startup) {
  try {
    const url = `https://boards-api.greenhouse.io/v1/boards/${startup.token}/jobs?content=false`;
    const resp = await axios.get(url, { timeout: 8000 });
    return (resp.data?.jobs || []).map((j, i) => ({
      id:           uid('gh', startup.token + j.id),
      title:        j.title || '',
      company:      startup.name,
      location:     j.location?.name || startup.country,
      country:      detectCountry(j.location?.name || '', startup.country),
      workMode:     classWork(j.title + ' ' + (j.location?.name || '')),
      jobType:      'full-time',
      roleCategory: classRole(j.title),
      skills:       extractSkills(j.title),
      hoursAgo:     hoursAgo(j.updated_at),
      postedDate:   j.updated_at,
      platform:     'greenhouse',
      platformLabel:'Greenhouse',
      platformColor:'#24a360',
      applyUrl:     j.absolute_url || `https://boards.greenhouse.io/${startup.token}`,
      salary:       null, salaryNum: null,
      excerpt:      '',
      description:  '',
      logo:         `https://logo.clearbit.com/${startup.name.toLowerCase().replace(/\s+/g,'')}.com`,
      funded:       startup.funded,
      isStartup:    true,
      companyColor: startup.color,
      source:       'greenhouse_api',
    }));
  } catch (err) {
    console.error(`[Greenhouse] ${startup.name}:`, err.message);
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN ORCHESTRATOR — runs all scrapers, merges, dedupes
// ─────────────────────────────────────────────────────────────────────────────
async function runAllScrapers() {
  if (CACHE.inProgress) {
    console.log('[Cache] Scrape already in progress, skipping.');
    return;
  }
  CACHE.inProgress = true;
  CACHE.status = {};
  console.log('\n[Scraper] Starting full scrape run…');
  const t0 = Date.now();
  let allJobs = [];

  // ── Run Google scrapes (serialized with small delays to avoid rate-limit) ──
  console.log('[Google] Scraping job queries…');
  const googleResults = [];
  for (const q of GOOGLE_QUERIES) {
    const jobs = await scrapeGoogleJobs(q);
    googleResults.push(...jobs);
    await sleep(800 + Math.random() * 600); // 0.8–1.4s between requests
  }
  CACHE.status.google = { count: googleResults.length, ok: true };
  console.log(`[Google] Got ${googleResults.length} jobs`);
  allJobs.push(...googleResults);

  // ── Naukri (parallel, 4 at a time) ──
  console.log('[Naukri] Scraping job searches…');
  const naukriAll = [];
  for (let i = 0; i < NAUKRI_SEARCHES.length; i += 4) {
    const batch = NAUKRI_SEARCHES.slice(i, i + 4);
    const res   = await Promise.all(batch.map(s => scrapeNaukri(s)));
    naukriAll.push(...res.flat());
    await sleep(600);
  }
  CACHE.status.naukri = { count: naukriAll.length, ok: true };
  console.log(`[Naukri] Got ${naukriAll.length} jobs`);
  allJobs.push(...naukriAll);

  // ── Indeed RSS (parallel) ──
  console.log('[Indeed] Scraping RSS feeds…');
  const indeedRes = await Promise.all(INDEED_SEARCHES.map(s => scrapeIndeed(s)));
  const indeedAll = indeedRes.flat();
  CACHE.status.indeed = { count: indeedAll.length, ok: true };
  console.log(`[Indeed] Got ${indeedAll.length} jobs`);
  allJobs.push(...indeedAll);

  // ── LinkedIn (serialized, 1.5s delay) ──
  console.log('[LinkedIn] Scraping guest API…');
  const liAll = [];
  for (const s of LI_SEARCHES) {
    const jobs = await scrapeLinkedIn(s);
    liAll.push(...jobs);
    await sleep(1500 + Math.random() * 500);
  }
  CACHE.status.linkedin = { count: liAll.length, ok: true };
  console.log(`[LinkedIn] Got ${liAll.length} jobs`);
  allJobs.push(...liAll);

  // ── Foundit ──
  console.log('[Foundit] Scraping…');
  const founditAll = await scrapeFoundit();
  CACHE.status.foundit = { count: founditAll.length, ok: true };
  console.log(`[Foundit] Got ${founditAll.length} jobs`);
  allJobs.push(...founditAll);

  // ── Greenhouse startup pages (parallel batches) ──
  console.log('[Greenhouse] Scraping startup career pages…');
  const ghAll = [];
  for (let i = 0; i < GH_STARTUPS.length; i += 5) {
    const batch = GH_STARTUPS.slice(i, i + 5);
    const res   = await Promise.all(batch.map(s => scrapeGreenhouse(s)));
    ghAll.push(...res.flat());
    await sleep(400);
  }
  CACHE.status.greenhouse = { count: ghAll.length, ok: true };
  console.log(`[Greenhouse] Got ${ghAll.length} jobs`);
  allJobs.push(...ghAll);

  // ── Deduplicate by title+company similarity ──
  const seen   = new Set();
  const unique = [];
  for (const j of allJobs) {
    const key = (j.title + '|' + j.company).toLowerCase().replace(/\s+/g, '').slice(0, 36);
    if (!seen.has(key)) { seen.add(key); unique.push(j); }
  }

  // Sort newest first
  unique.sort((a, b) => a.hoursAgo - b.hoursAgo);

  CACHE.jobs      = unique;
  CACHE.lastFetch = Date.now();
  CACHE.inProgress = false;

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n[Scraper] Done. ${unique.length} unique jobs in ${elapsed}s`);
  console.log('[Breakdown]', Object.entries(CACHE.status).map(([k,v]) => `${k}:${v.count}`).join(' | '));
}

// ─────────────────────────────────────────────────────────────────────────────
// API ROUTES
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/jobs', async (req, res) => {
  // Trigger a refresh if cache is stale or empty
  const stale = Date.now() - CACHE.lastFetch > CACHE_TTL;
  if (CACHE.jobs.length === 0 || stale) {
    if (!CACHE.inProgress) {
      runAllScrapers(); // fire and don't await — return whatever is cached
    }
    // If truly empty (first load), wait up to 10s
    if (CACHE.jobs.length === 0) {
      await new Promise(resolve => {
        const check = setInterval(() => {
          if (CACHE.jobs.length > 0 || !CACHE.inProgress) {
            clearInterval(check);
            resolve();
          }
        }, 500);
        setTimeout(() => { clearInterval(check); resolve(); }, 10000);
      });
    }
  }

  // Apply query filters
  const { country, role, workMode, jobType, hours, q } = req.query;
  let jobs = [...CACHE.jobs];

  if (country && country !== 'ALL')  jobs = jobs.filter(j => j.country === country);
  if (role    && role    !== 'all')   jobs = jobs.filter(j => j.roleCategory === role);
  if (workMode)                       jobs = jobs.filter(j => j.workMode === workMode);
  if (jobType)                        jobs = jobs.filter(j => j.jobType === jobType);
  if (hours)                          jobs = jobs.filter(j => j.hoursAgo <= parseInt(hours));
  if (q) {
    const ql = q.toLowerCase();
    jobs = jobs.filter(j =>
      j.title.toLowerCase().includes(ql) ||
      j.company.toLowerCase().includes(ql) ||
      j.location.toLowerCase().includes(ql) ||
      j.skills.some(s => s.toLowerCase().includes(ql))
    );
  }

  res.json({
    jobs,
    total:     jobs.length,
    cached:    CACHE.jobs.length,
    lastFetch: CACHE.lastFetch,
    status:    CACHE.status,
    nextRefresh: Math.max(0, Math.round((CACHE.lastFetch + CACHE_TTL - Date.now()) / 1000)),
  });
});

// Single job detail (fetches full description on demand)
app.get('/api/jobs/:id', async (req, res) => {
  const job = CACHE.jobs.find(j => j.id === req.params.id);
  if (!job) return res.status(404).json({ error: 'Not found' });

  // Try to get full description from source
  let fullDesc = job.description;
  if (!fullDesc && job.platform === 'greenhouse' && job.applyUrl) {
    try {
      const ghId  = job.id.replace(/^gh_[^_]+_/, '');
      const token = job.applyUrl.match(/boards\.greenhouse\.io\/(.+)$/)?.[1];
      if (token) {
        const r    = await axios.get(`https://boards-api.greenhouse.io/v1/boards/${token}/jobs/${ghId}`, { timeout: 6000 });
        fullDesc   = r.data?.content || '';
      }
    } catch (_) {}
  }

  res.json({ ...job, description: fullDesc || job.description || job.excerpt });
});

// Force re-scrape
app.post('/api/refresh', async (req, res) => {
  if (CACHE.inProgress) return res.json({ message: 'Scrape already running', status: CACHE.status });
  runAllScrapers();
  res.json({ message: 'Scrape started', status: CACHE.status });
});

// Status ping
app.get('/api/status', (req, res) => {
  res.json({
    jobs:       CACHE.jobs.length,
    lastFetch:  CACHE.lastFetch,
    inProgress: CACHE.inProgress,
    status:     CACHE.status,
    nextRefresh: Math.max(0, Math.round((CACHE.lastFetch + CACHE_TTL - Date.now()) / 1000)),
    breakdown: {
      IN:  CACHE.jobs.filter(j => j.country === 'IN').length,
      US:  CACHE.jobs.filter(j => j.country === 'US').length,
      UK:  CACHE.jobs.filter(j => j.country === 'UK').length,
      UAE: CACHE.jobs.filter(j => j.country === 'UAE').length,
    },
  });
});

// Serve frontend
app.use(express.static('public'));

// ─────────────────────────────────────────────────────────────────────────────
// START
// ─────────────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 StackHire backend running on http://localhost:${PORT}`);
  console.log(`📡 API: http://localhost:${PORT}/api/jobs`);
  console.log(`🔄 Starting initial scrape...\n`);
  runAllScrapers(); // kick off on startup
});

// Re-scrape every 25 minutes automatically
setInterval(() => {
  console.log('[Cron] Auto-refresh triggered');
  runAllScrapers();
}, CACHE_TTL);
