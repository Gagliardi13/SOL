// Animações gravadas (Mixamo, já convertidas para o esqueleto VRM) e mistura suave entre elas.
import * as THREE from 'three';

export async function loadClips(jsonUrl, binUrl) {
  const [index, bin] = await Promise.all([
    fetch(jsonUrl).then((r) => { if (!r.ok) throw new Error('animacoes.json não encontrado'); return r.json(); }),
    fetch(binUrl).then((r) => { if (!r.ok) throw new Error('animacoes.bin não encontrado'); return r.arrayBuffer(); }),
  ]);
  const all = new Int16Array(bin);
  const clips = new Map();
  for (const c of index.clips) clips.set(c.name, new Clip(c, all.subarray(c.offset, c.offset + c.length), index.fps));
  return clips;
}

export class Clip {
  constructor(meta, data, fps) {
    this.name = meta.name;
    this.frames = meta.frames;
    this.bones = meta.bones;
    this.data = data;
    this.fps = fps;
    this.stride = this.bones.length * 4 + 3;
    this.duration = (this.frames - 1) / fps;
  }
  // escreve no "pose" os ossos desta animação no instante t
  sample(t, pose, loop = true) {
    let f = t * this.fps;
    const last = this.frames - 1;
    if (loop) f = ((f % last) + last) % last;
    else f = Math.min(Math.max(f, 0), last);
    const i0 = Math.floor(f), i1 = Math.min(i0 + 1, last), a = f - i0;
    const d = this.data, s = this.stride, o0 = i0 * s, o1 = i1 * s;
    for (let b = 0; b < this.bones.length; b++) {
      const k0 = o0 + b * 4, k1 = o1 + b * 4;
      const q = pose.q(this.bones[b]);
      q.set(
        d[k0] + (d[k1] - d[k0]) * a,
        d[k0 + 1] + (d[k1 + 1] - d[k0 + 1]) * a,
        d[k0 + 2] + (d[k1 + 2] - d[k0 + 2]) * a,
        d[k0 + 3] + (d[k1 + 3] - d[k0 + 3]) * a
      ).normalize();
    }
    const h0 = o0 + this.bones.length * 4, h1 = o1 + this.bones.length * 4;
    pose.hips.set(
      (d[h0] + (d[h1] - d[h0]) * a) / 10000,
      (d[h0 + 1] + (d[h1 + 1] - d[h0 + 1]) * a) / 10000,
      (d[h0 + 2] + (d[h1 + 2] - d[h0 + 2]) * a) / 10000
    );
    return pose;
  }
}

export class Pose {
  constructor() {
    this.map = new Map();
    this.hips = new THREE.Vector3(0, 1, 0);
  }
  q(bone) {
    let q = this.map.get(bone);
    if (!q) this.map.set(bone, (q = new THREE.Quaternion()));
    return q;
  }
  reset() {
    for (const q of this.map.values()) q.identity();
    this.hips.set(0, 1, 0);
  }
  // mistura: this = this ⟶ other, com peso w (0..1)
  blend(other, w) {
    if (w <= 0) return this;
    for (const [bone, q] of other.map) {
      const mine = this.q(bone);
      if (w >= 1) mine.copy(q);
      else mine.slerp(q, w);
    }
    this.hips.lerp(other.hips, Math.min(1, w));
    return this;
  }
}

// Uma "faixa" toca uma animação e faz a transição para a próxima
class Track {
  constructor() {
    this.cur = null; this.curT = 0; this.curLoop = true;
    this.prev = null; this.prevT = 0; this.prevLoop = true;
    this.fade = 1; this.fadeDur = 0.6;
    this.speed = 1;
    this.poseA = new Pose(); this.poseB = new Pose();
  }
  play(clip, { fade = 0.6, loop = true, start = 0 } = {}) {
    if (clip === this.cur) return;
    this.prev = this.cur; this.prevT = this.curT; this.prevLoop = this.curLoop;
    this.cur = clip; this.curT = start; this.curLoop = loop;
    this.fade = this.prev ? 0 : 1; this.fadeDur = fade;
  }
  update(dt) {
    if (this.cur) this.curT += dt * this.speed;
    if (this.prev) this.prevT += dt * this.speed;
    if (this.fade < 1) this.fade = Math.min(1, this.fade + dt / this.fadeDur);
    if (this.fade >= 1) this.prev = null;
  }
  get timeLeft() { return this.cur && !this.curLoop ? this.cur.duration - this.curT : Infinity; }
  // devolve a pose desta faixa
  sample(out) {
    out.reset();
    if (this.prev) { this.prev.sample(this.prevT, this.poseA, this.prevLoop); out.blend(this.poseA, 1); }
    if (this.cur) {
      this.cur.sample(this.curT, this.poseB, this.curLoop);
      out.blend(this.poseB, this.prev ? smooth(this.fade) : 1);
    }
    return out;
  }
}
const smooth = (x) => x * x * (3 - 2 * x);

// Junta tudo: base (parada/falando/ouvindo) + gesto pontual + andar
export class Animator {
  constructor(clips) {
    this.clips = clips;
    this.base = new Track();
    this.action = new Track();
    this.actionW = 0; this.actionTarget = 0; this.actionEnd = Infinity;
    this.walk = new Track();
    this.walkW = 0; this.walkTarget = 0;
    this.out = new Pose(); this.tmp = new Pose();
    if (clips.get('mov_andando')) this.walk.play(clips.get('mov_andando'), { fade: 0.01 });
  }
  has(name) { return this.clips.has(name); }
  setBase(name, { fade = 0.8, randomStart = false } = {}) {
    const c = this.clips.get(name);
    if (!c || c === this.base.cur) return;
    this.base.play(c, { fade, loop: true, start: randomStart ? Math.random() * c.duration : 0 });
  }
  get baseName() { return this.base.cur ? this.base.cur.name : ''; }
  // gesto pontual (ex.: surpresa, risada); maxDur corta animações longas
  gesture(name, { maxDur = 4, fadeIn = 0.35, fadeOut = 0.6, start = 0, loops = 1 } = {}) {
    const c = this.clips.get(name);
    if (!c) return false;
    const loop = loops > 1;
    const a = this.action;
    if (this.actionW > 0.05 && a.cur !== c) {
      a.play(c, { fade: 0.35, loop, start }); // troca de gesto no meio de outro: transição suave
    } else {
      a.prev = null; a.cur = c; a.curT = start; a.curLoop = loop; a.fade = 1;
    }
    this.actionTarget = 1; this.fadeIn = fadeIn; this.fadeOut = fadeOut;
    this.actionEnd = Math.min(maxDur, loop ? c.duration * loops : c.duration - start);
    this.actionClock = 0;
    return true;
  }
  get busy() { return this.actionTarget > 0; }
  stopGesture() { this.actionTarget = 0; }
  setWalk(w, speed = 1) { this.walkTarget = w; this.walk.speed = speed; }

  update(dt) {
    this.base.update(dt);
    this.action.update(dt);
    this.walk.update(dt);
    if (this.actionTarget > 0) {
      this.actionClock += dt;
      if (this.actionClock > this.actionEnd - this.fadeOut) this.actionTarget = 0;
    }
    const k = this.actionTarget > this.actionW ? 1 / this.fadeIn : 1 / this.fadeOut;
    this.actionW += Math.sign(this.actionTarget - this.actionW) * Math.min(Math.abs(this.actionTarget - this.actionW), dt * k);
    this.walkW += Math.sign(this.walkTarget - this.walkW) * Math.min(Math.abs(this.walkTarget - this.walkW), dt * 3);

    const out = this.base.sample(this.out);
    if (this.actionW > 0.001) out.blend(this.action.sample(this.tmp), smooth(this.actionW));
    if (this.walkW > 0.001) out.blend(this.walk.sample(this.tmp), smooth(this.walkW));
    return out;
  }
}
