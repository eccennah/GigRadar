// Step 2 of the Discovery Agent: fetch raw listings.
// Both job boards publish a schema.org JobPosting on their detail pages, so we read that first and fall back to page text.
import { load } from 'cheerio';

/** Turn an HTML fragment (possibly entity-escaped, as MyJobMag's is) into plain text with line breaks kept. */
export function htmlToText(html = '') {
    let text = String(html);
    // Some sites escape the HTML inside JSON-LD, so decode entities until no tags are escaped.
    for (let i = 0; i < 2 && /&lt;/.test(text); i++) text = load(`<div>${text}</div>`)('div').text();
    text = text.replace(/<\s*(br|\/p|\/li|\/h\d|\/div)\s*\/?>/gi, '\n').replace(/<li[^>]*>/gi, '- ');
    const $ = load(`<div>${text}</div>`);
    return $('div')
        .text()
        .replace(/[^\S\n]+/g, ' ') // collapses spaces, tabs and non-breaking spaces, keeps newlines
        .replace(/\n\s*\n+/g, '\n')
        .trim();
}

/**
 * Find the first JobPosting object in the page's JSON-LD, including inside @graph arrays.
 * References like `hiringOrganization: { "@id": ... }` are resolved against the other nodes on the page.
 */
export function findJobPosting($) {
    const nodes = [];
    for (const el of $('script[type="application/ld+json"]').toArray()) {
        // Some sites (MyJobMag) put raw line breaks inside JSON strings, which JSON.parse rejects.
        const raw = $(el)
            .html()
            .replace(/\p{Cc}+/gu, ' ');
        try {
            const data = JSON.parse(raw);
            nodes.push(...[].concat(data), ...(data?.['@graph'] ?? []));
        } catch {
            // Not valid JSON even after cleanup: skip this block.
        }
    }
    const posting = nodes.find((n) => n && [].concat(n['@type']).includes('JobPosting'));
    if (!posting) return null;
    const resolve = (ref) => (ref?.['@id'] && !ref.name ? (nodes.find((n) => n?.['@id'] === ref['@id']) ?? ref) : ref);
    return { ...posting, hiringOrganization: resolve(posting.hiringOrganization) };
}

function postingLocation(posting) {
    const places = [].concat(posting?.jobLocation ?? []);
    const parts = places.flatMap((p) => {
        const a = p?.address ?? {};
        return [a.addressLocality, a.addressRegion, a.addressCountry].filter(Boolean);
    });
    let unique = [...new Set(parts.map((p) => String(p).trim()))];
    // Drop a bare country code like "NG" when a place name is already there.
    if (unique.length > 1) unique = unique.filter((p) => !/^[A-Z]{2}$/.test(p));
    if (posting?.jobLocationType === 'TELECOMMUTE') unique.unshift('Remote');
    return unique.join(', ');
}

function postingSalary(posting) {
    const s = posting?.baseSalary;
    if (!s) return null;
    const v = s.value ?? {};
    const currency = s.currency ?? v.currency ?? '';
    const range = v.minValue && v.maxValue ? `${v.minValue} - ${v.maxValue}` : (v.value ?? v.minValue ?? '');
    if (!range) return null;
    return `${currency} ${range}${v.unitText ? ` per ${String(v.unitText).toLowerCase()}` : ''}`.trim();
}

/** Build a raw listing from a detail page. `card` holds what the listing page already told us. */
export function parseDetailPage($, { url, source, card = {} }) {
    const posting = findJobPosting($);
    const description =
        htmlToText(posting?.description ?? '') || $('main').text().replace(/\s+/g, ' ').trim().slice(0, 6000);
    return {
        source,
        url,
        role: String(posting?.title ?? card.role ?? $('h1').first().text()).trim(),
        company: String(posting?.hiringOrganization?.name || card.company || '').trim(),
        location: postingLocation(posting) || card.location || '',
        salary_range: postingSalary(posting) ?? card.salary_range ?? null,
        employment_type: [].concat(posting?.employmentType ?? card.employment_type ?? []).join(', '),
        experience_months: Number(posting?.experienceRequirements?.monthsOfExperience) || null,
        posted_at: posting?.datePosted ?? null,
        valid_through: posting?.validThrough ?? null,
        description,
        structured: Boolean(posting),
    };
}

/** Jobberman listing page: one card per job, with the detail link in [data-cy="listing-title-link"]. */
export function parseJobbermanCards($) {
    const TITLE = '[data-cy="listing-title-link"]';
    return $(TITLE)
        .toArray()
        .map((a) => {
            const link = $(a);
            // The card is the largest ancestor that still contains only this one job.
            let card = link;
            while (card.parent().length && card.parent().find(TITLE).length === 1) card = card.parent();
            const tags = card
                .find('span.rounded')
                .toArray()
                .map((s) => $(s).text().replace(/\s+/g, ' ').trim())
                .filter(Boolean);
            return {
                url: link.attr('href'),
                role: link.attr('title') || link.text().trim(),
                company: card.find('p.text-blue-700').first().text().trim(),
                location: tags[0] ?? '',
                employment_type: tags[1] ?? '',
                salary_range: tags.find((t) => /\b(NGN|USD|₦|\$)/.test(t)) ?? null,
            };
        })
        .filter((c) => c.url?.includes('/listings/'));
}

/** MyJobMag listing page: `li.job-info` blocks with "<role> at <company>" as the link text. */
export function parseMyJobMagCards($, baseUrl) {
    return $('li.job-info h2 a')
        .toArray()
        .map((a) => {
            const link = $(a);
            const text = link.text().trim();
            const at = text.lastIndexOf(' at ');
            return {
                url: new URL(link.attr('href'), baseUrl).href,
                role: at > 0 ? text.slice(0, at) : text,
                company: at > 0 ? text.slice(at + 4) : '',
            };
        })
        .filter((c) => c.url.includes('/job/'));
}

/** Pasted text from WhatsApp, flyers, etc. enters the same pipeline, unstructured. */
export function pastedToRaw(texts = []) {
    return texts
        .map((t) => String(t ?? '').trim())
        .filter(Boolean)
        .map((text, i) => ({
            source: 'pasted',
            url: null,
            role: '',
            company: '',
            location: '',
            salary_range: null,
            employment_type: '',
            experience_months: null,
            posted_at: null,
            valid_through: null,
            description: text.slice(0, 6000),
            structured: false,
            paste_index: i,
        }));
}
