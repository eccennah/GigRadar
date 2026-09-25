// Discovery tool (scrape_sources / score_job): finds jobs, decides which are safe and realistically hireable from Nigeria,
// and only charges for listings it actually delivers or flags.
import { CheerioCrawler, createCheerioRouter } from '@crawlee/cheerio';
import { Actor, log } from 'apify';

import { llmConfigFromEnv } from '../llm.js';
import {
    assessWithLlm,
    combine,
    decide,
    detectApplicationMethod,
    detectRemoteType,
    extractRequirements,
    fingerprint,
    guessFields,
    isLikelyJobPost,
    jobId,
    needsLlm,
    roleMatch,
    scoreByRules,
    SeenJobs,
} from './pipeline.js';
import { planSources } from './planner.js';
import { parseDetailPage, parseJobbermanCards, parseMyJobMagCards, pastedToRaw } from './sources.js';

/** Find, score and decide on jobs. Returns every job record it produced (pushed to the dataset) and run stats. */
export async function runDiscovery(input = {}) {
    const {
        targetRole = '',
        location = 'Nigeria',
        remotePreference = 'any',
        sources = [],
        pastedJobs = [],
        maxPagesPerSource = 2,
        maxJobsPerSource = 20,
        scamRiskThreshold = 60,
        hireabilityThreshold = 40,
        includeSuppressed = true,
        onlyMatchingRoles = true,
        useLlm = true,
        maxLlmCalls = 10,
        seenJobsStoreName = 'gigradar-agent-seen-jobs',
        resetSeenJobs = false,
    } = input;

    if (!targetRole.trim() && !pastedJobs.length) {
        throw new Error('Input "targetRole" is required unless you only provide "pastedJobs".');
    }
    for (const [name, value] of Object.entries({ scamRiskThreshold, hireabilityThreshold })) {
        if (!(value >= 0 && value <= 100)) throw new Error(`Input "${name}" must be between 0 and 100, got ${value}.`);
    }

    // ---------------------------------------------------------------------------
    // Step 1: plan which sources to query for this user.
    // ---------------------------------------------------------------------------
    const plan = planSources({
        targetRole,
        location,
        remotePreference,
        sources,
        maxPagesPerSource,
        hasPastedJobs: pastedJobs.length > 0,
    });
    log.info(
        `Plan: ${plan.sources.join(', ') || 'nothing to query'}${plan.families.length ? ` (role families: ${plan.families.join(', ')})` : ''}`,
    );
    for (const step of plan.steps) log.info(`  ${step.source}: ${step.url} (${step.reason})`);
    await Actor.setValue('DISCOVERY_PLAN', { targetRole, location, remotePreference, ...plan });

    // ---------------------------------------------------------------------------
    // Step 2: fetch raw listings.
    // ---------------------------------------------------------------------------
    const raws = [];
    const jobs = [];
    const queuedPerSource = {};
    let skippedByTitle = 0;
    const router = createCheerioRouter();

    router.addHandler('LISTING', async ({ request, $, crawler }) => {
        const { source } = request.userData;
        const cards = source === 'jobberman' ? parseJobbermanCards($) : parseMyJobMagCards($, request.loadedUrl);
        log.info(`${source}: ${cards.length} listings on ${request.loadedUrl}`);
        for (const card of cards) {
            // Check the title before opening the job page, so the per-source cap is spent on jobs in the user's field.
            if (onlyMatchingRoles && card.role && !roleMatch(targetRole, card).relevant) {
                skippedByTitle++;
                continue;
            }
            queuedPerSource[source] ??= 0;
            if (queuedPerSource[source] >= maxJobsPerSource) break;
            // Reserve the slot before awaiting, so listing pages handled in parallel cannot overshoot the cap.
            queuedPerSource[source]++;
            const { wasAlreadyPresent } = await crawler
                .addRequests([{ url: card.url, label: 'DETAIL', userData: { source, card } }])
                .then((r) => r.addedRequests[0] ?? {});
            if (wasAlreadyPresent) queuedPerSource[source]--;
        }
    });

    router.addHandler('DETAIL', async ({ request, $ }) => {
        const { source, card } = request.userData;
        raws.push(parseDetailPage($, { url: request.loadedUrl, source, card }));
    });

    if (plan.steps.length) {
        const crawler = new CheerioCrawler({
            requestHandler: router,
            // Be polite to the job boards.
            maxConcurrency: 4,
            maxRequestsPerMinute: 60,
            maxRequestRetries: 2,
            failedRequestHandler: ({ request }, error) => log.warning(`Failed ${request.url}: ${error.message}`),
        });
        await crawler.run(plan.steps.map((s) => ({ url: s.url, label: 'LISTING', userData: { source: s.source } })));
    }
    if (plan.sources.includes('pasted')) raws.push(...pastedToRaw(pastedJobs));
    log.info(`Fetched ${raws.length} raw listings (skipped ${skippedByTitle} listings outside your field by title)`);

    // ---------------------------------------------------------------------------
    // Steps 3-7: pre-filter, dedup, extract, score, decide, charge.
    // ---------------------------------------------------------------------------
    const llm = useLlm ? llmConfigFromEnv() : null;
    log.info(llm ? `LLM enabled (${llm.model})` : 'LLM disabled: scoring with rules only');

    const seenStore = await Actor.openKeyValueStore(seenJobsStoreName);
    const seen = new SeenJobs(resetSeenJobs ? [] : ((await seenStore.getValue('SEEN')) ?? []));

    const stats = {
        fetched: raws.length,
        notAJob: 0,
        notRelevant: skippedByTitle,
        duplicates: 0,
        available: 0,
        scam_flagged: 0,
        unlikely_hireable: 0,
        llmCalls: 0,
        llmErrors: 0,
        charged: {},
    };
    let budgetReached = false;
    // When the LLM provider is overloaded, stop waiting on it and finish the run on rules.
    const LLM_CIRCUIT_BREAKER = 3;
    let llmFailuresInARow = 0;
    let llmLock = Promise.resolve();
    const withLlmLock = async (fn) => {
        const run = llmLock.then(fn);
        llmLock = run.catch(() => {});
        return run;
    };

    async function charge(eventName) {
        const result = await Actor.charge({ eventName });
        stats.charged[eventName] = (stats.charged[eventName] ?? 0) + 1;
        if (result.eventChargeLimitReached) budgetReached = true;
    }

    async function processListing(raw) {
        const filter = isLikelyJobPost(raw);
        if (!filter.ok) {
            stats.notAJob++;
            log.debug(`Skipped (${filter.reason}): ${raw.url ?? 'pasted text'}`);
            return;
        }

        const guessed = raw.structured ? {} : guessFields(raw.description);
        const job = {
            ...raw,
            role: raw.role || guessed.role || '',
            company: raw.company || guessed.company || '',
            location: raw.location || guessed.location || '',
            remote_type: detectRemoteType(raw),
            application_method: detectApplicationMethod(raw),
            requirements: extractRequirements(raw.description),
        };

        // Jobs outside the user's field never reach the feed: no charge, no LLM call, and not remembered as seen,
        // so a later search for a different role can still find them. Pasted posts were chosen by the user, so they skip this.
        if (onlyMatchingRoles && job.source !== 'pasted') {
            const match = roleMatch(targetRole, job);
            if (!match.relevant) {
                stats.notRelevant++;
                log.info(`[NOT RELEVANT] ${match.reason}`);
                return;
            }
        }

        // Dedup before the LLM call so reposts cost nothing.
        const fp = fingerprint(job);
        const duplicateOf = seen.findDuplicate(fp);
        if (duplicateOf) {
            stats.duplicates++;
            log.info(
                `Duplicate of an earlier ${duplicateOf.source} listing: ${job.role || 'untitled'} at ${job.company || 'unknown company'}`,
            );
            return;
        }
        // Reserve the fingerprint now, so a copy handled by another worker during the LLM call is caught.
        const id = jobId(fp);
        seen.add(fp, { id, source: job.source, first_seen: new Date().toISOString() });

        const rules = scoreByRules(job);
        let assessment = null;
        if (llm && needsLlm(job, rules).needed) {
            // One LLM call at a time keeps free-tier per-minute limits happy; rule-only listings keep flowing meanwhile.
            assessment = await withLlmLock(async () => {
                if (llmFailuresInARow >= LLM_CIRCUIT_BREAKER || stats.llmCalls >= maxLlmCalls) return null;
                stats.llmCalls++;
                try {
                    const result = await assessWithLlm(llm, job);
                    llmFailuresInARow = 0;
                    return result;
                } catch (error) {
                    stats.llmErrors++;
                    llmFailuresInARow++;
                    log.warning(`LLM failed, using rules only for ${job.url ?? 'pasted text'}: ${error.message}`);
                    if (llmFailuresInARow === LLM_CIRCUIT_BREAKER) {
                        log.warning(
                            `LLM failed ${LLM_CIRCUIT_BREAKER} times in a row: using rules only for the rest of this run.`,
                        );
                    }
                    return null;
                }
            });
            if (assessment && !assessment.is_job_post && !job.structured) {
                stats.notAJob++;
                return;
            }
        }

        const scored = combine(job, rules, assessment);
        // Pasted text only gets a proper company/role after extraction, so check again with the extracted fields.
        if (!job.structured && scored.job.company && scored.job.role) {
            const extractedFp = fingerprint({ ...scored.job, description: '' });
            // Ignore this listing's own reservation from above.
            if (seen.findDuplicate(extractedFp, id)) {
                stats.duplicates++;
                return;
            }
            if (extractedFp.key !== fp.key)
                seen.add(extractedFp, { id, source: job.source, first_seen: new Date().toISOString() });
        }
        const decision = decide(scored, { scamRiskThreshold, hireabilityThreshold });
        stats[decision]++;

        const { job: j } = scored;
        const item = {
            record_type: 'job',
            id,
            decision,
            role: j.role,
            company: j.company,
            salary_range: j.salary_range,
            location: j.location,
            remote_type: j.remote_type,
            application_method: j.application_method,
            source: j.source,
            url: j.url,
            hireability_score: scored.hire,
            scam_risk_score: scored.scam,
            scam_reasons: scored.scamReasons,
            hireability_reasons: scored.hireReasons,
            requirements: j.requirements,
            raw_excerpt: j.description.slice(0, 500),
            posted_at: j.posted_at,
            scored_by: scored.scoredBy,
            created_at: new Date().toISOString(),
        };

        jobs.push(item);
        if (decision === 'available' || includeSuppressed) await Actor.pushData(item);
        if (decision === 'available') await charge('job_normalized');
        if (decision === 'scam_flagged') await charge('scam_flag_issued');

        const tag = { available: 'AVAILABLE', scam_flagged: 'SCAM FLAG', unlikely_hireable: 'UNLIKELY HIREABLE' }[
            decision
        ];
        log.info(
            `[${tag}] ${item.role} at ${item.company || 'unknown company'} (scam ${item.scam_risk_score}, hireability ${item.hireability_score})`,
        );
    }

    // Small worker pool: a few listings at a time keeps LLM calls fast without hitting rate limits.
    const queue = [...raws];
    await Promise.all(
        Array.from({ length: 3 }, async () => {
            while (queue.length && !budgetReached) await processListing(queue.shift());
        }),
    );
    if (budgetReached) log.warning('Stopped early: the run reached its maximum charge limit.');

    await seenStore.setValue('SEEN', seen.toJSON());
    log.info(
        `Done: ${stats.available} available, ${stats.scam_flagged} scam-flagged, ${stats.unlikely_hireable} unlikely hireable, ${stats.notRelevant} not your field, ${stats.duplicates} duplicates, ${stats.notAJob} not job posts`,
    );

    return { jobs, stats, plan };
}
