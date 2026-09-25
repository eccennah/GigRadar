## What does GigRadar do?

**GigRadar is an AI job-search agent for people in Nigeria.** It is not a job scraper. It is an **autonomous agent** that looks at where you are in your job search and **decides what to do next**:

- 🛡️ **Is this job a scam?** Every job, from job boards or pasted from **WhatsApp and Telegram job channels**, gets a **scam-risk score** with reasons (upfront "registration fees", BVN requests, WhatsApp-only contact, too-good-to-be-true pay).
- 🌍 **Can you actually get it?** A **hireability score** catches "remote, US only", visa and payment restrictions that silently block Nigeria-based applicants.
- 📬 **Where do my applications stand?** It reads recruiter emails and messages, tracks each application (applied, interview, rejected), and flags **ghosting**. It knows "unfortunately Tuesday doesn't work, can we do Thursday?" is a **rescheduled interview**, not a rejection.
- 📅 **Interview coming up?** It adds it to your calendar with reminders and writes a **prep brief** from the company's own website and the job's requirements.
- ✏️ **Tailor my resume.** It rewords what you already did to match the best jobs, and **flags real gaps instead of inventing experience**. Any rewrite that adds a tool, number or skill your resume doesn't have is rejected automatically.

## How the agent works

An LLM **orchestrator** observes the current state (jobs found, open applications, interviews without a calendar entry or brief, whether you gave a resume) and **chooses which tool to call next**, with what arguments, until nothing more is worth doing:

| Tool | What it does |
| --- | --- |
| `scrape_sources` | Picks the right job-board categories and city pages for your role, crawls Jobberman and MyJobMag, scores and filters every job |
| `score_job` | Scores job posts you pasted (WhatsApp, Telegram channels, flyers) |
| `check_email` | Reads pasted messages (and Gmail when connected), updates application status, detects ghosting |
| `schedule_calendar` | Adds an interview to Google Calendar, or creates a calendar file any phone can open |
| `research_company` | Researches the company and writes an interview-prep brief |
| `tailor_resume` | Tailors your resume to one job, honestly |

Every decision is written to the **`AGENT_LOG`** record, so you can see what the agent chose and why. If the LLM provider is down, a **rule-based planner** makes the decisions from the same state, so a run never fails.

## Why GigRadar?

- **Job scams are common** on informal channels. GigRadar checks a post before you pay anyone anything.
- **"Remote" often isn't remote for Nigerians.** GigRadar tells you before you apply.
- **One agent for the whole search**: finding, checking, tracking, scheduling, preparing and tailoring.
- **Built on Apify**: schedule it every morning, call it from your own app through the API, and keep your jobs and applications in Apify storage between runs.

## How much does it cost?

GigRadar uses **pay per event**. You only pay when the agent delivers something:

| Event | When |
| --- | --- |
| `job_normalized` | A safe, hireable job in your field reached your feed |
| `scam_flag_issued` | A job was flagged as a likely scam |
| `status_change_detected` | An application changed state (applied, interview, rejected, ghosted) |
| `interview_scheduled` | An interview was added to your calendar |
| `interview_prep_generated` | An interview-prep brief was written |
| `resume_tailored` | Your resume was tailored to a job |

Duplicates, reposts, jobs outside your field and messages that change nothing are free. See the **Pricing** tab.

## How to use it

1. Enter your **target role**, **location** and **remote preference**.
2. Paste job posts you want checked, recruiter messages, and your resume. All optional.
3. Optionally tell it what you want in **What should GigRadar do?**
4. Click **Start**. Results are in the dataset (`record_type`: `job`, `application` or `tailoring`); calendar files, prep briefs, tailored resumes and the `AGENT_LOG` are in the key-value store.

You can download the dataset in various formats such as JSON, HTML, CSV, or Excel.

## Setup for the AI and Google features

- **LLM (optional):** set `LLM_API_KEY` (secret), `LLM_BASE_URL` and `LLM_MODEL` on the Actor. Any OpenAI-compatible provider works, including Google AI Studio's free tier: GigRadar only calls the LLM when rules are unsure and caps calls per run.
- **Gmail and Calendar (optional):** run `node scripts/google-auth.mjs` once, then add `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `GOOGLE_REFRESH_TOKEN` (secrets). GigRadar asks for read-only Gmail and permission to create calendar events. It never sends email.

## FAQ

### Is a low scam score a guarantee?

No. Scores are signals with reasons, not proof. Never pay money to get a job.

### Is my data shared?

Your jobs, applications and resume stay in your own Apify account. If you enable the LLM, the text it reads is sent to the LLM provider you configured.

### Legal

GigRadar only reads pages the job boards allow in their robots.txt, at a low request rate, and only public job listings.

Found a problem? Open an issue in the **Issues** tab. To run GigRadar from your own code, see the **API** tab.
