## What does GigRadar Discovery Agent do?

**GigRadar Discovery Agent** finds job listings for people based in **Nigeria** and decides which ones are worth their time. It is not another job scraper: for every listing it makes three decisions a scraper can't.

- 🛡️ **Is it a scam?** A **scam-risk score (0-100)** looks for upfront fees, requests for BVN or card details, "earn ₦50,000 weekly" promises, WhatsApp-only contact and missing company details.
- 🌍 **Can you actually get hired?** A **hireability score (0-100)** checks for work-authorization, visa, time-zone and payment restrictions that silently block Nigeria-based applicants.
- 🔁 **Have you seen it before?** Reposts across job boards and runs are detected and never delivered or charged twice.

Every score comes with **plain-language reasons**, so you can see why a job was flagged.

It reads [Jobberman](https://www.jobberman.com) and [MyJobMag](https://www.myjobmag.com), and job posts you paste in from WhatsApp, Telegram or flyers.

## Why use GigRadar?

- **Avoid job scams.** Fake "registration fee" jobs are common on informal channels. Paste any post you received and get a verdict with reasons.
- **Stop applying to jobs that can't hire you.** "Remote" often means "remote, US only". GigRadar marks those as unlikely before you spend time on them.
- **A feed chosen for you.** The agent decides which job boards, categories and city pages to search based on your role, location and remote preference. A developer and an accountant get different searches.
- **Runs on Apify.** Schedule it daily, call it from the API, or connect it to Zapier, Make, Google Sheets or your own app.

## What data does GigRadar extract?

| Field | Description |
| --- | --- |
| `decision` | `available`, `scam_flagged` or `unlikely_hireable` |
| `role`, `company`, `location` | Job basics |
| `salary_range` | Salary when the listing states one |
| `remote_type` | `remote`, `hybrid` or `onsite` |
| `scam_risk_score` | 0-100, higher is riskier |
| `scam_reasons` | Why the listing looks risky |
| `hireability_score` | 0-100, how realistic it is to be hired from Nigeria |
| `hireability_reasons` | What helps or blocks a Nigeria-based applicant |
| `requirements` | Requirement statements pulled from the listing |
| `application_method` | How to apply (email, link, or the job board) |
| `url`, `source` | Where the listing came from |

## How to find safe jobs with GigRadar

1. Enter your **target role**, e.g. `frontend developer` or `accountant`.
2. Enter **your location**, e.g. `Lagos, Nigeria`, and choose a **remote preference**.
3. Optionally, paste job posts you received on WhatsApp or Telegram into **Pasted job posts**.
4. Click **Start**.
5. Open the **Job feed** view for the results, or the **Why** view to read the reasons behind each score.

## How much does GigRadar cost?

GigRadar uses **pay per event**, so you only pay for decisions it delivers:

- **`job_normalized`**: a job that passed both checks and reached your feed.
- **`scam_flag_issued`**: a listing the agent flagged as a likely scam.

Listings that are duplicates, not job posts, or unlikely to hire you are **not charged**. See the **Pricing** tab for current prices. You can cap what a run spends with the maximum charge setting when you start it; the agent stops cleanly when it reaches the cap.

## Input

See the **Input** tab for all options. The important ones:

- **Target role** decides which sources and categories are searched.
- **Pasted job posts**: one post per item. Useful for checking a single suspicious message.
- **Scam-risk threshold** (default 60) and **hireability threshold** (default 40) control what gets flagged.
- **Include flagged and unlikely jobs in output**: turn this off to receive only available jobs.

## Output

You can download the dataset in various formats such as JSON, HTML, CSV, or Excel.

```json
[
    {
        "decision": "available",
        "role": "Senior Full-Stack Developer — C#/.NET and React",
        "company": "Zealight Innovation Labs",
        "location": "Lagos",
        "remote_type": "onsite",
        "scam_risk_score": 0,
        "scam_reasons": [],
        "hireability_score": 90,
        "hireability_reasons": ["Located in Nigeria (Lagos)"],
        "source": "myjobmag"
    },
    {
        "decision": "scam_flagged",
        "role": "Online data entry",
        "company": "",
        "scam_risk_score": 100,
        "scam_reasons": [
            "Asks the applicant to pay (registration, training, form or processing fee, or deposit)",
            "Promises unusually easy or fast money",
            "Pushes the conversation to WhatsApp/Telegram",
            "Uses a free email address instead of a company domain"
        ],
        "source": "pasted"
    }
]
```

Each run also saves `RUN_PLAN` (which sources the agent chose and why) and `SUMMARY` (counts per decision and events charged) to the key-value store.

## Tips and advanced options

### AI-assisted scoring (optional)

Scoring works with rules alone. To add an LLM second opinion and better extraction from messy pasted text, set these **environment variables** on the Actor (mark the key as secret):

- `LLM_API_KEY`: your provider's API key
- `LLM_BASE_URL`: any OpenAI-compatible endpoint, e.g. `https://generativelanguage.googleapis.com/v1beta/openai` for Google AI Studio (default `https://api.openai.com/v1`)
- `LLM_MODEL`: the model id, or a comma-separated list tried in order when a model is overloaded, e.g. `gemini-3.5-flash,gemini-3.5-flash-lite,gemma-4-31b-it`

The LLM is only asked about listings the rules are unsure of: pasted text, listings with any warning sign, and jobs where hireability from Nigeria is unclear. Clean listings from structured job boards never use it, and **Max LLM calls per run** caps the rest, so the agent runs comfortably on a free-tier key. If the provider is overloaded, the run switches to rules only after three failures in a row.

The LLM can raise a scam score but never lower it below what the rules found.

### Faster, cheaper runs

Lower **Max jobs per source** and **Listing pages per source**. Duplicates are skipped before any LLM call, so scheduled daily runs mostly pay for new jobs only.

## FAQ, disclaimers, and support

### Is a low scam score a guarantee?

No. Scores are signals, not proof. Never pay money to get a job, and verify the employer yourself.

### Why was a real job marked unlikely hireable?

Read `hireability_reasons`. Usually the listing restricts location, work authorization or payment. If the reasons are wrong, lower the hireability threshold or report it in the **Issues** tab.

### Legal

Our Actors are ethical and do not extract any private user data, such as email addresses, gender, or location. They only extract what the user has chosen to share publicly. We therefore believe that our Actors, when used for ethical purposes by Apify users, are safe. However, you should be aware that your results could contain personal data. Personal data is protected by the GDPR in the European Union and by other regulations around the world. You should not scrape personal data unless you have a legitimate reason to do so. If you're unsure whether your reason is legitimate, consult your lawyers.

GigRadar reads only pages the job boards allow in their robots.txt, at a low request rate.

Found a problem or have an idea? Open an issue in the **Issues** tab. To run GigRadar from your own code, see the **API** tab.
