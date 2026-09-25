// Minimal client for any OpenAI-compatible chat completions API (Google AI Studio, OpenAI, Groq, DeepSeek, OpenRouter...).
// Configured through environment variables so the key never appears in input or logs:
//   LLM_API_KEY  - required to enable the LLM; without it the agent runs on rules only
//   LLM_BASE_URL - e.g. https://generativelanguage.googleapis.com/v1beta/openai (Google AI Studio)
//   LLM_MODEL    - model id, or a comma-separated list tried in order when a model is overloaded
import { log } from 'apify';

// Thinking models (e.g. Gemini Flash) can spend several seconds reasoning before they answer.
const ATTEMPT_TIMEOUT_MS = 40_000;

export function llmConfigFromEnv(env = process.env) {
    const apiKey = env.LLM_API_KEY?.trim();
    const models = (env.LLM_MODEL ?? '')
        .split(',')
        .map((m) => m.trim())
        .filter(Boolean);
    if (!apiKey) return null;
    if (!models.length) {
        log.warning('LLM_API_KEY is set but LLM_MODEL is not, so the LLM is disabled. Set LLM_MODEL to enable it.');
        return null;
    }
    return {
        apiKey,
        models,
        model: models.join(', '),
        baseUrl: (env.LLM_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, ''),
    };
}

const sleep = async (ms) =>
    new Promise((r) => {
        setTimeout(r, ms);
    });

async function callModel(config, model, { system, user, maxTokens }) {
    const res = await fetch(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify({
            model,
            temperature: 0,
            max_tokens: maxTokens,
            response_format: { type: 'json_object' },
            // Gemma models on Google AI Studio reject system messages, so fold the instructions into the user turn.
            messages: /^gemma/i.test(model)
                ? [{ role: 'user', content: `${system}\n\n${user}` }]
                : [
                      { role: 'system', content: system },
                      { role: 'user', content: user },
                  ],
        }),
        signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
    });
    if (!res.ok) {
        const body = await res.text();
        const error = new Error(`${model} returned ${res.status}: ${body.slice(0, 200).replace(/\s+/g, ' ')}`);
        // Only a bad key stops everything; overload, quota, retired models or an unsupported request are worth
        // trying on the next model.
        error.retryable = res.status !== 401 && res.status !== 403;
        throw error;
    }
    const data = await res.json();
    const content = data.choices?.[0]?.message?.content ?? '';
    // Some models wrap JSON in a code fence even in JSON mode.
    return JSON.parse(content.replace(/^```(?:json)?\s*|\s*```$/g, ''));
}

/**
 * Ask the model for a JSON object. Tries each configured model in turn when one is overloaded,
 * then throws. The shape is enforced by the caller.
 */
export async function chatJson(config, { system, user, maxTokens = 4000, rounds = 1 }) {
    let lastError;
    for (let round = 0; round < rounds; round++) {
        for (const model of config.models) {
            try {
                return await callModel(config, model, { system, user, maxTokens });
            } catch (error) {
                lastError = error;
                if (error.name === 'TimeoutError') error.retryable = true;
                if (error.retryable === false) throw error;
            }
        }
        if (round < rounds - 1) await sleep(1500);
    }
    throw lastError;
}

/**
 * One step of a tool-calling conversation (OpenAI-compatible "tools"). Returns the assistant message:
 * { content, tool_calls: [{ id, function: { name, arguments } }] }. Tries each configured model in turn.
 */
export async function chatWithTools(config, { messages, tools, maxTokens = 2000 }) {
    let lastError;
    for (const model of config.models) {
        try {
            const res = await fetch(`${config.baseUrl}/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
                body: JSON.stringify({
                    model,
                    temperature: 0,
                    max_tokens: maxTokens,
                    messages,
                    tools,
                    tool_choice: 'auto',
                }),
                signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
            });
            if (!res.ok) {
                const error = new Error(
                    `${model} returned ${res.status}: ${(await res.text()).slice(0, 200).replace(/\s+/g, ' ')}`,
                );
                if (res.status === 401 || res.status === 403) throw Object.assign(error, { fatal: true });
                throw error;
            }
            const data = await res.json();
            return { model, message: data.choices?.[0]?.message ?? {} };
        } catch (error) {
            lastError = error;
            if (error.fatal) throw error;
        }
    }
    throw lastError;
}
