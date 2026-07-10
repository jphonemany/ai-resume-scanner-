require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const cheerio = require('cheerio');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const PORT = process.env.PORT || 3000;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Resume text extraction ----------
async function extractResumeText(file) {
  const name = (file.originalname || '').toLowerCase();
  if (name.endsWith('.pdf')) {
    const data = await pdfParse(file.buffer);
    return data.text;
  }
  if (name.endsWith('.docx')) {
    const result = await mammoth.extractRawText({ buffer: file.buffer });
    return result.value;
  }
  if (name.endsWith('.txt') || name.endsWith('.md')) {
    return file.buffer.toString('utf-8');
  }
  throw new Error('Unsupported file type. Please upload a PDF, DOCX, or TXT file.');
}

// ---------- Job posting fetch ----------
// Extract readable job text from HTML (JSON-LD JobPosting preferred)
function extractJobText(html) {
  const $ = cheerio.load(html);
  $('script[type!="application/ld+json"], style, nav, footer, header, noscript, svg, iframe').remove();

  let jsonLd = null;
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const parsed = JSON.parse($(el).text());
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of items) {
        if (item['@type'] === 'JobPosting') jsonLd = item;
      }
    } catch (e) { /* ignore */ }
  });

  let title = $('title').first().text().trim();
  let text;
  if (jsonLd) {
    title = jsonLd.title || title;
    const desc = cheerio.load(jsonLd.description || '').text();
    text = [
      `Title: ${jsonLd.title || ''}`,
      `Company: ${jsonLd.hiringOrganization?.name || ''}`,
      `Location: ${JSON.stringify(jsonLd.jobLocation?.address || jsonLd.jobLocation || '')}`,
      `Employment type: ${jsonLd.employmentType || ''}`,
      `Salary: ${JSON.stringify(jsonLd.baseSalary || '')}`,
      `Description: ${desc}`
    ].join('\n');
  } else {
    $('script').remove();
    text = $('body').text().replace(/\s+/g, ' ').trim();
  }
  return { title, text };
}

// Headless-browser fallback for JavaScript-rendered pages
let playwrightAvailable = null;
async function fetchWithBrowser(url) {
  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch {
    return { url, ok: false, error: 'Page requires JavaScript. Install Playwright (npm install && npm run setup-browser) or paste the description manually.' };
  }
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
    });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForTimeout(2500); // let client-side rendering finish
    const html = await page.content();
    const { title, text } = extractJobText(html);
    if (!text || text.length < 200) {
      return { url, ok: false, title, error: 'Page rendered but no readable job text found (may require login). Paste the description manually.' };
    }
    return { url, ok: true, title, text: text.slice(0, 12000), via: 'browser' };
  } catch (err) {
    return { url, ok: false, error: `Headless browser failed: ${err.message.slice(0, 120)}` };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

async function fetchJobPosting(url) {
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });
    if (!res.ok) {
      // Blocked (403/999 etc.)? A real browser may get through.
      return fetchWithBrowser(url);
    }
    const html = await res.text();
    const { title, text } = extractJobText(html);
    if (!text || text.length < 200) {
      // Likely JavaScript-rendered — retry with headless browser
      return fetchWithBrowser(url);
    }
    return { url, ok: true, title, text: text.slice(0, 12000) };
  } catch (err) {
    if (err.name === 'TimeoutError') return { url, ok: false, error: 'Request timed out' };
    return fetchWithBrowser(url);
  }
}

// ---------- OpenAI ----------
async function callOpenAI(messages) {
  const key = process.env.OPENAI_API_KEY;
  if (!key || key.startsWith('sk-your')) {
    throw new Error('OPENAI_API_KEY is not set. Copy .env.example to .env and add your key from https://platform.openai.com/api-keys');
  }
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages,
      temperature: 0.2,
      response_format: { type: 'json_object' }
    })
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenAI API error (${res.status}): ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  return JSON.parse(data.choices[0].message.content);
}

function buildPrompt(resumeText, preferences, jobs) {
  const prefLines = [
    `Preferred work type: ${preferences.workType || 'no preference'}`,
    `Expected compensation: ${preferences.salary || 'not specified'}`,
    `Preferred location: ${preferences.location || 'not specified'}`
  ].join('\n');

  const jobBlocks = jobs.map((j, i) =>
    `--- JOB ${i + 1} (id: ${i}) ---\nURL: ${j.url}\n${j.text}`
  ).join('\n\n');

  return [
    {
      role: 'system',
      content: `You are an expert technical recruiter and career coach. You evaluate how well a resume matches job postings, factoring in the candidate's stated preferences. Be honest and specific. Always respond with valid JSON only.`
    },
    {
      role: 'user',
      content: `Analyze this resume against the job postings below.

RESUME:
${resumeText.slice(0, 15000)}

CANDIDATE PREFERENCES:
${prefLines}

JOB POSTINGS:
${jobBlocks}

Return JSON with exactly this shape:
{
  "jobs": [
    {
      "id": <job id number>,
      "title": "<job title / company>",
      "resume_match_score": <0-100, how well the resume fits the job requirements>,
      "preference_match_score": <0-100, how well the job fits the candidate's work type / salary / location preferences>,
      "overall_score": <0-100, weighted: 60% resume match, 40% preference match>,
      "strengths": ["<2-4 specific strengths of this candidate for this job>"],
      "gaps": ["<2-4 specific gaps or missing qualifications>"],
      "resume_recommendations": ["<2-4 concrete resume edits to better fit THIS job, e.g. keywords to add, experience to emphasize, sections to reorder>"]
    }
  ],
  "best_fit": {
    "id": <id of the best overall job>,
    "reason": "<2-3 sentence explanation of why this is the best fit>"
  },
  "general_resume_feedback": ["<3-5 improvements to the resume overall, independent of any single job>"]
}`
    }
  ];
}

// ---------- Scan session store (in-memory, keeps last 20 scans) ----------
const crypto = require('crypto');
const scans = new Map();
function storeScan(resumeText, jobs) {
  const id = crypto.randomUUID();
  scans.set(id, { resumeText, jobs, at: Date.now() });
  if (scans.size > 20) {
    const oldest = [...scans.entries()].sort((a, b) => a[1].at - b[1].at)[0][0];
    scans.delete(oldest);
  }
  return id;
}

// ---------- Routes ----------
app.post('/api/analyze', upload.single('resume'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No resume file uploaded.' });

    let preferences = {};
    let jobInputs = [];
    try {
      preferences = JSON.parse(req.body.preferences || '{}');
      jobInputs = JSON.parse(req.body.jobs || '[]');
    } catch {
      return res.status(400).json({ error: 'Malformed preferences or jobs payload.' });
    }
    jobInputs = jobInputs.slice(0, 10);
    if (jobInputs.length === 0) return res.status(400).json({ error: 'Provide at least one job posting link or pasted description.' });

    const resumeText = await extractResumeText(req.file);
    if (!resumeText || resumeText.trim().length < 100) {
      return res.status(400).json({ error: 'Could not extract enough text from the resume. Try a different file format.' });
    }

    // Each job input: { url } or { url, pastedText }
    const fetched = await Promise.all(jobInputs.map(async (j) => {
      const pasted = (j.pastedText || '').trim();
      if (pasted.length >= 100) {
        return { url: j.url || '(pasted description)', ok: true, title: '', text: pasted.slice(0, 12000) };
      }
      if (pasted.length > 0) {
        return { url: j.url || '(pasted description)', ok: false, error: `Pasted description is too short (${pasted.length} characters, need at least 100). Paste the full job description, not a summary.` };
      }
      if (!j.url) return { url: '(empty)', ok: false, error: 'No link or description provided.' };
      return fetchJobPosting(j.url);
    }));

    const usable = fetched.filter(f => f.ok);
    const failed = fetched.filter(f => !f.ok);
    if (usable.length === 0) {
      return res.status(422).json({
        error: 'None of the job links could be fetched. Many job boards block automated access — paste the job description text instead.',
        failed
      });
    }

    const analysis = await callOpenAI(buildPrompt(resumeText, preferences, usable));
    const scanId = storeScan(resumeText, usable);

    // Attach URLs back onto results
    if (Array.isArray(analysis.jobs)) {
      analysis.jobs.forEach(job => {
        const src = usable[job.id];
        if (src) { job.url = src.url; job.fetched_title = src.title; }
      });
    }

    res.json({ analysis, failed, scanId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- Tailored resume generation ----------
app.post('/api/tailor', async (req, res) => {
  try {
    const { scanId, jobId } = req.body || {};
    const scan = scans.get(scanId);
    if (!scan) return res.status(410).json({ error: 'Scan session expired — run the scan again, then generate the tailored resume.' });
    const job = scan.jobs[jobId];
    if (!job) return res.status(400).json({ error: 'Unknown job for this scan.' });

    const result = await callOpenAI([
      {
        role: 'system',
        content: 'You are an expert resume writer. You tailor resumes to specific job postings while staying strictly truthful: never invent experience, employers, titles, dates, degrees, or skills the candidate does not have. You may reword, reorder, emphasize, quantify differently, and align terminology with the job description. Respond with valid JSON only.'
      },
      {
        role: 'user',
        content: `Rewrite this resume tailored to the job posting below.

ORIGINAL RESUME:
${scan.resumeText.slice(0, 15000)}

TARGET JOB POSTING:
${job.text.slice(0, 12000)}

Return JSON exactly in this shape:
{
  "tailored_resume": "<the full rewritten resume as plain text, keeping the candidate's real experience but optimized for this job>",
  "changes_made": ["<4-8 bullet summaries of what you changed and why>"]
}`
      }
    ]);
    res.json({ ...result, jobTitle: job.title || job.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- Find more jobs (Adzuna) ----------
app.post('/api/find-jobs', async (req, res) => {
  try {
    const appId = process.env.ADZUNA_APP_ID, appKey = process.env.ADZUNA_APP_KEY;
    if (!appId || !appKey) {
      return res.status(400).json({ error: 'Adzuna keys not configured. Sign up free at https://developer.adzuna.com, then add ADZUNA_APP_ID and ADZUNA_APP_KEY to .env and restart.' });
    }
    const { scanId, preferences = {} } = req.body || {};
    const scan = scans.get(scanId);
    if (!scan) return res.status(410).json({ error: 'Scan session expired — run a scan first, then search for more jobs.' });

    // 1. Model extracts a search query from the resume
    const kw = await callOpenAI([
      { role: 'system', content: 'You extract job-search keywords from resumes. Respond with valid JSON only.' },
      { role: 'user', content: `Based on this resume, produce the best job-search query.\n\nRESUME:\n${scan.resumeText.slice(0, 10000)}\n\nReturn JSON: {"query": "<2-5 word job title/skill search, e.g. 'machine learning engineer'>"}` }
    ]);

    // 2. Search Adzuna (US)
    const params = new URLSearchParams({
      app_id: appId, app_key: appKey,
      what: kw.query || 'software engineer',
      results_per_page: '8',
      'content-type': 'application/json'
    });
    if (preferences.location) params.set('where', preferences.location);
    if (preferences.workType === 'remote') params.set('what_or', (kw.query || '') + ' remote');
    const az = await fetch(`https://api.adzuna.com/v1/api/jobs/us/search/1?${params}`, { signal: AbortSignal.timeout(15000) });
    if (!az.ok) return res.status(502).json({ error: `Adzuna API error (${az.status}). Check your ADZUNA keys.` });
    const azData = await az.json();
    const results = (azData.results || []).map(r => ({
      title: r.title,
      company: r.company?.display_name || '',
      location: r.location?.display_name || '',
      salary: r.salary_min ? `$${Math.round(r.salary_min/1000)}k${r.salary_max ? '–$' + Math.round(r.salary_max/1000) + 'k' : '+'}` : '',
      url: r.redirect_url,
      snippet: (r.description || '').slice(0, 300)
    }));
    res.json({ query: kw.query, results });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, keyConfigured: !!(process.env.OPENAI_API_KEY && !process.env.OPENAI_API_KEY.startsWith('sk-your')) });
});

app.listen(PORT, () => console.log(`AI Resume Scanner running at http://localhost:${PORT}`));
