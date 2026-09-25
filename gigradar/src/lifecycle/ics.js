// A standard .ics calendar file: the fallback when Google Calendar is not connected.
// Opening it on a phone or computer adds the interview, with reminders, to any calendar app.

const escapeText = (s) =>
    String(s ?? '')
        .replace(/\\/g, '\\\\')
        .replace(/\n/g, '\\n')
        .replace(/([,;])/g, '\\$1');

/** "2026-09-29T10:00:00" -> "20260929T100000" */
const icsLocal = (localDateTime) => localDateTime.replace(/[-:]/g, '').slice(0, 15);

export function buildIcs({
    uid,
    summary,
    description,
    location,
    start,
    durationMinutes = 45,
    timeZone = 'Africa/Lagos',
    now = new Date(),
}) {
    const [date, time] = start.split('T');
    const [h, m] = time.split(':').map(Number);
    const total = h * 60 + m + durationMinutes;
    const end = `${date}T${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}:00`;
    const stamp = now
        .toISOString()
        .replace(/[-:]/g, '')
        .replace(/\.\d{3}/, '');
    return [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//GigRadar//Lifecycle Agent//EN',
        'CALSCALE:GREGORIAN',
        'METHOD:PUBLISH',
        'BEGIN:VEVENT',
        `UID:${uid}@gigradar`,
        `DTSTAMP:${stamp}`,
        `DTSTART;TZID=${timeZone}:${icsLocal(start)}`,
        `DTEND;TZID=${timeZone}:${icsLocal(end)}`,
        `SUMMARY:${escapeText(summary)}`,
        `DESCRIPTION:${escapeText(description)}`,
        location ? `LOCATION:${escapeText(location)}` : null,
        'BEGIN:VALARM',
        'ACTION:DISPLAY',
        `DESCRIPTION:${escapeText(summary)}`,
        'TRIGGER:-PT1H',
        'END:VALARM',
        'BEGIN:VALARM',
        'ACTION:DISPLAY',
        `DESCRIPTION:${escapeText(summary)} tomorrow`,
        'TRIGGER:-P1D',
        'END:VALARM',
        'END:VEVENT',
        'END:VCALENDAR',
    ]
        .filter(Boolean)
        .join('\r\n');
}
