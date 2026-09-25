/* eslint-disable no-param-reassign -- application records are updated in place by design */
// Application records: matching messages to applications, and the allowed status transitions.
import { createHash } from 'node:crypto';

export const normalizeCompany = (s) =>
    String(s ?? '')
        .toLowerCase()
        .replace(/[^a-z0-9 ]+/g, ' ')
        .replace(
            /\b(limited|ltd|plc|inc|llc|nigeria|nig|company|co|group|international|intl|the|careers|recruiting|talent|hr|team|jobs)\b/g,
            ' ',
        )
        .replace(/\s+/g, ' ')
        .trim();

/** Pasted input: a string, or { from, subject, date, body, direction, channel }. */
export function normalizePasted(m, index, now = new Date()) {
    const obj = typeof m === 'string' ? { body: m } : (m ?? {});
    const body = String(obj.body ?? obj.text ?? '').trim();
    if (!body) return null;
    const date =
        obj.date && !Number.isNaN(new Date(obj.date).getTime()) ? new Date(obj.date).toISOString() : now.toISOString();
    return {
        id: `pasted:${createHash('sha1')
            .update(`${obj.from ?? ''}|${obj.subject ?? ''}|${body}`)
            .digest('hex')
            .slice(0, 16)}`,
        channel: obj.channel === 'telegram' ? 'telegram' : 'email',
        thread_key: obj.thread ? `pasted:${obj.thread}` : null,
        from: String(obj.from ?? ''),
        to: String(obj.to ?? ''),
        subject: String(obj.subject ?? ''),
        date,
        body: body.slice(0, 8000),
        direction: obj.direction === 'outbound' ? 'outbound' : 'inbound',
        paste_index: index,
    };
}

/**
 * Find the application a message belongs to: same thread first, then same company (and role, if both known).
 * Creates a new application when nothing matches.
 */
export function findApplication(applications, { message, company, role, now = new Date(), create = true }) {
    if (message.thread_key) {
        for (const [key, app] of Object.entries(applications)) {
            if (app.thread_keys?.includes(message.thread_key)) return { key, app };
        }
    }
    const c = normalizeCompany(company);
    if (c) {
        const sameCompany = Object.entries(applications).filter(([, app]) => normalizeCompany(app.company) === c);
        const r = normalizeCompany(role);
        const exact = r ? sameCompany.find(([, app]) => normalizeCompany(app.role) === r) : null;
        const pick =
            exact ?? (sameCompany.length === 1 ? sameCompany[0] : sameCompany.find(([, app]) => !app.role || !r));
        if (pick) return { key: pick[0], app: pick[1] };
    }
    if (!create) return { key: null, app: null };
    const key =
        (c || `unknown-${createHash('sha1').update(message.id).digest('hex').slice(0, 8)}`) +
        (role ? `|${normalizeCompany(role)}` : '');
    applications[key] = {
        id: createHash('sha1').update(key).digest('hex').slice(0, 16),
        job_id: null,
        company: company || '',
        role: role || '',
        status: null,
        channel: message.channel,
        applied_on: message.date ?? now.toISOString(),
        last_contact_date: message.date ?? now.toISOString(),
        last_inbound_date: null,
        interview_date: null,
        interview_prep_brief: null,
        thread_keys: [],
    };
    return { key, app: applications[key] };
}

// Progress only moves forward: an "application received" email arriving after an interview invite does not undo it.
const RANK = { applied: 1, ghosted: 1, interview_scheduled: 2, rejected: 3 };

/** Apply a classified status to an application. Returns { changed }. */
export function applyTransition(app, status) {
    if (status === 'no_change') {
        if (app.status === null) app.status = 'applied';
        return { changed: false };
    }
    if (app.status === status) return { changed: false };
    if (app.status && RANK[status] < RANK[app.status] && app.status !== 'ghosted') return { changed: false };
    app.status = status;
    return { changed: true };
}
