// Lifecycle tool (check_email): reads application emails and messages, works out what state each application is in,
// and acts on it: schedules interviews (with reminders), writes a prep brief, and flags ghosting.
import { createHash } from 'node:crypto';

import { Actor, log } from 'apify';

import { llmConfigFromEnv } from '../llm.js';
import { scheduleInterviewFor, writeBriefFor } from './actions.js';
import {
    classifyByRules,
    classifyWithLlm,
    companyDomain,
    guessCompany,
    guessRole,
    parseInterviewTime,
} from './classify.js';
import { fetchGmailMessages, getAccessToken, googleConfigFromEnv } from './google.js';
import { applyTransition, findApplication, normalizeCompany, normalizePasted } from './state.js';

/**
 * Read new messages, classify them and update application records.
 * With scheduleInterviews/interviewPrep off, interviews are only detected, so the orchestrator can decide to call
 * schedule_calendar and research_company itself.
 */
export async function runLifecycle(input = {}, { jobs = [] } = {}) {
    const {
        messages: pastedMessages = [],
        applications: seedApplications = [],
        readGmail = false,
        gmailLookbackDays = 30,
        createCalendarEvents = true,
        timeZone = 'Africa/Lagos',
        ghostedAfterDays = 14,
        interviewPrep = true,
        scheduleInterviews = true,
        jobsDatasetId = '',
        useLlm = true,
        maxLlmCalls = 10,
        applicationsStoreName = 'gigradar-agent-applications',
        resetApplications = false,
    } = input;

    const now = new Date();
    const store = await Actor.openKeyValueStore(applicationsStoreName);
    if (resetApplications) {
        await store.setValue('APPLICATIONS', null);
        await store.setValue('PROCESSED', null);
        await store.setValue('LAST_GMAIL_SYNC', null);
    }
    const applications = (await store.getValue('APPLICATIONS')) ?? {};
    const processed = new Set((await store.getValue('PROCESSED')) ?? []);

    const stats = {
        messages: 0,
        alreadyProcessed: 0,
        notJobRelated: 0,
        statusChanges: 0,
        interviews: 0,
        briefs: 0,
        ghosted: 0,
        llmCalls: 0,
        llmErrors: 0,
        charged: {},
    };
    const changed = new Map(); // application key -> list of events this run
    const note = (key, type, detail) => {
        if (!changed.has(key)) changed.set(key, []);
        changed.get(key).push({ type, detail, at: new Date().toISOString() });
    };
    let budgetReached = false;
    async function charge(eventName) {
        const result = await Actor.charge({ eventName });
        stats.charged[eventName] = (stats.charged[eventName] ?? 0) + 1;
        if (result.eventChargeLimitReached) budgetReached = true;
    }

    // Applications the user tells us about (e.g. ones sent through a job board), so ghosting can be detected.
    for (const seed of seedApplications) {
        if (!seed?.company) continue;
        const key = normalizeCompany(seed.company) + (seed.role ? `|${normalizeCompany(seed.role)}` : '');
        if (applications[key]) continue;
        applications[key] = {
            id: createHash('sha1').update(key).digest('hex').slice(0, 16),
            job_id: seed.job_id ?? null,
            company: seed.company,
            role: seed.role ?? '',
            status: 'applied',
            channel: seed.channel ?? 'email',
            applied_on: seed.applied_on ?? now.toISOString(),
            last_contact_date: seed.applied_on ?? now.toISOString(),
            last_inbound_date: null,
            interview_date: null,
            interview_prep_brief: null,
            thread_keys: [],
        };
        note(key, 'added', 'Application added from input');
    }

    // ---------------------------------------------------------------------------
    // Step 1: fetch new messages since the last run.
    // ---------------------------------------------------------------------------
    const messages = pastedMessages.map((m, i) => normalizePasted(m, i, now)).filter(Boolean);
    const google = googleConfigFromEnv();
    let googleToken = null;
    if (google && (readGmail || createCalendarEvents)) {
        try {
            googleToken = await getAccessToken(google);
        } catch (error) {
            log.warning(`${error.message} Continuing without Gmail and Google Calendar.`);
        }
    }
    if (readGmail) {
        if (!googleToken) {
            log.warning(
                'readGmail is on, but Google is not connected (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN). Skipping Gmail.',
            );
        } else {
            const lastSync = await store.getValue('LAST_GMAIL_SYNC');
            const since = lastSync ?? Math.floor(now.getTime() / 1000) - gmailLookbackDays * 86400;
            const { me, messages: mail } = await fetchGmailMessages(googleToken, { sinceEpochSeconds: since });
            log.info(
                `Gmail (${me}): ${mail.length} job-related messages since ${new Date(since * 1000).toISOString().slice(0, 10)}`,
            );
            messages.push(...mail);
        }
    }
    messages.sort((a, b) => new Date(a.date) - new Date(b.date));
    log.info(`${messages.length} messages to read, ${Object.keys(applications).length} applications on record`);

    // Jobs from the Discovery Agent, to link applications to requirements for the prep brief.
    const jobsById = new Map();
    for (const job of jobs) if (job?.id) jobsById.set(job.id, job);
    if (jobsDatasetId) {
        const dataset = await Actor.openDataset(jobsDatasetId);
        await dataset.forEach(async (job) => {
            if (job?.id) jobsById.set(job.id, job);
        });
        log.info(`Loaded ${jobsById.size} jobs from Discovery dataset ${jobsDatasetId}`);
    }
    const requirementsFor = (app) => {
        if (app.job_id && jobsById.has(app.job_id)) return jobsById.get(app.job_id).requirements ?? [];
        const match = [...jobsById.values()].find((j) => normalizeCompany(j.company) === normalizeCompany(app.company));
        return match?.requirements ?? [];
    };

    // ---------------------------------------------------------------------------
    // Steps 2-4: classify each message, decide the next action, update the application.
    // ---------------------------------------------------------------------------
    const llm = useLlm ? llmConfigFromEnv() : null;
    log.info(llm ? `LLM enabled (${llm.model})` : 'LLM disabled: rules only');

    async function askLlm(fn) {
        if (!llm || stats.llmCalls >= maxLlmCalls) return null;
        stats.llmCalls++;
        try {
            return await fn();
        } catch (error) {
            stats.llmErrors++;
            log.warning(`LLM failed, using rules: ${error.message}`);
            return null;
        }
    }

    async function scheduleInterview(key, app) {
        const result = await scheduleInterviewFor(app, { googleToken, createCalendarEvents, timeZone, charge });
        if (result.done) note(key, 'interview_scheduled', result.detail);
    }

    async function writePrepBrief(key, app) {
        const result = await writeBriefFor(app, { llm, askLlm, requirements: requirementsFor(app), charge });
        if (result.done) {
            stats.briefs++;
            note(key, 'prep_brief_generated', result.detail);
        }
    }

    for (const message of messages) {
        if (budgetReached) break;
        stats.messages++;
        if (processed.has(message.id)) {
            stats.alreadyProcessed++;
            continue;
        }
        processed.add(message.id);

        // Classify: rules first, the LLM when the rules are unsure or an interview time is missing.
        const rules = classifyByRules(message);
        let { status } = rules;
        let reason = rules.reasons.join('; ');
        let company = guessCompany(message);
        let role = guessRole(message);
        let interviewDate =
            status === 'interview_scheduled' ? parseInterviewTime(`${message.subject}\n${message.body}`, now) : null;
        let interviewTimezone = null;
        let interviewFormat = null;

        // Only spend an LLM call on messages that look like they are about an application.
        const looksJobRelated =
            rules.confident ||
            rules.reasons[0]?.startsWith('Unclear') ||
            /(^|[^a-z])(interview|application|applied|applying|recruit[a-z]*|hiring|candidate|position|offer letter)([^a-z]|$)/i.test(
                `${message.subject} ${message.body}`,
            );
        const needsLlm =
            message.direction !== 'outbound' &&
            looksJobRelated &&
            (!rules.confident || (status === 'interview_scheduled' && !interviewDate) || !company);
        const ai = needsLlm ? await askLlm(async () => classifyWithLlm(llm, message, now)) : null;
        if (ai) {
            if (!ai.isJobRelated) {
                stats.notJobRelated++;
                continue;
            }
            if (!rules.confident) [status, reason] = [ai.status, ai.reason];
            company = company || ai.company;
            role = role || ai.role;
            interviewDate = interviewDate ?? ai.interviewDatetime;
            interviewTimezone = ai.interviewTimezone;
            interviewFormat = ai.interviewFormat;
        }
        if (!company && status === 'no_change') {
            stats.notJobRelated++;
            continue;
        }

        // Find the application this message belongs to. Only a real status (or a message the user sent) starts a new one,
        // so newsletters from a company do not create applications.
        const { key, app } = findApplication(applications, {
            message,
            company,
            role,
            now,
            create: status !== 'no_change',
        });
        if (!app) {
            stats.notJobRelated++;
            continue;
        }
        app.thread_keys = [...new Set([...(app.thread_keys ?? []), message.thread_key].filter(Boolean))];
        app.last_contact_date = message.date;
        if (message.direction === 'inbound') app.last_inbound_date = message.date;
        if (role && !app.role) app.role = role;

        // Decide (no human review): apply the transition and act on it.
        const previous = app.status;
        const transition = applyTransition(app, status);
        if (!transition.changed) {
            if (message.direction === 'inbound' && previous === 'ghosted') {
                app.status = 'applied';
                note(key, 'status_change', 'They replied: no longer ghosted');
            }
            continue;
        }
        stats.statusChanges++;
        note(key, 'status_change', `${previous ?? 'new'} -> ${app.status}: ${reason}`);
        log.info(
            `[${app.status.toUpperCase()}] ${app.role || 'role'} at ${app.company || 'unknown company'} (${reason})`,
        );
        await charge('status_change_detected');

        if (app.status === 'interview_scheduled') {
            stats.interviews++;
            app.interview_date = interviewDate;
            app.interview_timezone = interviewTimezone;
            app.interview_format = interviewFormat;
            // Keep what the tools need to schedule and research later, even in a later step of the run.
            app.interview_message = {
                from: message.from,
                subject: message.subject,
                body: String(message.body ?? '').slice(0, 3000),
            };
            app.company_domain = companyDomain(message);
            if (interviewDate && scheduleInterviews) await scheduleInterview(key, app);
            else if (interviewDate) note(key, 'interview_detected', `Interview on ${interviewDate}: not scheduled yet`);
            else
                note(
                    key,
                    'interview_time_unknown',
                    'Interview invite found but no time was stated: reply to confirm a time',
                );
            if (interviewPrep && !budgetReached) await writePrepBrief(key, app);
        }
    }

    // Ghosting: applications with no reply after N days.
    for (const [key, app] of Object.entries(applications)) {
        if (budgetReached) break;
        const last = new Date(app.last_inbound_date ?? app.last_contact_date ?? app.applied_on);
        const days = (now - last) / 86400000;
        if (app.status === 'applied' && days >= ghostedAfterDays) {
            app.status = 'ghosted';
            stats.ghosted++;
            stats.statusChanges++;
            note(key, 'status_change', `applied -> ghosted: no reply for ${Math.floor(days)} days`);
            log.info(`[GHOSTED] ${app.role || 'role'} at ${app.company} (no reply for ${Math.floor(days)} days)`);
            await charge('status_change_detected');
        }
    }
    if (budgetReached) log.warning('Stopped early: the run reached its maximum charge limit.');

    // ---------------------------------------------------------------------------
    // Save state and output the applications that changed this run.
    // ---------------------------------------------------------------------------
    if (readGmail && googleToken) await store.setValue('LAST_GMAIL_SYNC', Math.floor(now.getTime() / 1000));
    await store.setValue('APPLICATIONS', applications);
    await store.setValue('PROCESSED', [...processed].slice(-5000));

    const changedRecords = [];
    for (const [key, events] of changed) {
        const { thread_keys: _threads, interview_message: _message, ...app } = applications[key];
        const record = { record_type: 'application', ...app, events, updated_at: now.toISOString() };
        changedRecords.push(record);
        await Actor.pushData(record);
    }
    log.info(
        `Done: ${stats.statusChanges} status changes (${stats.interviews} interviews, ${stats.ghosted} ghosted), ${stats.briefs} prep briefs, ${stats.alreadyProcessed} messages already seen, ${stats.notJobRelated} not job-related`,
    );

    return { applications: changedRecords, allApplications: Object.values(applications), stats };
}
