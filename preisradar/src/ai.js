import { getSetting } from './settings.js';

export const DEFAULT_MODEL = 'gpt-4.1-mini';

export function aiConfig(db) {
  return {
    key: getSetting(db, 'openai_api_key') || process.env.OPENAI_API_KEY || '',
    model: getSetting(db, 'openai_model') || process.env.OPENAI_MODEL || DEFAULT_MODEL,
    base: (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, ''),
  };
}

/** Chat-Completion mit JSON-Antwort (OpenAI-kompatibel). */
export async function chatJson(cfg, system, user, { timeout = 150000 } = {}) {
  if (!cfg.key) throw new Error('OpenAI-API-Schlüssel fehlt (Einstellungen → KI)');
  let res;
  try {
    res = await fetch(`${cfg.base}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.key}` },
      signal: AbortSignal.timeout(timeout),
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          { role: 'system', content: `${system}\nAntworte ausschließlich mit einem gültigen JSON-Objekt.` },
          { role: 'user', content: typeof user === 'string' ? user : JSON.stringify(user) },
        ],
        response_format: { type: 'json_object' },
      }),
    });
  } catch (e) {
    throw new Error(e.name === 'TimeoutError' ? 'OpenAI antwortet nicht (Zeitüberschreitung)' : `OpenAI nicht erreichbar: ${e.cause?.code || e.message}`);
  }
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`OpenAI antwortet mit HTTP ${res.status} (kein JSON)`);
  }
  if (!res.ok) {
    const msg = json.error?.message || `HTTP ${res.status}`;
    throw new Error(res.status === 401 ? 'OpenAI: API-Schlüssel ungültig' : `OpenAI: ${msg}`);
  }
  const content = json.choices?.[0]?.message?.content;
  try {
    return { data: JSON.parse(content), usage: json.usage ?? null };
  } catch {
    throw new Error('Die KI-Antwort war kein gültiges JSON');
  }
}

export async function testAi(cfg) {
  await chatJson(cfg, 'Du bist ein Verbindungstest. Antworte mit {"ok": true}.', 'Test', { timeout: 30000 });
  return { ok: true, model: cfg.model };
}
