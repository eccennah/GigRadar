// Step 1 of the Discovery Agent: decide which sources and listing pages to query for this user.
// The plan changes per run based on the profile, and every choice carries a reason so the run is explainable.

const JOBBERMAN = 'https://www.jobberman.com/jobs';
const MYJOBMAG = 'https://www.myjobmag.com';

// Role families: keyword pattern -> category slugs on each site.
const ROLE_FAMILIES = [
    {
        name: 'tech',
        pattern:
            /\b(software|developer|dev|programmer|frontend|front-end|backend|back-end|full[ -]?stack|devops|cloud|data|machine learning|ml|ai|cyber|security analyst|qa|tester|mobile|android|ios|react|node|python|java|golang|web|it support|sysadmin|network engineer|ui|ux|product designer)\b/i,
        jobberman: ['software-data', 'it-telecoms'],
        myjobmag: ['information-technology'],
    },
    {
        name: 'product',
        pattern: /\b(product manager|project manager|scrum|program manager|product owner)\b/i,
        jobberman: ['product-project-management'],
        myjobmag: [],
    },
    {
        name: 'sales-marketing',
        pattern:
            /\b(sales|marketing|marketer|business development|growth|brand|social media|seo|content|copywriter)\b/i,
        jobberman: ['sales', 'marketing-communications'],
        myjobmag: ['sales-marketing'],
    },
    {
        name: 'finance',
        pattern: /\b(account(ant|ing)?|audit(or)?|finance|financial|bank(ing)?|tax|insurance|treasury)\b/i,
        jobberman: ['accounting-auditing-finance', 'banking-finance-insurance'],
        myjobmag: ['accounting-audit'],
    },
    {
        name: 'admin-hr',
        pattern: /\b(admin(istrat\w*)?|office|secretary|receptionist|hr|human resources?|recruit(er|ment)|talent)\b/i,
        jobberman: ['admin-office', 'human-resources'],
        myjobmag: ['administration'],
    },
    {
        name: 'customer-service',
        pattern: /\b(customer (service|support|care|success)|call cent(er|re)|help ?desk)\b/i,
        jobberman: ['customer-service-support'],
        myjobmag: ['customer-care'],
    },
    {
        name: 'engineering',
        pattern: /\b(mechanical|electrical|civil|chemical|petroleum|structural|maintenance|technician|solar)\b/i,
        jobberman: ['engineering-technology'],
        myjobmag: ['engineering'],
    },
    {
        name: 'health',
        pattern: /\b(nurse|nursing|doctor|medical|pharmac\w*|health|clinical|lab(oratory)? scientist)\b/i,
        jobberman: ['healthcare', 'medical-pharmaceutical'],
        myjobmag: [],
    },
    {
        name: 'education',
        pattern: /\b(teacher|tutor|lecturer|education|instructor|trainer)\b/i,
        jobberman: ['education'],
        myjobmag: [],
    },
    {
        name: 'logistics',
        pattern: /\b(driver|logistics|dispatch|rider|warehouse|supply chain|procurement)\b/i,
        jobberman: ['driver-transport-services', 'shipping-logistics'],
        myjobmag: [],
    },
    {
        name: 'entry-level',
        pattern: /\b(graduate|intern(ship)?|entry[ -]level|nysc|trainee)\b/i,
        jobberman: ['internship-graduate'],
        myjobmag: ['graduate-jobs'],
    },
];

// City -> slugs on each site (only cities both sites expose as location pages).
const LOCATIONS = [
    { pattern: /\blagos\b/i, jobberman: 'lagos', myjobmag: 'lagos' },
    { pattern: /\babuja\b|\bfct\b/i, jobberman: 'abuja', myjobmag: 'abuja' },
    { pattern: /port[ -]?harcourt|\brivers\b/i, jobberman: 'port-harcourt-rivers', myjobmag: 'rivers' },
    { pattern: /\benugu\b/i, jobberman: 'enugu', myjobmag: 'enugu' },
    { pattern: /\bibadan\b|\boyo\b/i, jobberman: 'ibadan-oyo', myjobmag: null },
    { pattern: /abeokuta|\bogun\b/i, jobberman: 'abeokuta-ogun', myjobmag: 'ogun' },
];

export const AVAILABLE_SOURCES = ['jobberman', 'myjobmag', 'pasted'];

/**
 * Build the list of listing pages to crawl for this profile.
 * @returns {{ families: string[], steps: { source: string, url: string, reason: string }[], sources: string[] }}
 */
export function planSources({
    targetRole = '',
    location = '',
    remotePreference = 'any',
    sources,
    maxPagesPerSource = 2,
    hasPastedJobs = false,
}) {
    const families = ROLE_FAMILIES.filter((f) => f.pattern.test(targetRole));
    const city = LOCATIONS.find((l) => l.pattern.test(location));
    const wanted = sources?.length ? sources : AVAILABLE_SOURCES;
    const steps = [];

    const add = (source, url, reason) => {
        const count = steps.filter((s) => s.source === source).length;
        if (count < maxPagesPerSource && !steps.some((s) => s.url === url)) steps.push({ source, url, reason });
    };

    const familyNames = families.map((f) => f.name).join(', ');

    if (wanted.includes('jobberman')) {
        // Remote-first users: the remote board is the best match, so it goes first.
        if (remotePreference === 'remote') add('jobberman', `${JOBBERMAN}/remote`, 'User prefers remote work');
        for (const family of families) {
            for (const slug of family.jobberman)
                add('jobberman', `${JOBBERMAN}/${slug}`, `Role "${targetRole}" matches ${family.name} jobs`);
        }
        if (city && remotePreference !== 'remote')
            add('jobberman', `${JOBBERMAN}/${city.jobberman}`, `User is in ${location}`);
        if (families.some((f) => f.name === 'tech') && remotePreference === 'any') {
            add('jobberman', `${JOBBERMAN}/remote`, 'Tech roles are often remote');
        }
        if (!families.length) add('jobberman', JOBBERMAN, 'No specific role family matched, using all jobs');
    }

    if (wanted.includes('myjobmag')) {
        for (const family of families) {
            for (const slug of family.myjobmag)
                add(
                    'myjobmag',
                    `${MYJOBMAG}/jobs-by-field/${slug}`,
                    `Role "${targetRole}" matches ${family.name} jobs`,
                );
        }
        if (city?.myjobmag && remotePreference !== 'remote')
            add('myjobmag', `${MYJOBMAG}/jobs-location/${city.myjobmag}`, `User is in ${location}`);
        if (!steps.some((s) => s.source === 'myjobmag'))
            add('myjobmag', `${MYJOBMAG}/jobs`, 'No matching MyJobMag field, using latest jobs');
    }

    const chosen = [...new Set(steps.map((s) => s.source))];
    if (wanted.includes('pasted') && hasPastedJobs) chosen.push('pasted');

    return { families: familyNames ? familyNames.split(', ') : [], steps, sources: chosen };
}
