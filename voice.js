// Voz da Sol: conexão em tempo real com a OpenAI (WebRTC) + análise do áudio
// dela para mexer a boca.
const OPENAI_CALLS = 'https://api.openai.com/v1/realtime/calls';

export class VoiceLink extends EventTarget {
  constructor({ workerUrl, appToken, voice }) {
    super();
    this.workerUrl = workerUrl.replace(/\/+$/, '');
    this.appToken = appToken;
    this.voice = voice;
    this.level = 0;
    this.visemes = { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 };
    this.solSpeaking = false;
    this.userSpeaking = false;
    this.connected = false;
  }

  _emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  async connect(micStream) {
    // 1) pede ao servidor intermediário um acesso temporário (a chave real nunca vem pro celular)
    let r;
    try {
      r = await fetch(this.workerUrl + '/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-App-Token': this.appToken },
        body: JSON.stringify({ voice: this.voice }),
      });
    } catch (e) {
      throw new Error('Não consegui falar com o servidor (Worker). Confira o endereço. ' + e.message);
    }
    if (!r.ok) {
      const txt = await r.text();
      if (r.status === 401) throw new Error('Senha do app incorreta.');
      throw new Error(`Servidor respondeu ${r.status}: ${txt.slice(0, 300)}`);
    }
    const { value } = await r.json();
    if (!value) throw new Error('O servidor não devolveu o acesso temporário.');

    // 2) WebRTC direto com a OpenAI
    this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    await this.audioCtx.resume();

    const pc = (this.pc = new RTCPeerConnection());
    this.audioEl = document.createElement('audio');
    this.audioEl.autoplay = true;
    this.audioEl.playsInline = true;
    this.audioEl.style.display = 'none';
    document.body.appendChild(this.audioEl);

    pc.ontrack = (e) => {
      this.audioEl.srcObject = e.streams[0];
      this.audioEl.play().catch(() => {});
      this._setupAnalyser(e.streams[0]);
    };
    pc.onconnectionstatechange = () => {
      if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) {
        this.connected = false;
        this._emit('closed', pc.connectionState);
      }
    };

    this.micStream = micStream;
    for (const track of micStream.getAudioTracks()) pc.addTrack(track, micStream);

    const dc = (this.dc = pc.createDataChannel('oai-events'));
    dc.onmessage = (e) => {
      try {
        this._onEvent(JSON.parse(e.data));
      } catch (err) {
        console.warn('evento inválido', err);
      }
    };
    const opened = new Promise((res, rej) => {
      dc.onopen = res;
      setTimeout(() => rej(new Error('Tempo esgotado abrindo o canal de dados.')), 15000);
    });

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const sdpRes = await fetch(OPENAI_CALLS, {
      method: 'POST',
      body: offer.sdp,
      headers: { Authorization: `Bearer ${value}`, 'Content-Type': 'application/sdp' },
    });
    if (!sdpRes.ok) throw new Error(`OpenAI recusou a conexão (${sdpRes.status}): ${(await sdpRes.text()).slice(0, 300)}`);
    await pc.setRemoteDescription({ type: 'answer', sdp: await sdpRes.text() });
    await opened;
    this.connected = true;
    this._emit('open');
  }

  send(obj) {
    if (this.dc && this.dc.readyState === 'open') this.dc.send(JSON.stringify(obj));
  }

  setInstructions(instructions) {
    this.send({ type: 'session.update', session: { type: 'realtime', instructions } });
  }

  // legenda do que você fala (enviado separado: se falhar, o resto continua funcionando)
  enableUserTranscript() {
    this.send({
      type: 'session.update',
      session: {
        type: 'realtime',
        audio: { input: { transcription: { model: 'gpt-4o-mini-transcribe', language: 'pt' } } },
      },
    });
  }

  say(instructions) {
    this.send({ type: 'response.create', response: { instructions } });
  }

  setMicEnabled(on) {
    if (this.micStream) this.micStream.getAudioTracks().forEach((t) => (t.enabled = on));
  }

  close() {
    try {
      this.dc && this.dc.close();
      this.pc && this.pc.close();
    } catch {}
    this.connected = false;
  }

  _onEvent(ev) {
    switch (ev.type) {
      case 'input_audio_buffer.speech_started':
        this.userSpeaking = true;
        this._emit('user-start');
        break;
      case 'input_audio_buffer.speech_stopped':
        this.userSpeaking = false;
        this._emit('user-stop');
        break;
      case 'output_audio_buffer.started':
        this.solSpeaking = true;
        this._emit('sol-start');
        break;
      case 'output_audio_buffer.stopped':
      case 'output_audio_buffer.cleared':
        this.solSpeaking = false;
        this._emit('sol-stop');
        break;
      case 'response.output_audio_transcript.delta':
        this._emit('sol-text', ev.delta || '');
        break;
      case 'response.output_audio_transcript.done':
        this._emit('sol-text-done', ev.transcript || '');
        break;
      case 'conversation.item.input_audio_transcription.completed':
        this._emit('user-text', ev.transcript || '');
        break;
      case 'error':
        console.warn('OpenAI error', ev.error);
        this._emit('api-error', ev.error && ev.error.message ? ev.error.message : JSON.stringify(ev.error));
        break;
    }
  }

  _setupAnalyser(stream) {
    const src = this.audioCtx.createMediaStreamSource(stream);
    const an = (this.analyser = this.audioCtx.createAnalyser());
    an.fftSize = 1024;
    an.smoothingTimeConstant = 0.35;
    src.connect(an); // não conecta na saída: o som já sai pelo elemento <audio>
    this.timeBuf = new Float32Array(an.fftSize);
    this.freqBuf = new Uint8Array(an.frequencyBinCount);
  }

  // chamado a cada frame: calcula volume e formato aproximado da boca
  tick() {
    const an = this.analyser;
    if (!an) return;
    an.getFloatTimeDomainData(this.timeBuf);
    let sum = 0;
    for (let i = 0; i < this.timeBuf.length; i++) sum += this.timeBuf[i] * this.timeBuf[i];
    const rms = Math.sqrt(sum / this.timeBuf.length);
    const level = Math.min(1, Math.max(0, (rms - 0.008) * 9));
    this.level = level;

    an.getByteFrequencyData(this.freqBuf);
    const hz = this.audioCtx.sampleRate / an.fftSize;
    const band = (a, b) => {
      let s = 0;
      const i0 = Math.floor(a / hz), i1 = Math.min(this.freqBuf.length - 1, Math.ceil(b / hz));
      for (let i = i0; i <= i1; i++) s += this.freqBuf[i];
      return s / Math.max(1, i1 - i0 + 1);
    };
    const low = band(250, 900), mid = band(900, 2200), high = band(2200, 5000);
    const tot = low + mid + high + 1e-3;
    const rl = low / tot, rm = mid / tot, rh = high / tot;
    const c = (v) => Math.min(1, Math.max(0, v));
    const v = this.visemes;
    v.aa = level * c((rl - 0.25) * 2.2);
    v.oh = level * c((rl - rh - 0.15) * 1.6) * 0.6;
    v.ee = level * c((rh - 0.22) * 3) * 0.8;
    v.ih = level * c((rm - 0.3) * 2.5) * 0.6;
    v.ou = level * c((0.3 - rh) * 1.5) * 0.35;
    // garante que a boca abre mesmo quando a análise é ambígua
    const total = v.aa + v.oh + v.ee + v.ih + v.ou;
    if (total < level * 0.5) v.aa += level * 0.5 - total;
  }
}

// Emoção aproximada pelo texto que ela está falando
export function guessEmotion(text) {
  const t = text.toLowerCase();
  if (/(haha|hehe|kkk|rsrs|hahaha)/.test(t)) return 'laugh';
  if (/(nossa|uau|caramba|sério\?|não acredito|que loucura|meu deus)/.test(t)) return 'surprised';
  if (/(que pena|sinto muito|triste|poxa|que chato|lamento)/.test(t)) return 'sad';
  if (/(adoro|amei|que legal|incrível|perfeito|que bom|massa|maravilh|feliz|demais)/.test(t)) return 'happy';
  if (/\?\s*$/.test(t)) return 'curious';
  if (/!\s*$/.test(t)) return 'happy';
  return null;
}
