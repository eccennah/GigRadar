import { describe, expect, it } from 'vitest';

import {
    classifyByRules,
    companyDomain,
    findMeetingLink,
    guessCompany,
    guessRole,
    parseInterviewTime,
} from '../src/lifecycle/classify.js';
import { buildIcs } from '../src/lifecycle/ics.js';
import { prepBriefByRules } from '../src/lifecycle/prep.js';
import { applyTransition, findApplication, normalizePasted } from '../src/lifecycle/state.js';

const msg = (body, extra = {}) => ({
    subject: '',
    from: 'Talent Team <talent@korapay.com>',
    direction: 'inbound',
    body,
    ...extra,
});

describe('classification by rules', () => {
    it('recognises the clear cases', () => {
        expect(classifyByRules(msg('Thank you for applying to the Frontend Developer role at Korapay.'))).toMatchObject(
            {
                status: 'applied',
                confident: true,
            },
        );
        expect(
            classifyByRules(
                msg('We would like to invite you to an interview on Monday, 29 September 2026 at 10:00 AM.'),
            ),
        ).toMatchObject({ status: 'interview_scheduled', confident: true });
        expect(
            classifyByRules(msg('Unfortunately, we have decided to move forward with other candidates.')),
        ).toMatchObject({ status: 'rejected', confident: true });
    });

    it('is unsure on mixed or missing signals, so the LLM is asked', () => {
        expect(
            classifyByRules(
                msg('Unfortunately Tuesday no longer works. We would like to invite you to an interview on Thursday.'),
            ),
        ).toMatchObject({ confident: false });
        expect(classifyByRules(msg('Here is our monthly newsletter.'))).toMatchObject({
            status: 'no_change',
            confident: false,
        });
    });

    it('does not mistake a reschedule for a rejection', () => {
        const reschedule = classifyByRules(
            msg(
                'Hi Ada, unfortunately Tuesday no longer works for our team. Could we do the interview on Thursday, 2 October at 2pm instead?',
            ),
        );
        expect(reschedule.confident).toBe(false);
        expect(classifyByRules(msg('Unfortunately our office is closed on Friday.')).confident).toBe(false);
        // A rejection that also thanks you for your interest is still a clear rejection.
        expect(
            classifyByRules(
                msg(
                    'Thank you for your interest. Unfortunately, we have decided to move forward with other candidates.',
                ),
            ),
        ).toMatchObject({ status: 'rejected', confident: true });
    });

    it('treats messages the user sent as applications', () => {
        expect(classifyByRules(msg('Please find my CV attached for the role.', { direction: 'outbound' })).status).toBe(
            'applied',
        );
    });
});

describe('interview time', () => {
    const now = new Date('2026-09-25T09:00:00Z');
    it('parses common formats', () => {
        expect(parseInterviewTime('on Monday, 29 September 2026 at 10:00 AM', now)).toBe('2026-09-29T10:00:00');
        expect(parseInterviewTime('How about September 30th at 2pm WAT?', now)).toBe('2026-09-30T14:00:00');
        expect(parseInterviewTime('Date: 02/10/2026 11:30', now)).toBe('2026-10-02T11:30:00');
        expect(parseInterviewTime('on 1st October at 3', now)).toBe('2026-10-01T15:00:00');
        expect(parseInterviewTime('Please share your availability for next week.', now)).toBeNull();
        // Gmail wraps lines: the hour must not be taken from the year.
        expect(
            parseInterviewTime(
                `interview on Monday, 29 September 2026 at
10:00 AM (WAT)`,
                now,
            ),
        ).toBe('2026-09-29T10:00:00');
    });

    it('finds meeting links', () => {
        expect(findMeetingLink('Join here: https://meet.google.com/abc-defg-hij thanks')).toBe(
            'https://meet.google.com/abc-defg-hij',
        );
    });
});

describe('company', () => {
    it('comes from the text, or the sender domain when it is a company domain', () => {
        expect(guessCompany(msg('Thanks for applying to the role at Kora Labs.'))).toBe('Kora Labs');
        expect(guessCompany(msg('Thanks for applying.'))).toBe('Korapay');
        expect(guessCompany(msg('Thank you for applying to the role at Korapay. Our team is reviewing.'))).toBe(
            'Korapay',
        );
    });

    it('finds the role in common phrasings', () => {
        expect(guessRole(msg('Thank you for applying to the Frontend Developer role at Korapay.'))).toBe(
            'Frontend Developer',
        );
        expect(guessRole(msg('', { subject: 'Your application for Frontend Developer' }))).toBe('Frontend Developer');
        expect(guessRole(msg('', { subject: 'Interview invitation - Backend Engineer' }))).toBe('Backend Engineer');
        expect(guessRole(msg('Thank you for your interest in the Software Engineer role at Paystack.'))).toBe(
            'Software Engineer',
        );
        expect(guessRole(msg('Here is our newsletter.'))).toBe('');
        expect(
            guessCompany(
                msg('We would like to invite you to an interview.', { from: 'Jane Doe <jane.doe@gmail.com>' }),
            ),
        ).toBe('');
        expect(companyDomain(msg(''))).toBe('korapay.com');
        expect(companyDomain(msg('', { from: 'Recruiter <jane@gmail.com>' }))).toBeNull();
        expect(companyDomain(msg('', { from: 'no-reply@greenhouse.io' }))).toBeNull();
    });
});

describe('application state', () => {
    it('groups messages by company and only moves forward', () => {
        const apps = {};
        const now = new Date('2026-09-25T09:00:00Z');
        const m1 = normalizePasted({ from: 'talent@korapay.com', body: 'Thank you for applying' }, 0, now);
        const { app } = findApplication(apps, { message: m1, company: 'Korapay', role: 'Frontend Developer', now });
        expect(applyTransition(app, 'applied')).toEqual({ changed: true });
        expect(applyTransition(app, 'interview_scheduled')).toEqual({ changed: true });
        // A late "application received" email does not undo the interview.
        expect(applyTransition(app, 'applied')).toEqual({ changed: false });
        expect(app.status).toBe('interview_scheduled');

        const m2 = normalizePasted({ from: 'talent@korapay.com', body: 'Unfortunately...' }, 1, now);
        expect(findApplication(apps, { message: m2, company: 'Korapay Ltd', role: '', now }).app).toBe(app);
        expect(applyTransition(app, 'rejected')).toEqual({ changed: true });
        expect(
            findApplication(apps, { message: m2, company: 'Other Co', role: '', now, create: false }).app,
        ).toBeNull();
    });

    it('revives a ghosted application when they reply', () => {
        const app = { status: 'ghosted' };
        expect(applyTransition(app, 'interview_scheduled')).toEqual({ changed: true });
        expect(app.status).toBe('interview_scheduled');
    });
});

describe('outputs', () => {
    it('builds a calendar file with reminders', () => {
        const ics = buildIcs({
            uid: 'abc',
            summary: 'Interview: Dev at Korapay',
            description: 'Link: x',
            start: '2026-09-29T10:00:00',
            now: new Date('2026-09-25T09:00:00Z'),
        });
        expect(ics).toContain('DTSTART;TZID=Africa/Lagos:20260929T100000');
        expect(ics).toContain('DTEND;TZID=Africa/Lagos:20260929T104500');
        expect(ics).toContain('TRIGGER:-PT1H');
        expect(ics).toContain('TRIGGER:-P1D');
    });

    it('writes a prep brief without an LLM', () => {
        const brief = prepBriefByRules({
            application: { company: 'Korapay', role: 'Frontend Developer', interview_date: '2026-09-29T10:00:00' },
            requirements: ['React', 'TypeScript'],
            research: { title: 'Korapay', description: 'Payments infrastructure for Africa' },
            meetingLink: 'https://meet.google.com/abc',
        });
        expect(brief.companySummary).toBe('Payments infrastructure for Africa');
        expect(brief.focusAreas).toEqual(['React', 'TypeScript']);
        expect(brief.logistics).toContain('https://meet.google.com/abc');
    });
});
