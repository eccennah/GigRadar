// GigRadar: one Actor, one autonomous agent. An LLM orchestrator looks at the current state and decides which tool to
// call next (find jobs, score pasted posts, check messages, schedule interviews, research companies, tailor the resume).
// If the LLM is unavailable, a rule-based planner makes the same kind of decisions so the run always completes.
import { Actor, log } from 'apify';

import { runDiscovery } from './discovery/run.js';
import { scheduleInterviewFor, writeBriefFor } from './lifecycle/actions.js';
import { getAccessToken, googleConfigFromEnv } from './lifecycle/google.js';
import { runLifecycle } from './lifecycle/run.js';
import { chatWithTools, llmConfigFromEnv } from './llm.js';
import { diffByRules, matchScore, parseResume } from './tailoring/resume.js';
import { runTailoring } from './tailoring/run.js';

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    goal = '',
    targetRole = '',
    location = 'Nigeria',
    remotePreference = 'any',
    pastedJobs = [],
    messages = [],
    applications = [],
    readGmail = false,
    resumeText = '',
    jobText = '',
    useLlm = true,
    maxSteps = 8,
    maxTailoredJobs = 2,
    applicationsStoreName = 'gigradar-agent-applications',
} = input;

// Tool options that pass straight through from the input (thresholds, limits, stores).
const discoveryOptions = {
    location,
    remotePreference,
    maxPagesPerSource: input.maxPagesPerSource,
    maxJobsPerSource: input.maxJobsPerSource,
    scamRiskThreshold: input.scamRiskThreshold,
    hireabilityThreshold: input.hireabilityThreshold,
    includeSuppressed: input.includeSuppressed,
    onlyMatchingRoles: input.onlyMatchingRoles,
    useLlm,
    maxLlmCalls: input.maxLlmCalls,
    seenJobsStoreName: input.seenJobsStoreName,
    resetSeenJobs: input.resetSeenJobs,
};

// ---------------------------------------------------------------------------
// Shared state the orchestrator observes.
// ---------------------------------------------------------------------------
const store = await Actor.openKeyValueStore(applicationsStoreName);
if (input.resetApplications) {
    for (const key of ['APPLICATIONS', 'PROCESSED', 'LAST_GMAIL_SYNC']) await store.setValue(key, null);
}
const state = { jobs: [], tailored: new Set(), done: new Set(), steps: [] };
const loadApplications = async () => (await store.getValue('APPLICATIONS')) ?? {};

let googleToken;
async function google() {
    if (googleToken !== undefined) return googleToken;
    googleToken = null;
    const config = googleConfigFromEnv();
    if (config) {
        try {
            googleToken = await getAccessToken(config);
        } catch (error) {
            log.warning(error.message);
        }
    }
    return googleToken;
}
const charge = async (eventName) => Actor.charge({ eventName });
const llm = useLlm ? llmConfigFromEnv() : null;
let briefLlmCalls = 0;
const askLlm = async (fn) => {
    if (briefLlmCalls >= 5) return null;
    briefLlmCalls++;
    try {
        return await fn();
    } catch (error) {
        log.warning(`LLM failed, using rules: ${error.message}`);
        return null;
    }
};

async function observe() {
    const apps = Object.values(await loadApplications());
    return {
        goal: goal || 'Help me find safe jobs I can actually get, keep track of my applications, and prepare me.',
        profile: { target_role: targetRole, location, remote_preference: remotePreference },
        inputs: {
            pasted_job_posts: pastedJobs.length,
            pasted_messages: messages.length + applications.length,
            gmail_connected: Boolean(readGmail && googleConfigFromEnv()),
            resume_provided: resumeText.trim().length >= 100,
            pasted_job_to_tailor: Boolean(jobText.trim()),
        },
        jobs_found_this_run: state.jobs
            .filter((j) => j.decision !== 'unlikely_hireable' || state.jobs.length < 15)
            .slice(0, 15)
            .map((j) => ({
                id: j.id,
                role: j.role,
                company: j.company,
                decision: j.decision,
                scam_risk_score: j.scam_risk_score,
                hireability_score: j.hireability_score,
                resume_tailored: state.tailored.has(j.id),
            })),
        applications: apps.slice(0, 20).map((a) => ({
            id: a.id,
            company: a.company,
            role: a.role,
            status: a.status,
            interview_date: a.interview_date,
            calendar_done: Boolean(a.calendar_event_link || a.calendar_file_key),
            prep_brief_done: Boolean(a.interview_prep_key),
        })),
        tools_already_called: [...state.done],
    };
}

// ---------------------------------------------------------------------------
// Tools. Each returns a short summary the orchestrator reads before deciding again.
// ---------------------------------------------------------------------------
const TOOLS = {
    scrape_sources: {
        description:
            'Find jobs on Jobberman and MyJobMag for the user profile, then score each for scam risk and hireability from Nigeria and keep only safe jobs in the user field. Charges per job delivered or scam flagged.',
        parameters: {
            type: 'object',
            properties: {
                target_role: { type: 'string', description: 'Role to search for; defaults to the profile' },
                remote_preference: { type: 'string', enum: ['any', 'remote', 'hybrid', 'onsite'] },
            },
        },
        available: () => Boolean(targetRole.trim()),
        run: async (args) => {
            const { jobs, stats } = await runDiscovery({
                ...discoveryOptions,
                targetRole: args.target_role || targetRole,
                remotePreference: args.remote_preference || remotePreference,
                sources: ['jobberman', 'myjobmag'],
            });
            state.jobs.push(...jobs);
            return {
                available: stats.available,
                scam_flagged: stats.scam_flagged,
                unlikely_hireable: stats.unlikely_hireable,
                not_in_field: stats.notRelevant,
                duplicates: stats.duplicates,
            };
        },
    },
    score_job: {
        description:
            'Score the job posts the user pasted (from WhatsApp, Telegram job channels, flyers) for scam risk and hireability. Use this before trusting any pasted post.',
        parameters: { type: 'object', properties: {} },
        available: () => pastedJobs.length > 0,
        run: async () => {
            const { jobs, stats } = await runDiscovery({
                ...discoveryOptions,
                targetRole,
                pastedJobs,
                sources: ['pasted'],
            });
            state.jobs.push(...jobs);
            return {
                scored: jobs.map((j) => ({
                    id: j.id,
                    role: j.role,
                    decision: j.decision,
                    scam_risk_score: j.scam_risk_score,
                    scam_reasons: j.scam_reasons.slice(0, 3),
                })),
                not_job_posts: stats.notAJob,
            };
        },
    },
    check_email: {
        description:
            'Read new application emails and messages (pasted, and Gmail if connected), classify each (applied, interview, rejected) and flag ghosted applications. Detects interviews but does not schedule them.',
        parameters: { type: 'object', properties: {} },
        available: () => messages.length > 0 || applications.length > 0 || readGmail,
        run: async () => {
            const result = await runLifecycle(
                {
                    ...input,
                    applicationsStoreName,
                    resetApplications: false,
                    scheduleInterviews: false,
                    interviewPrep: false,
                    useLlm,
                },
                { jobs: state.jobs },
            );
            return {
                status_changes: result.stats.statusChanges,
                interviews: result.stats.interviews,
                ghosted: result.stats.ghosted,
                changed: result.applications.map((a) => ({
                    id: a.id,
                    company: a.company,
                    role: a.role,
                    status: a.status,
                    interview_date: a.interview_date,
                })),
            };
        },
    },
    schedule_calendar: {
        description:
            'Add an interview to the user calendar with reminders (Google Calendar, or an .ics file). Needs an application with interview_date.',
        parameters: {
            type: 'object',
            properties: { application_id: { type: 'string' } },
            required: ['application_id'],
        },
        available: async () =>
            Object.values(await loadApplications()).some(
                (a) => a.interview_date && !a.calendar_event_link && !a.calendar_file_key,
            ),
        run: async ({ application_id: id }) => {
            const apps = await loadApplications();
            const app = Object.values(apps).find((a) => a.id === id);
            if (!app) return { error: `No application with id ${id}` };
            const result = await scheduleInterviewFor(app, {
                googleToken: await google(),
                createCalendarEvents: input.createCalendarEvents ?? true,
                timeZone: input.timeZone,
                charge,
            });
            await store.setValue('APPLICATIONS', apps);
            if (result.done)
                await Actor.pushData({
                    record_type: 'application',
                    ...withoutInternals(app),
                    events: [{ type: 'interview_scheduled', detail: result.detail }],
                });
            return result;
        },
    },
    research_company: {
        description:
            'Research the company behind an interview and write a prep brief (company summary, likely focus areas, questions to ask).',
        parameters: {
            type: 'object',
            properties: { application_id: { type: 'string' } },
            required: ['application_id'],
        },
        available: async () =>
            Object.values(await loadApplications()).some(
                (a) => a.status === 'interview_scheduled' && !a.interview_prep_key,
            ),
        run: async ({ application_id: id }) => {
            const apps = await loadApplications();
            const app = Object.values(apps).find((a) => a.id === id);
            if (!app) return { error: `No application with id ${id}` };
            const job = state.jobs.find(
                (j) =>
                    j.id === app.job_id || (j.company && j.company.toLowerCase() === String(app.company).toLowerCase()),
            );
            const result = await writeBriefFor(app, { llm, askLlm, requirements: job?.requirements ?? [], charge });
            await store.setValue('APPLICATIONS', apps);
            if (result.done)
                await Actor.pushData({
                    record_type: 'application',
                    ...withoutInternals(app),
                    events: [{ type: 'prep_brief_generated', detail: result.detail }],
                });
            return result;
        },
    },
    tailor_resume: {
        description: `Tailor the user resume to one job: keep matches, honestly reword related experience, flag real gaps. Use job_id from jobs_found_this_run, or "pasted" for the job the user pasted. Only worth it for safe, hireable jobs; at most ${maxTailoredJobs} per run.`,
        parameters: { type: 'object', properties: { job_id: { type: 'string' } }, required: ['job_id'] },
        available: () => resumeText.trim().length >= 100 && state.tailored.size < maxTailoredJobs,
        run: async ({ job_id: id }) => {
            if (state.tailored.size >= maxTailoredJobs) return { error: 'Tailoring limit for this run reached' };
            const job =
                id === 'pasted'
                    ? {
                          id: 'pasted',
                          role: input.jobTitle ?? '',
                          company: input.jobCompany ?? '',
                          description: jobText,
                      }
                    : (() => {
                          const j = state.jobs.find((x) => x.id === id);
                          return (
                              j && {
                                  id: j.id,
                                  role: j.role,
                                  company: j.company,
                                  url: j.url,
                                  description: j.raw_excerpt,
                                  requirements: j.requirements,
                              }
                          );
                      })();
            if (!job || (id === 'pasted' && !jobText.trim())) return { error: `No job with id ${id}` };
            const result = await runTailoring({ resumeText, job, useLlm });
            state.tailored.add(id);
            return {
                match_score: result.match_score,
                gaps: result.gaps.map((g) => g.requirement),
                rewrites: result.rewrites.length,
                saved_as: result.key,
            };
        },
    },
};

function withoutInternals(app) {
    const { thread_keys: _t, interview_message: _m, ...rest } = app;
    return rest;
}

async function runTool(name, args, planner) {
    const tool = TOOLS[name];
    const key = `${name}(${JSON.stringify(args ?? {})})`;
    if (!tool) return { error: `Unknown tool ${name}` };
    if (state.done.has(key)) return { error: 'Already called with these arguments this run' };
    state.done.add(key);
    log.info(`[AGENT ${planner}] step ${state.steps.length + 1}: ${key}`);
    let result;
    try {
        result = await tool.run(args ?? {});
    } catch (error) {
        result = { error: error.message };
    }
    state.steps.push({ step: state.steps.length + 1, planner, tool: name, args: args ?? {}, result });
    log.info(`[AGENT ${planner}]   -> ${JSON.stringify(result).slice(0, 300)}`);
    return result;
}

// ---------------------------------------------------------------------------
// Planner 1: the LLM decides (tool calling).
// ---------------------------------------------------------------------------
const SYSTEM_PROMPT = `You are GigRadar, an autonomous job-search agent for a job seeker based in Nigeria.
Each turn you get the current state as JSON. Decide which tools to call now, and with what arguments, to move the user forward:
safe jobs they can realistically get, up-to-date applications, interviews in the calendar, prep for interviews, and a resume
tailored to the best matches. Only call tools whose inputs exist (see "inputs"). Never repeat a tool call with the same arguments.
Prefer the user's goal. When nothing more is worth doing, stop calling tools and reply with a one-sentence summary of what you did.`;

async function planWithLlm() {
    const toolDefs = Object.entries(TOOLS).map(([name, t]) => ({
        type: 'function',
        function: { name, description: t.description, parameters: t.parameters },
    }));
    const conversation = [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `Current state:\n${JSON.stringify(await observe())}` },
    ];
    for (let turn = 0; turn < maxSteps; turn++) {
        const { model, message } = await chatWithTools(llm, { messages: conversation, tools: toolDefs });
        const calls = message.tool_calls ?? [];
        if (!calls.length) {
            log.info(`[AGENT llm:${model}] finished: ${String(message.content ?? '').slice(0, 300)}`);
            return true;
        }
        conversation.push({ role: 'assistant', content: message.content ?? null, tool_calls: calls });
        for (const call of calls) {
            let args = {};
            try {
                args = JSON.parse(call.function?.arguments || '{}');
            } catch {
                // keep empty args
            }
            const result = await runTool(call.function?.name, args, `llm:${model}`);
            conversation.push({
                role: 'tool',
                tool_call_id: call.id,
                name: call.function?.name,
                content: JSON.stringify(result).slice(0, 4000),
            });
        }
        conversation.push({ role: 'user', content: `Updated state:\n${JSON.stringify(await observe())}` });
    }
    return true;
}

// ---------------------------------------------------------------------------
// Planner 2: rules decide, from the same observed state. Used when the LLM is off or unavailable.
// ---------------------------------------------------------------------------
async function nextActionByRules() {
    const s = await observe();
    const notDone = (name, args = {}) => !state.done.has(`${name}(${JSON.stringify(args)})`);
    if (s.inputs.pasted_job_posts && notDone('score_job')) return ['score_job', {}];
    if (s.profile.target_role && notDone('scrape_sources')) return ['scrape_sources', {}];
    if ((s.inputs.pasted_messages || s.inputs.gmail_connected) && notDone('check_email')) return ['check_email', {}];
    for (const a of s.applications) {
        if (
            a.status === 'interview_scheduled' &&
            a.interview_date &&
            !a.calendar_done &&
            notDone('schedule_calendar', { application_id: a.id })
        )
            return ['schedule_calendar', { application_id: a.id }];
        if (
            a.status === 'interview_scheduled' &&
            !a.prep_brief_done &&
            notDone('research_company', { application_id: a.id })
        )
            return ['research_company', { application_id: a.id }];
    }
    if (s.inputs.resume_provided && state.tailored.size < maxTailoredJobs) {
        if (s.inputs.pasted_job_to_tailor && notDone('tailor_resume', { job_id: 'pasted' }))
            return ['tailor_resume', { job_id: 'pasted' }];
        const best = s.jobs_found_this_run
            .filter(
                (j) => j.decision === 'available' && !j.resume_tailored && notDone('tailor_resume', { job_id: j.id }),
            )
            // Tailor where the resume already fits best: a quick rule match against each job's requirements.
            .map((j) => {
                const full = state.jobs.find((x) => x.id === j.id);
                const fit = full?.requirements?.length
                    ? matchScore(diffByRules(full.requirements, parseResume(resumeText)))
                    : 0;
                return { ...j, fit };
            })
            .filter((j) => j.fit > 0)
            .sort((a, b) => b.fit - a.fit || b.hireability_score - a.hireability_score)[0];
        if (best) return ['tailor_resume', { job_id: best.id }];
    }
    return null;
}

async function planWithRules() {
    for (let i = 0; i < 20; i++) {
        const next = await nextActionByRules();
        if (!next) break;
        await runTool(next[0], next[1], 'rules');
    }
}

// ---------------------------------------------------------------------------
// Run.
// ---------------------------------------------------------------------------
log.info(`GigRadar starting. Planner: ${llm ? `LLM (${llm.model}) with rule fallback` : 'rules'}`);
// The LLM decides. The rule planner only takes over when the LLM is off or fails, and then finishes the run.
let llmFinished = false;
if (llm) {
    try {
        llmFinished = await planWithLlm();
    } catch (error) {
        log.warning(`LLM planner unavailable (${error.message.slice(0, 150)}). Finishing with the rule planner.`);
    }
}
if (!llmFinished) await planWithRules();

await Actor.setValue('AGENT_LOG', { goal, steps: state.steps });
log.info(
    `Done: ${state.steps.length} tool calls. The full decision log is in the AGENT_LOG record of the key-value store.`,
);
await Actor.exit();
