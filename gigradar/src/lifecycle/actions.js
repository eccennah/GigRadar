/* eslint-disable no-param-reassign -- the tools update the application record in place */
// schedule_calendar and research_company tools: act on one application that has an interview.
import { Actor, log } from 'apify';

import { findMeetingLink } from './classify.js';
import { createCalendarEvent } from './google.js';
import { buildIcs } from './ics.js';
import { briefToMarkdown, generatePrepBrief, prepBriefByRules, researchCompany } from './prep.js';

/** Add the interview to Google Calendar (with reminders), or create an .ics file when Google is not connected. */
export async function scheduleInterviewFor(
    app,
    { googleToken, createCalendarEvents = true, timeZone = 'Africa/Lagos', charge },
) {
    if (app.status !== 'interview_scheduled')
        return { done: false, detail: `Application is ${app.status}, not at interview stage` };
    if (!app.interview_date) return { done: false, detail: 'No interview time known yet' };
    if (app.calendar_event_link || app.calendar_file_key) return { done: false, detail: 'Already scheduled' };
    const message = app.interview_message ?? {};
    const meetingLink = findMeetingLink(message.body);
    const summary = `Interview: ${app.role || 'role'} at ${app.company || 'company'}`;
    const description = [
        `Scheduled by GigRadar from: ${message.subject || message.from || 'message'}`,
        meetingLink ? `Link: ${meetingLink}` : null,
    ]
        .filter(Boolean)
        .join('\n');
    const zone = app.interview_timezone || timeZone;

    if (googleToken && createCalendarEvents) {
        try {
            const event = await createCalendarEvent(googleToken, {
                summary,
                description,
                location: meetingLink ?? app.interview_format ?? undefined,
                start: app.interview_date,
                timeZone: zone,
            });
            app.calendar_event_link = event.htmlLink;
            await charge('interview_scheduled');
            return {
                done: true,
                detail: `Google Calendar event for ${app.interview_date} (${zone}), reminders 1 day and 1 hour before`,
            };
        } catch (error) {
            log.warning(`Google Calendar failed, creating an .ics file instead: ${error.message}`);
        }
    }
    const key = `INTERVIEW-${app.id}.ics`;
    await Actor.setValue(
        key,
        buildIcs({
            uid: app.id,
            summary,
            description,
            location: meetingLink ?? app.interview_format,
            start: app.interview_date,
            timeZone: zone,
        }),
        { contentType: 'text/calendar' },
    );
    app.calendar_file_key = key;
    await charge('interview_scheduled');
    return { done: true, detail: `${key}: calendar file for ${app.interview_date} (${zone}) with reminders` };
}

/** Research the company and write an interview-prep brief. */
export async function writeBriefFor(app, { llm, askLlm, requirements = [], charge }) {
    if (app.status !== 'interview_scheduled')
        return { done: false, detail: `Application is ${app.status}, not at interview stage` };
    if (app.interview_prep_key) return { done: false, detail: 'Brief already written' };
    const message = app.interview_message ?? {};
    const research = await researchCompany(app.company_domain);
    const brief =
        (llm
            ? await askLlm(async () => generatePrepBrief(llm, { application: app, message, requirements, research }))
            : null) ??
        prepBriefByRules({ application: app, requirements, research, meetingLink: findMeetingLink(message.body) });
    const markdown = briefToMarkdown(app, brief);
    const key = `PREP-${app.id}`;
    await Actor.setValue(key, markdown, { contentType: 'text/markdown' });
    app.interview_prep_brief = markdown;
    app.interview_prep_key = key;
    await charge('interview_prep_generated');
    return {
        done: true,
        detail: `${key}${research ? ` (researched ${research.url})` : ' (no company website found)'}`,
    };
}
