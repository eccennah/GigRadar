// Tailoring Agent core: compare resume and job requirements, decide per requirement whether it is
// matched, can honestly be reframed from existing experience, or is a genuine gap to flag.
// Everything here runs without an LLM; the LLM (when available) only improves wording and judgement.

const STOPWORDS = new Set(
    `a an and or the of to in on for with at by from as is are be been being this that these those you your our we will
    must should can able ability strong good excellent solid proven working knowledge understanding experience experienced
    years year plus minimum least skills skill required requirement requirements preferred nice have has having etc
    candidate candidates role job work team teams using use used within across other related relevant including
    such well also demonstrated hands familiarity familiar proficiency proficient similar degree field any
    build building built develop developing developed design designing designed maintain maintaining deliver delivering
    ensure ensuring create creating implement implementing support supporting manage managing help helping
    applications application systems system solutions solution scalable high quality clean fast paced environment
    new best practices ideally preferably e.g i.e more than over into their them it its who what how`.split(/\s+/),
);

const normalize = (s) =>
    String(s ?? '')
        .toLowerCase()
        .replace(/[^a-z0-9+#./ ]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

/** Meaningful words of a requirement or resume line (keeps tech tokens like c#, node.js, ci/cd). */
export function keywords(text) {
    return [
        ...new Set(
            normalize(text)
                .split(' ')
                .map((w) => w.replace(/^[./]+|[./]+$/g, ''))
                .filter((w) => w.length > 1 && !STOPWORDS.has(w) && !/^\d+$/.test(w)),
        ),
    ];
}

/** Split a pasted resume into non-empty lines, remembering which section each line is in. */
export function parseResume(text) {
    const lines = [];
    let section = 'summary';
    for (const raw of String(text ?? '').split('\n')) {
        const line = raw.trim();
        if (!line) continue;
        const bare = line.replace(/[:#*_]+/g, '').trim();
        if (
            /^(experience|work experience|employment|education|skills|technical skills|projects|certifications?|summary|profile|about)$/i.test(
                bare,
            )
        ) {
            section = bare.toLowerCase();
            continue;
        }
        lines.push({ text: line.replace(/^[-•*▪]\s*/, ''), section });
    }
    return lines;
}

const YEARS = /(\d+)\s*\+?\s*(?:years?|yrs?)/i;

/**
 * Rule-based diff. For each requirement:
 * - matched: most of its keywords appear in one resume line (evidence) or across the resume
 * - reframe: some keywords appear, so existing experience may be reworded to show it
 * - gap: almost nothing in the resume supports it, so the user is asked instead of inventing it
 */
export function diffByRules(requirements, resumeLines) {
    const resumeWords = new Set(resumeLines.flatMap((l) => keywords(l.text)));
    return requirements.map((requirement) => {
        const words = keywords(requirement);
        if (!words.length)
            return { requirement, status: 'matched', evidence: null, reason: 'Nothing specific to check' };

        let best = { line: null, score: 0 };
        for (const line of resumeLines) {
            const lineWords = new Set(keywords(line.text));
            const score = words.filter((w) => lineWords.has(w)).length / words.length;
            if (score > best.score) best = { line, score };
        }
        const coverage = words.filter((w) => resumeWords.has(w)).length / words.length;
        const missing = words.filter((w) => !resumeWords.has(w));

        const wantYears = requirement.match(YEARS);
        const note = wantYears
            ? `The role asks for ${wantYears[1]}+ years; check your resume states this clearly.`
            : null;

        if (best.score >= 0.6 || coverage >= 0.75) {
            return {
                requirement,
                status: 'matched',
                evidence: best.line?.text ?? null,
                reason: note ?? 'Your resume already shows this',
            };
        }
        if (coverage >= 0.3) {
            return {
                requirement,
                status: 'reframe',
                evidence: best.line?.text ?? null,
                reason: `Related experience found, but it does not mention: ${missing.join(', ')}`,
            };
        }
        return {
            requirement,
            status: 'gap',
            evidence: null,
            reason: `Nothing in your resume shows: ${missing.join(', ') || requirement}`,
        };
    });
}

export function matchScore(diff) {
    if (!diff.length) return 0;
    const points = { matched: 1, reframe: 0.5, gap: 0 };
    return Math.round((100 * diff.reduce((sum, d) => sum + points[d.status], 0)) / diff.length);
}

// ---------------------------------------------------------------------------
// Anti-fabrication: a rewrite may use the job's wording (that is what reframing is), but it may not add facts.
// Blocked: any number or tool/name-like token the resume never mentions, and any skill from a requirement
// judged to be a genuine gap.
// ---------------------------------------------------------------------------
const NUMBER = /\d+(?:[.,]\d+)?/g;
// Acronyms and product-style names: AWS, TypeScript, PostgreSQL, Node.js, C#.
const NAME_LIKE =
    /(?<![\w])(?:[A-Z][a-zA-Z0-9]*[A-Z0-9][a-zA-Z0-9]*|[A-Z][a-z]+(?:\.[a-z]+)+|[A-Za-z]+#|[A-Z]{2,})(?![\w])/g;

/** Skills the resume does not have: the missing words of every requirement judged to be a gap. */
export function gapTerms(diff, resumeText) {
    const resumeWords = new Set(keywords(resumeText));
    return [...new Set(diff.filter((d) => d.status === 'gap').flatMap((d) => keywords(d.requirement)))].filter(
        (w) => !resumeWords.has(w),
    );
}

export function inventedFacts(rewritten, resumeText, forbiddenTerms = []) {
    const resume = resumeText.toLowerCase();
    const forbidden = new Set(forbiddenTerms);
    const invented = [];
    for (const n of rewritten.match(NUMBER) ?? []) {
        if (!resume.includes(n)) invented.push(n);
    }
    for (const t of rewritten.match(NAME_LIKE) ?? []) {
        if (!resume.includes(t.toLowerCase())) invented.push(t);
    }
    // Claiming a skill the resume genuinely lacks is exactly the fabrication we must not produce.
    for (const w of keywords(rewritten)) {
        if (forbidden.has(w)) invented.push(w);
    }
    return [...new Set(invented.map((x) => x.trim()).filter(Boolean))];
}

/** Pull requirement lines out of a pasted job description (same idea as the Discovery Agent). */
export function extractRequirements(description) {
    const lines = String(description ?? '')
        .split('\n')
        .map((l) =>
            l
                .trim()
                .replace(/^(?:[-•*▪➢✓]|\d+[.)])\s*/, '')
                .trim(),
        )
        .filter(Boolean);
    const HEADING =
        /^(requirements?|qualifications?|skills?|what you('ll)? need|who you are|what we('re| are) looking for|minimum requirements|key requirements)\b.{0,30}:?$/i;
    const OTHER =
        /^(benefits|what we offer|perks|compensation|salary|responsibilities|key responsibilities|duties|about|how to apply|method of application)\b/i;
    const out = [];
    let inSection = false;
    for (const line of lines) {
        if (HEADING.test(line)) {
            inSection = true;
            continue;
        }
        if (inSection && OTHER.test(line) && line.split(' ').length <= 6) inSection = false;
        if (inSection && line.length > 3) out.push(line);
    }
    if (!out.length) {
        for (const line of lines) {
            if (
                /\b(\d+\+?\s*years?|degree|b\.?sc|hnd|certif\w*|proficien\w*|knowledge of|experience (in|with)|familiar)\b/i.test(
                    line,
                )
            )
                out.push(line);
        }
    }
    return out.map((l) => l.slice(0, 200)).slice(0, 15);
}
