import { describe, expect, it } from 'vitest';

import {
    diffByRules,
    extractRequirements,
    gapTerms,
    inventedFacts,
    keywords,
    matchScore,
    parseResume,
} from '../src/tailoring/resume.js';
import { buildTailoredResume, gapQuestionsByRules, mergeWithLlm } from '../src/tailoring/tailor.js';

const RESUME = `Ada Obi
Frontend developer in Lagos

Experience
- Built customer dashboards in React and JavaScript for a fintech startup, used by 12,000 merchants
- Worked with the backend team to connect REST APIs
- Wrote unit tests with Jest

Skills
React, JavaScript, HTML, CSS, Git, Jest`;

const JOB = `Frontend Developer at Kora Labs
Requirements
- Strong experience with React
- Experience consuming REST APIs
- Experience writing automated tests for frontend code
- TypeScript
- 3+ years of Kubernetes
Benefits
- HMO`;

const lines = parseResume(RESUME);
const diff = diffByRules(extractRequirements(JOB), lines);
const statusOf = (d) => Object.fromEntries(d.map((x) => [x.requirement, x.status]));

describe('requirements and resume parsing', () => {
    it('extracts requirement lines and stops at the next section', () => {
        expect(extractRequirements(JOB)).toEqual([
            'Strong experience with React',
            'Experience consuming REST APIs',
            'Experience writing automated tests for frontend code',
            'TypeScript',
            '3+ years of Kubernetes',
        ]);
    });

    it('keeps tech tokens and drops filler words', () => {
        expect(keywords('Strong experience with Node.js and C#')).toEqual(['node.js', 'c#']);
    });
});

describe('rule diff', () => {
    it('separates matched, reframe and gap', () => {
        expect(statusOf(diff)).toEqual({
            'Strong experience with React': 'matched',
            'Experience consuming REST APIs': 'matched',
            'Experience writing automated tests for frontend code': 'reframe',
            TypeScript: 'gap',
            '3+ years of Kubernetes': 'gap',
        });
        expect(matchScore(diff)).toBe(50);
        expect(gapQuestionsByRules(diff)).toHaveLength(2);
    });
});

describe('anti-fabrication', () => {
    const forbidden = gapTerms(diff, RESUME);

    it('allows the job wording for reframes but blocks invented numbers, tools and gap skills', () => {
        expect(inventedFacts('Built React dashboards used by 12,000 merchants', RESUME, forbidden)).toEqual([]);
        expect(inventedFacts('Wrote automated unit tests with Jest for frontend code', RESUME, forbidden)).toEqual([]);
        expect(
            inventedFacts('Built React and TypeScript dashboards used by 50,000 merchants', RESUME, forbidden),
        ).toEqual(['50,000', 'TypeScript', 'typescript']);
        expect(inventedFacts('Deployed apps on Kubernetes', RESUME, forbidden)).toContain('kubernetes');
    });

    it('drops LLM rewrites and upgrades that are not backed by the resume', () => {
        const llm = {
            requirements: [
                {
                    requirement: 'Experience writing automated tests for frontend code',
                    status: 'matched',
                    evidence: 'Wrote unit tests with Jest',
                    reason: 'Jest unit tests are automated frontend tests',
                },
                { requirement: 'TypeScript', status: 'matched', evidence: 'Used TypeScript daily', reason: 'made up' },
            ],
            rewrites: [
                {
                    original: 'Wrote unit tests with Jest',
                    rewritten: 'Wrote automated unit tests with Jest for frontend code',
                    requirement: 'Experience writing automated tests for frontend code',
                },
                {
                    original: 'Worked with the backend team to connect REST APIs',
                    rewritten: 'Consumed REST APIs from the backend team using TypeScript on Kubernetes',
                    requirement: 'TypeScript',
                },
            ],
            summary: 'Frontend developer building React dashboards for a fintech startup.',
            gap_questions: ['This role wants TypeScript. Do you have experience to add?'],
        };
        const out = mergeWithLlm({ diff, llm, resumeText: RESUME, resumeLines: lines });
        const status = statusOf(out.diff);
        expect(status['Experience writing automated tests for frontend code']).toBe('matched');
        expect(status.TypeScript).toBe('gap');
        expect(out.rewrites).toHaveLength(1);
        expect(out.rejected).toHaveLength(1);
        expect(out.rejected[0].invented).toEqual(expect.arrayContaining(['TypeScript', 'kubernetes']));
        expect(out.summary).toMatch(/React dashboards/);

        const tailored = buildTailoredResume({ resumeText: RESUME, rewrites: out.rewrites, summary: out.summary });
        expect(tailored).toContain('Wrote automated unit tests with Jest for frontend code');
        expect(tailored).toContain('Worked with the backend team to connect REST APIs');
        expect(tailored.startsWith('**Profile:**')).toBe(true);
    });
});
