# AI Resume Scanner

Match your resume against up to 10 job postings using OpenAI. Get per-job fit scores, your best-fit role, and concrete resume edit recommendations.

## How it works

1. Upload your resume (PDF, DOCX, or TXT)
2. Set preferences: work type (remote/hybrid/in-person), expected comp, location
3. Paste up to 10 job posting links (or paste description text if a link is blocked)
4. The server fetches each posting, extracts the description, and sends everything to OpenAI
5. You get: resume-match and preference-match scores per job, an overall best fit, strengths/gaps, and tailored resume edit suggestions

## Setup

**Requirements:** Node.js 18+

```bash
cd resume-scanner
npm install
npm run setup-browser   # downloads Chromium (~300MB) for JS-rendered job pages
cp .env.example .env    # on Windows: copy .env.example .env
```

**Get an OpenAI API key:**
1. Sign up at https://platform.openai.com
2. Add billing (Settings → Billing) — a few dollars is plenty; each scan costs ~$0.01 with gpt-4o-mini
3. Create a key at https://platform.openai.com/api-keys
4. Put it in `.env`: `OPENAI_API_KEY=sk-...`

**Run:**

```bash
npm start
```

Open http://localhost:3000

## Features

- **Scan & match** — per-job resume-fit and preference-fit scores, best-fit pick, strengths/gaps, resume edit suggestions
- **Headless fetching** — if a job page is JavaScript-rendered or blocks simple requests, the server retries with a real (headless) Chromium browser automatically
- **Tailored resume generation** — button on each job card rewrites your resume for that posting (truthfully — no invented experience) with a summary of changes and a .txt download
- **Find more jobs** — searches Adzuna for other postings matching your resume. Requires free API keys: sign up at https://developer.adzuna.com, then set `ADZUNA_APP_ID` and `ADZUNA_APP_KEY` in `.env`

## Notes & limitations

- **Login-required job boards** (LinkedIn, Handshake) still can't be fetched even with the headless browser. Expand "Paste the job description instead" under that link and paste the text.
- Tailored resumes and "find more jobs" need a completed scan first (results are kept in server memory for the last 20 scans; restart clears them).
- Scores are 60% resume fit / 40% preference fit, weighted by the model.
- Change the model in `.env` (`OPENAI_MODEL=gpt-4o` for higher quality, more cost).

## Future ideas (from the original spec)

- **Recruiter profiles / alumni network:** LinkedIn has no public API for this; would require a data partner or manual curation.
- **RAG job pool:** persist scraped/searched postings with embeddings and retrieve best matches per resume automatically.
