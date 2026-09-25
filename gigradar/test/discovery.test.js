import { load } from 'cheerio';
import { describe, expect, it } from 'vitest';

import {
    combine,
    decide,
    detectRemoteType,
    extractRequirements,
    fingerprint,
    guessFields,
    isLikelyJobPost,
    needsLlm,
    roleMatch,
    scoreByRules,
    SeenJobs,
} from '../src/discovery/pipeline.js';
import { planSources } from '../src/discovery/planner.js';
import { findJobPosting, htmlToText, parseJobbermanCards, pastedToRaw } from '../src/discovery/sources.js';

const job = (overrides = {}) => ({
    source: 'jobberman',
    url: 'https://example.com/job',
    role: 'Frontend Developer',
    company: 'Acme Technologies Ltd',
    location: 'Lagos, Nigeria',
    salary_range: 'NGN 400,000 - 600,000',
    employment_type: 'Full Time',
    description:
        'We are hiring a frontend developer.\nRequirements\n- 3 years of React experience\n- Good communication\nBenefits\n- HMO',
    structured: true,
    remote_type: 'onsite',
    ...overrides,
});

describe('scam scoring', () => {
    it('flags upfront fees, WhatsApp pressure and free email', () => {
        const scam = job({
            company: '',
            structured: false,
            description:
                'URGENT hiring!!! Data entry clerks needed, no experience required, earn N50,000 weekly. Pay registration fee of N5,000 to start. Message us on WhatsApp now or email jobs.hiring@gmail.com',
        });
        const r = scoreByRules(scam);
        expect(r.scam).toBeGreaterThanOrEqual(60);
        expect(r.scamReasons.join(' ')).toMatch(/pay/i);
        expect(decide(r, { scamRiskThreshold: 60, hireabilityThreshold: 40 })).toBe('scam_flagged');
    });

    it('does not flag a normal structured listing', () => {
        const r = scoreByRules(job());
        expect(r.scam).toBeLessThan(30);
        expect(decide(r, { scamRiskThreshold: 60, hireabilityThreshold: 40 })).toBe('available');
    });
});

describe('hireability scoring', () => {
    it('marks US-only remote roles as unlikely for Nigeria-based applicants', () => {
        const r = scoreByRules(
            job({
                location: 'United States',
                remote_type: 'remote',
                description:
                    'Remote (US only). Must be authorized to work in the United States. We do not offer visa sponsorship. Paid via ACH.',
            }),
        );
        expect(r.hire).toBeLessThan(40);
        expect(decide({ scam: 0, hire: r.hire }, { scamRiskThreshold: 60, hireabilityThreshold: 40 })).toBe(
            'unlikely_hireable',
        );
    });

    it('rewards jobs located in Nigeria and worldwide remote roles', () => {
        expect(scoreByRules(job()).hire).toBeGreaterThanOrEqual(85);
        expect(
            scoreByRules(
                job({
                    location: '',
                    remote_type: 'remote',
                    description: 'Fully remote, work from anywhere in the world.',
                }),
            ).hire,
        ).toBeGreaterThan(70);
    });
});

describe('role match', () => {
    const relevant = (target, role) => roleMatch(target, { role }).relevant;

    it('keeps jobs in the same field and drops unrelated ones', () => {
        expect(relevant('frontend developer', 'Senior Full-Stack Developer — C#/.NET and React')).toBe(true);
        expect(relevant('frontend developer', 'Full-Stack Product Engineer')).toBe(true);
        expect(relevant('frontend developer', 'Junior React Developer')).toBe(true);
        expect(relevant('frontend developer', 'Secretary')).toBe(false);
        expect(relevant('frontend developer', 'Full-Time Pharmacist')).toBe(false);
        expect(relevant('frontend developer', 'Structured Office Cabling & ICT Infrastructure Engineer')).toBe(false);
        expect(relevant('frontend developer', 'Field Data Collector')).toBe(false);
        expect(relevant('accountant', 'Trainee Accountant(s)')).toBe(true);
        expect(relevant('accountant', 'Finance & Operations Officer')).toBe(true);
        expect(relevant('accountant', 'Frontend Developer')).toBe(false);
    });

    it('matches on shared title words and keeps everything for unknown roles', () => {
        expect(relevant('solar installer', 'Solar Technician/ Engineer')).toBe(true);
        expect(relevant('chef', 'Head Chef')).toBe(true);
        expect(relevant('zookeeper', 'Secretary')).toBe(true);
    });
});

describe('LLM gating', () => {
    it('only asks the LLM when the rules are unsure', () => {
        expect(needsLlm(job(), scoreByRules(job())).needed).toBe(false);
        expect(needsLlm(job({ structured: false }), scoreByRules(job())).needed).toBe(true);
        const risky = job({ description: 'Pay registration fee of N5,000 before your interview.' });
        expect(needsLlm(risky, scoreByRules(risky)).needed).toBe(true);
        const abroad = job({ location: '', remote_type: 'remote', description: 'Remote role.' });
        expect(needsLlm(abroad, scoreByRules(abroad)).needed).toBe(true);
    });
});

describe('combine', () => {
    it('never lets the LLM lower the rule scam score', () => {
        const rules = { scam: 70, scamReasons: ['fee'], hire: 80, hireReasons: [] };
        const llm = { scam: 0, scamReasons: [], hire: 60, hireReasons: [], requirements: [], application_method: '' };
        const out = combine(job(), rules, llm);
        expect(out.scam).toBe(70);
        expect(out.hire).toBe(70);
        expect(out.scoredBy).toBe('rules+llm');
    });
});

describe('dedup', () => {
    it('catches the same job reposted with different company suffix and word order', () => {
        const seen = new SeenJobs();
        seen.add(fingerprint(job()), { source: 'jobberman' });
        expect(
            seen.findDuplicate(fingerprint(job({ company: 'ACME Technologies Limited', source: 'myjobmag' }))),
        ).not.toBeNull();
        expect(seen.findDuplicate(fingerprint(job({ role: 'Developer Frontend' })))).not.toBeNull();
        expect(seen.findDuplicate(fingerprint(job({ role: 'Backend Engineer' })))).toBeNull();
    });
});

describe('pre-filter and extraction', () => {
    it('drops pasted text that is not a job post', () => {
        const [notJob] = pastedToRaw([
            'Happy Sunday everyone! Remember to drink water and share this message with your friends.',
        ]);
        expect(isLikelyJobPost(notJob).ok).toBe(false);
        const [realJob] = pastedToRaw([
            'We are hiring a sales executive in Abuja. Requirements: 2 years experience. Apply by sending your CV to hr@company.ng',
        ]);
        expect(isLikelyJobPost(realJob).ok).toBe(true);
    });

    it('pulls requirement lines from a Requirements section', () => {
        expect(extractRequirements(job().description)).toEqual(['3 years of React experience', 'Good communication']);
    });

    it('detects remote and hybrid work', () => {
        expect(detectRemoteType(job({ employment_type: 'Full Time, Remote' }))).toBe('remote');
        expect(detectRemoteType(job({ description: 'This is a hybrid role, 3 days in office.' }))).toBe('hybrid');
        expect(detectRemoteType(job())).toBe('onsite');
    });
});

describe('sources', () => {
    it('reads JobPosting from @graph and decodes escaped HTML descriptions', () => {
        const $ = load(
            `<script type="application/ld+json">{"@graph":[{"@type":"WebPage"},{"@type":"JobPosting","title":"Driver","description":"&lt;p&gt;&lt;strong&gt;Requirements&lt;/strong&gt;&lt;/p&gt;&lt;ul&gt;&lt;li&gt;Valid licence&lt;/li&gt;&lt;/ul&gt;"}]}</script>`,
        );
        const posting = findJobPosting($);
        expect(posting.title).toBe('Driver');
        expect(htmlToText(posting.description)).toBe('Requirements\n- Valid licence');
    });

    it('resolves @id references and tolerates raw line breaks inside JSON strings', () => {
        const $ = load(`<script type="application/ld+json">{"@graph":[
            {"@type":"Organization","@id":"#org","name":"Acme Ltd"},
            {"@type":"JobPosting","title":"Driver","description":"line one
line two","hiringOrganization":{"@id":"#org"}}]}</script>`);
        const posting = findJobPosting($);
        expect(posting.hiringOrganization.name).toBe('Acme Ltd');
        expect(posting.description).toContain('line one');
    });

    it('reads company, location and salary from Jobberman cards', () => {
        const card = (
            title,
            company,
        ) => `<div class="card"><div><a data-cy="listing-title-link" href="https://www.jobberman.com/listings/${title}" title="${title}">${title}</a></div>
            <p class="text-sm text-blue-700">${company}</p><span class="rounded">Lagos</span><span class="rounded">Full Time</span><span class="rounded">NGN 100,000 - 200,000</span></div>`;
        const $ = load(`<div class="container">${card('dev', 'Acme')}${card('qa', 'Beta')}</div>`);
        expect(parseJobbermanCards($)).toEqual([
            {
                url: 'https://www.jobberman.com/listings/dev',
                role: 'dev',
                company: 'Acme',
                location: 'Lagos',
                employment_type: 'Full Time',
                salary_range: 'NGN 100,000 - 200,000',
            },
            {
                url: 'https://www.jobberman.com/listings/qa',
                role: 'qa',
                company: 'Beta',
                location: 'Lagos',
                employment_type: 'Full Time',
                salary_range: 'NGN 100,000 - 200,000',
            },
        ]);
    });

    it('guesses role, company and location from pasted text', () => {
        expect(guessFields('We are hiring a Junior React Developer at fintech Kora Labs Ltd, Lagos (hybrid).')).toEqual(
            {
                role: 'Junior React Developer',
                company: 'Kora Labs Ltd',
                location: 'Lagos',
            },
        );
    });
});

describe('planner', () => {
    it('chooses tech categories and the remote board for a developer', () => {
        const plan = planSources({
            targetRole: 'frontend developer',
            location: 'Lagos',
            remotePreference: 'any',
            maxPagesPerSource: 3,
        });
        expect(plan.families).toContain('tech');
        expect(plan.steps.map((s) => s.url)).toContain('https://www.jobberman.com/jobs/software-data');
        expect(plan.steps.map((s) => s.url)).toContain('https://www.myjobmag.com/jobs-by-field/information-technology');
        expect(plan.steps.every((s) => s.reason)).toBe(true);
    });

    it('chooses different sources for a non-tech role', () => {
        const plan = planSources({
            targetRole: 'accountant',
            location: 'Abuja',
            remotePreference: 'onsite',
            maxPagesPerSource: 3,
        });
        const urls = plan.steps.map((s) => s.url);
        expect(urls).toContain('https://www.jobberman.com/jobs/accounting-auditing-finance');
        expect(urls).toContain('https://www.jobberman.com/jobs/abuja');
        expect(urls).not.toContain('https://www.jobberman.com/jobs/remote');
    });
});
