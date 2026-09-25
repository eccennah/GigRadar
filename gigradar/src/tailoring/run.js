// Tailoring tool (tailor_resume): diffs the resume against a job, rewrites only what can honestly be reframed,
// and flags genuine gaps to the user instead of inventing experience.
import { Actor, log } from 'apify';

import { llmConfigFromEnv } from '../llm.js';
import { diffByRules, extractRequirements, matchScore, parseResume } from './resume.js';
import {
    buildTailoredResume,
    gapQuestionsByRules,
    mergeWithLlm,
    reframeSuggestionsByRules,
    tailorWithLlm,
} from './tailor.js';

/**
 * @param {{ resumeText: string, job: { id?: string, role?: string, company?: string, url?: string, description?: string, requirements?: string[] }, useLlm?: boolean }} args
 */
export async function runTailoring({ resumeText, job, useLlm = true }) {
    const requirements = job.requirements?.length ? job.requirements : extractRequirements(job.description ?? '');
    if (!requirements.length)
        throw new Error(`No requirements found for "${job.role || 'the job'}", so there is nothing to tailor to.`);

    const resumeLines = parseResume(resumeText);
    let diff = diffByRules(requirements, resumeLines);

    const llm = useLlm ? llmConfigFromEnv() : null;
    let rewrites = [];
    let rejected = [];
    let summary = '';
    let gapQuestions = [];
    let scoredBy = 'rules';
    if (llm) {
        try {
            const answer = await tailorWithLlm(llm, {
                resumeText,
                job: { role: job.role ?? '', company: job.company ?? '', description: job.description ?? '' },
                diff,
            });
            const merged = mergeWithLlm({ diff, llm: answer, resumeText, resumeLines });
            ({ diff, rewrites, rejected, summary, gapQuestions } = merged);
            scoredBy = 'rules+llm';
            for (const r of rejected) log.warning(`Rejected a rewrite that invented: ${r.invented.join(', ')}`);
        } catch (error) {
            log.warning(`LLM failed, tailoring with rules only: ${error.message}`);
        }
    }
    if (!gapQuestions.length) gapQuestions = gapQuestionsByRules(diff);
    const suggestions = rewrites.length ? [] : reframeSuggestionsByRules(diff);
    const tailoredResume = buildTailoredResume({ resumeText, rewrites, summary });

    const pick = (status) => diff.filter((d) => d.status === status);
    const record = {
        record_type: 'tailoring',
        job_id: job.id ?? null,
        role: job.role ?? '',
        company: job.company ?? '',
        job_url: job.url ?? null,
        match_score: matchScore(diff),
        matched: pick('matched').map(({ requirement, evidence }) => ({ requirement, evidence })),
        reframed: pick('reframe').map(({ requirement, evidence, reason }) => ({ requirement, evidence, reason })),
        gaps: pick('gap').map(({ requirement, reason }) => ({ requirement, reason })),
        gap_questions: gapQuestions,
        rewrites,
        rejected_rewrites: rejected,
        suggestions,
        tailored_resume: tailoredResume,
        scored_by: scoredBy,
        created_at: new Date().toISOString(),
    };
    await Actor.pushData(record);
    const key = `TAILORED_RESUME-${(job.id ?? 'pasted').slice(0, 16)}`;
    await Actor.setValue(key, tailoredResume, { contentType: 'text/markdown' });
    await Actor.charge({ eventName: 'resume_tailored' });
    log.info(
        `[TAILORED] ${record.role || 'job'} at ${record.company || 'company'}: match ${record.match_score}%, ${record.gaps.length} gaps flagged, ${rewrites.length} rewrites (${key})`,
    );
    return { ...record, key };
}
