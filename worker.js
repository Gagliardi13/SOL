// Servidor intermediário da Sol (Cloudflare Worker).
// Guarda a sua chave da OpenAI e entrega ao app só um acesso temporário (expira em minutos).
//
// Variáveis a configurar no painel do Cloudflare (Settings > Variables and Secrets):
//   OPENAI_API_KEY   (Secret)  sua chave da OpenAI, começa com "sk-"
//   APP_TOKEN        (Secret)  uma senha inventada por você; o app pede essa senha
//   ALLOWED_ORIGINS  (Text)    endereço do seu site, ex.: https://gagliardi13.github.io
//   MODEL            (Text, opcional) padrão: gpt-realtime-mini

const VOICES = ['marin', 'coral', 'shimmer', 'sage', 'cedar', 'alloy', 'ash', 'ballad', 'echo', 'verse'];

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGINS || '')
      .split(',')
      .map((s) => s.trim().replace(/\/+$/, ''))
      .filter(Boolean);
    const originOk = allowed.length === 0 || allowed.includes(origin);

    const cors = {
      'Access-Control-Allow-Origin': originOk && origin ? origin : 'null',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-App-Token',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    };
    const reply = (status, body) =>
      new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status,
        headers: { ...cors, 'Content-Type': 'application/json' },
      });

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const url = new URL(request.url);
    if (url.pathname === '/' && request.method === 'GET') return reply(200, { ok: true, servico: 'sol' });
    if (url.pathname !== '/session' || request.method !== 'POST') return reply(404, { erro: 'rota não encontrada' });
    if (!originOk) return reply(403, { erro: 'origem não autorizada' });
    if (!env.OPENAI_API_KEY || !env.APP_TOKEN) return reply(500, { erro: 'Worker sem OPENAI_API_KEY ou APP_TOKEN configurados' });
    if (!(await safeEqual(request.headers.get('X-App-Token') || '', env.APP_TOKEN))) return reply(401, { erro: 'senha incorreta' });

    let body = {};
    try {
      body = await request.json();
    } catch {}
    const voice = VOICES.includes(body.voice) ? body.voice : 'marin';

    const r = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expires_after: { anchor: 'created_at', seconds: 120 },
        session: {
          type: 'realtime',
          model: env.MODEL || 'gpt-realtime-mini',
          audio: {
            input: {
              turn_detection: { type: 'semantic_vad', eagerness: 'auto', create_response: true, interrupt_response: true },
            },
            output: { voice },
          },
        },
      }),
    });
    const data = await r.text();
    if (!r.ok) return reply(r.status, { erro: 'OpenAI recusou', detalhe: data.slice(0, 500) });
    const json = JSON.parse(data);
    return reply(200, { value: json.value, expires_at: json.expires_at });
  },
};

// comparação de senha em tempo constante
async function safeEqual(a, b) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  const x = new Uint8Array(ha), y = new Uint8Array(hb);
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}
