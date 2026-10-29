// Entende a emoção da conversa: uma IA pequena e barata (via Worker) lê o que você
// fala e o que a Sol responde, e decide a reação dela (rosto + gesto).
export class EmotionEngine {
  constructor({ workerUrl, appToken, onReaction, onError }) {
    this.url = workerUrl.replace(/\/+$/, '') + '/emocao';
    this.token = appToken;
    this.onReaction = onReaction;
    this.onError = onError || (() => {});
    this.history = []; // últimas falas, para dar contexto
    this.busy = false;
    this.pending = null;
    this.lastSent = 0;
    this.lastText = '';
    this.disabled = false;
    this.failures = 0;
  }

  remember(who, text) {
    if (!text || !text.trim()) return;
    this.history.push(`${who === 'user' ? 'Ele' : 'Sol'}: ${text.trim()}`);
    if (this.history.length > 6) this.history.shift();
  }

  // who: 'user' (você falando, reação de quem escuta) ou 'sol' (o que ela está dizendo)
  analyze(who, text, { urgent = false } = {}) {
    if (this.disabled || !text || text.trim().length < 6) return;
    const req = { who, text: text.trim().slice(-400) };
    if (this.busy) { this.pending = req; return; }
    const wait = urgent ? 0 : Math.max(0, 1100 - (performance.now() - this.lastSent));
    if (wait > 0) {
      this.pending = req;
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this._flush(), wait);
      return;
    }
    this._send(req);
  }

  _flush() {
    if (this.busy || !this.pending) return;
    const r = this.pending;
    this.pending = null;
    this._send(r);
  }

  async _send({ who, text }) {
    if (text === this.lastText) return;
    this.lastText = text;
    this.busy = true;
    this.lastSent = performance.now();
    try {
      const r = await fetch(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-App-Token': this.token },
        body: JSON.stringify({ who, text, context: this.history.slice(-4) }),
      });
      if (!r.ok) throw new Error(`emoção ${r.status}: ${(await r.text()).slice(0, 200)}`);
      const data = await r.json();
      this.failures = 0;
      this.onReaction(data, who);
    } catch (e) {
      this.failures++;
      if (this.failures >= 3) {
        this.disabled = true; // não insiste: a conversa continua normal sem as emoções
        this.onError('Emoções desativadas nesta sessão: ' + e.message);
      }
    } finally {
      this.busy = false;
      if (this.pending) setTimeout(() => this._flush(), 50);
    }
  }
}
