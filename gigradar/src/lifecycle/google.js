// Gmail (read) and Google Calendar (write) over plain REST, authorised with a refresh token.
// Environment variables (store them as secrets on the Actor):
//   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN
// The refresh token comes from the one-time script in scripts/google-auth.mjs.
import { load } from 'cheerio';

export function googleConfigFromEnv(env = process.env) {
    const { GOOGLE_CLIENT_ID: clientId, GOOGLE_CLIENT_SECRET: clientSecret, GOOGLE_REFRESH_TOKEN: refreshToken } = env;
    return clientId && clientSecret && refreshToken ? { clientId, clientSecret, refreshToken } : null;
}

export async function getAccessToken({ clientId, clientSecret, refreshToken }) {
    const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            refresh_token: refreshToken,
            grant_type: 'refresh_token',
        }),
        signal: AbortSignal.timeout(20_000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        // invalid_grant usually means the refresh token expired (7 days for apps in Testing mode).
        const hint =
            data.error === 'invalid_grant'
                ? ' The refresh token has expired or was revoked: run scripts/google-auth.mjs again.'
                : '';
        throw new Error(`Google sign-in failed (${res.status} ${data.error ?? ''}).${hint}`);
    }
    return data.access_token;
}

async function googleApi(token, url, init = {}) {
    const res = await fetch(url, {
        ...init,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
        signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok)
        throw new Error(`Google API ${res.status} on ${new URL(url).pathname}: ${(await res.text()).slice(0, 200)}`);
    return res.json();
}

const decodeBase64Url = (s) =>
    Buffer.from(
        String(s ?? '')
            .replace(/-/g, '+')
            .replace(/_/g, '/'),
        'base64',
    ).toString('utf8');

/** Prefer the text/plain part; fall back to text/html converted to text. */
function extractBody(payload) {
    const parts = [];
    const walk = (p) => {
        if (!p) return;
        if (p.body?.data) parts.push({ mime: p.mimeType, text: decodeBase64Url(p.body.data) });
        (p.parts ?? []).forEach(walk);
    };
    walk(payload);
    const plain = parts.find((p) => p.mime === 'text/plain');
    if (plain) return plain.text;
    const html = parts.find((p) => p.mime === 'text/html');
    return html ? load(html.text.replace(/<(br|\/p|\/div|\/li)[^>]*>/gi, '\n'))('body').text() : '';
}

const DEFAULT_QUERY =
    // Application wording only; newsletters almost always carry an unsubscribe link, so they are left out.
    '("thank you for applying" OR "thanks for applying" OR "your application" OR "application received" OR interview OR "next steps" OR unfortunately OR "move forward" OR recruiter OR "hiring team") -unsubscribe -category:promotions -category:social -category:forums';

/**
 * Read job-related emails (received and sent) since `sinceEpochSeconds`.
 * Returns normalized messages: { id, channel, thread_key, from, to, subject, date, body, direction }.
 */
export async function fetchGmailMessages(token, { sinceEpochSeconds, query = DEFAULT_QUERY, maxMessages = 50 }) {
    const profile = await googleApi(token, 'https://gmail.googleapis.com/gmail/v1/users/me/profile');
    const me = profile.emailAddress.toLowerCase();
    const q = `${query} after:${sinceEpochSeconds} in:anywhere -in:spam -in:trash`;
    const list = await googleApi(
        token,
        `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${maxMessages}&q=${encodeURIComponent(q)}`,
    );

    const messages = [];
    for (const { id } of list.messages ?? []) {
        const m = await googleApi(token, `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`);
        const header = (name) => m.payload?.headers?.find((h) => h.name.toLowerCase() === name)?.value ?? '';
        const from = header('from');
        messages.push({
            id: `gmail:${m.id}`,
            channel: 'email',
            thread_key: `gmail:${m.threadId}`,
            from,
            to: header('to'),
            subject: header('subject'),
            date: new Date(Number(m.internalDate)).toISOString(),
            body: extractBody(m.payload).slice(0, 8000),
            direction: from.toLowerCase().includes(me) ? 'outbound' : 'inbound',
        });
    }
    return { me, messages };
}

/** Create a calendar event with reminders. `start` is local "YYYY-MM-DDTHH:mm:00" in `timeZone`. */
export async function createCalendarEvent(
    token,
    { calendarId = 'primary', summary, description, location, start, durationMinutes = 45, timeZone },
) {
    const [date, time] = start.split('T');
    const [h, min] = time.split(':').map(Number);
    const endTotal = h * 60 + min + durationMinutes;
    const end = `${date}T${String(Math.floor(endTotal / 60) % 24).padStart(2, '0')}:${String(endTotal % 60).padStart(2, '0')}:00`;
    return googleApi(
        token,
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
        {
            method: 'POST',
            body: JSON.stringify({
                summary,
                description,
                location,
                start: { dateTime: start, timeZone },
                end: { dateTime: end, timeZone },
                reminders: {
                    useDefault: false,
                    overrides: [
                        { method: 'popup', minutes: 60 },
                        { method: 'email', minutes: 24 * 60 },
                    ],
                },
            }),
        },
    );
}
