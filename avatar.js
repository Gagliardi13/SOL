// Corpo da Sol: modelo VRM + animações gravadas (Mixamo) misturadas suavemente,
// com olhar, piscadas, boca e expressões calculados por cima.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { Animator } from './anim.js';

// ---------- utilidades ----------
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const damp = (a, b, k, dt) => a + (b - a) * (1 - Math.exp(-k * dt));
const rand = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
function angleDiff(a, b) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}
const noise = (t, s = 0) =>
  Math.sin(t * 0.73 + s) * 0.5 + Math.sin(t * 1.37 + s * 1.7) * 0.3 + Math.sin(t * 2.11 + s * 2.3) * 0.2;

export async function loadAvatar(url, clips, onProgress = () => {}) {
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));
  const gltf = await loader.loadAsync(url, (e) => {
    if (e.total) onProgress(e.loaded / e.total);
  });
  const vrm = gltf.userData.vrm;
  if (!vrm) throw new Error('O arquivo não é um modelo VRM válido.');
  VRMUtils.removeUnnecessaryVertices(gltf.scene);
  VRMUtils.combineSkeletons(gltf.scene);
  VRMUtils.rotateVRM0(vrm);
  vrm.scene.traverse((o) => {
    o.frustumCulled = false;
    // sombreamento um pouco mais "volumétrico" (menos cara de adesivo), sem perder o estilo
    const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
    for (const m of mats) {
      if (m.isMToonMaterial && !/FACE|EYE/i.test(m.name)) {
        m.shadingToonyFactor = 0.55;
        m.giEqualizationFactor = 0.6;
      }
    }
  });
  return new Avatar(vrm, clips);
}

// Expressão do rosto para cada emoção
const FACE = {
  neutra: { relaxed: 0.15 },
  feliz: { happy: 0.7 },
  risada: { happy: 1 },
  surpresa: { surprised: 0.85 },
  espanto: { surprised: 1 },
  triste: { sad: 0.85 },
  curiosa: { surprised: 0.25, relaxed: 0.25 },
  pensativa: { relaxed: 0.35 },
  empolgada: { happy: 0.75, surprised: 0.25 },
  vergonha: { happy: 0.4, sad: 0.2 },
  irritada: { angry: 0.65 },
  carinho: { relaxed: 0.55, happy: 0.35 },
};
// Gesto do corpo para cada pedido
const GESTURE = {
  sim: [['ouvindo_aceno', { maxDur: 2.4 }], ['emo_concordando', { maxDur: 2.8, start: 0.3 }]],
  nao: [['emo_negando', { maxDur: 1.8 }]],
  ombros: [['emo_ombros', { maxDur: 2.0 }]],
  surpresa: [['emo_surpresa', { maxDur: 2.2, start: 0.2 }]],
  risada: [['emo_risada', { maxDur: 3.6, start: 0.4 }]],
  animada: [['emo_animada', { maxDur: 3.2, start: 0.3 }]],
  acenar: [['mov_aceno_mao', { loops: 5, maxDur: 2.6, fadeIn: 0.25 }]],
};
const IDLES = ['idle_respira', 'idle_calma', 'idle_peso'];
const TALKS = ['fala_1', 'fala_2', 'fala_3', 'fala_explicando'];
const MOODS = ['happy', 'surprised', 'sad', 'relaxed', 'angry'];

export class Avatar {
  constructor(vrm, clips) {
    this.vrm = vrm;
    this.anim = new Animator(clips);
    this.root = new THREE.Group();
    this.root.add(vrm.scene);
    this.bone = (n) => vrm.humanoid.getNormalizedBoneNode(n);
    this.hipsRest = this.bone('hips').position.clone();
    this.H = this.hipsRest.y;

    this.lookTarget = new THREE.Object3D();
    vrm.lookAt.target = this.lookTarget;
    vrm.lookAt.autoUpdate = true;

    // sombras: uma larga e suave + duas de contato nos pés
    this.shadow = blob(0.9, 0.7, 0.45);
    this.footL = blob(0.22, 0.32, 0.55);
    this.footR = blob(0.22, 0.32, 0.55);
    this.root.add(this.shadow, this.footL, this.footR);

    this.mode = 'idle';
    this.t = 0;
    this.baseTimer = 0;
    this.blink = { next: rand(1, 3), phase: -1 };
    this.mouth = { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 };
    this.face = { happy: 0, surprised: 0, sad: 0, relaxed: 0.15, angry: 0 };
    this.faceTarget = { ...this.face };
    this.emotion = 'neutra';
    this.emotionTimer = 0;
    this.lastGesture = -10;
    this.gaze = 0; // 0 = olhando para você, 1 = desviado (pensando)
    this.gazeDown = 0;
    this.tilt = 0; this.tiltTarget = 0;
    this.saccade = new THREE.Vector3(); this.saccadeTimer = 0;
    this.yaw = 0; this.turning = false;
    this.walkTarget = null;
    this.lean = 0;

    this._v1 = new THREE.Vector3(); this._v2 = new THREE.Vector3(); this._v3 = new THREE.Vector3();
    this._q1 = new THREE.Quaternion(); this._q2 = new THREE.Quaternion(); this._e = new THREE.Euler(0, 0, 0, 'YXZ');

    this.anim.setBase('idle_respira', { fade: 0.01 });
  }

  // ---------- comandos ----------
  setMode(mode) {
    if (mode === this.mode) return;
    this.mode = mode;
    this.baseTimer = 0; // escolhe a animação de base já no próximo quadro
    if (mode === 'thinking') this.tiltTarget = rand(-0.1, 0.1);
    if (mode === 'listening') this.tiltTarget = rand(-0.06, 0.06);
  }

  // emoção vinda da conversa: rosto + (às vezes) gesto do corpo
  react({ emocao = 'neutra', intensidade = 0.6, gesto = 'nenhum' } = {}, { listening = false } = {}) {
    const f = FACE[emocao] || FACE.neutra;
    const k = clamp(intensidade, 0.2, 1) * (listening ? 0.8 : 1);
    for (const m of MOODS) this.faceTarget[m] = (f[m] || 0) * k;
    this.emotion = emocao;
    this.emotionTimer = 4 + k * 3;
    this.tiltTarget = emocao === 'curiosa' ? rand(0.1, 0.16) * (Math.random() < 0.5 ? -1 : 1) : this.tiltTarget * 0.5;
    if (emocao === 'triste' && k > 0.45) this.baseTimer = 0;
    const g = GESTURE[gesto];
    const since = this.t - this.lastGesture;
    if (g && !this.walkTarget && (since > 3 || (k > 0.8 && since > 1.5))) {
      const [name, opts] = pick(g);
      if (this.anim.gesture(name, opts)) this.lastGesture = this.t;
    }
  }

  nodOnce() {
    if (this.t - this.lastGesture > 2 && Math.random() < 0.6) {
      this.anim.gesture('ouvindo_aceno', { maxDur: 1.6, fadeIn: 0.3, fadeOut: 0.5 });
      this.lastGesture = this.t;
    }
  }

  greet() {
    this.react({ emocao: 'feliz', intensidade: 0.8, gesto: 'acenar' });
  }

  placeAt(position, cameraPos) {
    this.root.position.copy(position);
    this.yaw = Math.atan2(cameraPos.x - position.x, cameraPos.z - position.z);
    this.root.rotation.set(0, this.yaw, 0);
    this.root.visible = true;
    this.walkTarget = null;
    this.anim.setWalk(0);
  }

  walkTo(point) {
    this.walkTarget = point.clone();
    this.walkTarget.y = this.root.position.y; // anda no mesmo plano em que está
    this.anim.stopGesture();
  }

  get walking() { return !!this.walkTarget; }

  // ---------- quadro a quadro ----------
  update(dt, cameraPos, voice) {
    dt = Math.min(dt, 0.1);
    this.t += dt;
    const level = voice ? voice.level : 0;
    const speaking = this.mode === 'speaking';

    this._moveRoot(dt, cameraPos);
    this._chooseBase(dt);

    // 1) corpo: animações gravadas
    const pose = this.anim.update(dt);
    for (const [b, q] of pose.map) {
      const n = this.bone(b);
      if (n) n.quaternion.copy(q);
    }
    const hips = this.bone('hips');
    hips.position.set(this.hipsRest.x + pose.hips.x * this.H, pose.hips.y * this.H, this.hipsRest.z + pose.hips.z * this.H);

    // 2) camadas calculadas por cima
    const camLocal = this.root.worldToLocal(this._v1.copy(cameraPos));
    const dist = Math.hypot(camLocal.x, camLocal.z);
    this.lean = damp(this.lean, dist < 0.55 ? -0.07 : 0, 3, dt);
    const spine = this.bone('spine');
    spine.quaternion.multiply(this._q1.setFromEuler(this._e.set(this.lean, 0, 0)));
    const chest = this.bone('chest');
    const breath = Math.sin(this.t * (Math.PI * 2) / (speaking ? 3.4 : 4.4));
    chest.quaternion.multiply(this._q1.setFromEuler(this._e.set(breath * 0.012, 0, 0)));

    this._look(dt, cameraPos, speaking);
    this._face(dt, voice, speaking, level);
    this._shadows();

    this.vrm.update(dt);
  }

  _moveRoot(dt, cameraPos) {
    const pos = this.root.position;
    if (this.walkTarget) {
      const dx = this.walkTarget.x - pos.x, dz = this.walkTarget.z - pos.z;
      const d = Math.hypot(dx, dz);
      if (d < 0.12) {
        this.walkTarget = null;
        this.anim.setWalk(0);
      } else {
        const want = Math.atan2(dx, dz);
        const diff = angleDiff(this.yaw, want);
        this.yaw += Math.sign(diff) * Math.min(Math.abs(diff), 3.2 * dt);
        const facing = Math.abs(diff) < 0.6;
        this.anim.setWalk(1, 0.8);
        if (facing) {
          const sp = Math.min(d, 0.95 * dt * clamp(d / 0.4, 0.4, 1));
          pos.x += (dx / d) * sp;
          pos.z += (dz / d) * sp;
        }
      }
      this.turning = false;
    } else {
      // vira o corpo para você quando você dá a volta nela
      const want = Math.atan2(cameraPos.x - pos.x, cameraPos.z - pos.z);
      const diff = angleDiff(this.yaw, want);
      if (!this.turning && Math.abs(diff) > 0.75) this.turning = true;
      if (this.turning) {
        this.yaw += Math.sign(diff) * Math.min(Math.abs(diff), 1.9 * dt);
        this.anim.setWalk(0.55, 0.7);
        if (Math.abs(diff) < 0.1) { this.turning = false; this.anim.setWalk(0); }
      }
    }
    this.root.rotation.y = this.yaw;
  }

  _chooseBase(dt) {
    this.baseTimer -= dt;
    if (this.baseTimer > 0) return;
    const sad = this.face.sad > 0.4 || this.faceTarget.sad > 0.4;
    if (sad && this.anim.has('emo_triste')) {
      this.anim.setBase('emo_triste', { fade: 1.0 });
      this.baseTimer = rand(3, 5);
    } else if (this.mode === 'speaking') {
      const next = pick(TALKS.filter((n) => n !== this.anim.baseName && this.anim.has(n)));
      this.anim.setBase(next || 'idle_respira', { fade: 0.9, randomStart: true });
      this.baseTimer = rand(5, 9);
    } else if (this.mode === 'listening') {
      this.anim.setBase(pick(['idle_respira', 'idle_peso']), { fade: 1.0 });
      this.baseTimer = rand(6, 10);
    } else if (this.mode === 'thinking') {
      this.anim.setBase('idle_calma', { fade: 0.9 });
      this.baseTimer = rand(4, 6);
    } else {
      const happy = this.face.happy > 0.45 && this.anim.has('idle_feliz');
      const options = happy ? ['idle_feliz', ...IDLES] : IDLES;
      this.anim.setBase(pick(options.filter((n) => n !== this.anim.baseName)), { fade: 1.2, randomStart: true });
      this.baseTimer = rand(8, 14);
    }
  }

  _look(dt, cameraPos, speaking) {
    const neck = this.bone('neck');
    const head = this.bone('head');
    const parent = neck.parent;
    parent.updateWorldMatrix(true, false);
    head.getWorldPosition(this._v2);
    const dir = this._v3.copy(cameraPos).sub(this._v2);
    parent.getWorldQuaternion(this._q2).invert();
    dir.applyQuaternion(this._q2);

    this.gaze = damp(this.gaze, this.mode === 'thinking' ? 1 : 0, 2.5, dt);
    const shy = this.emotion === 'vergonha' || this.emotion === 'triste' ? 1 : 0;
    this.gazeDown = damp(this.gazeDown, shy && this.emotionTimer > 0 ? 1 : 0, 2, dt);
    let yaw = clamp(Math.atan2(dir.x, dir.z), -1.2, 1.2) + this.gaze * 0.35;
    let pitch = clamp(-Math.atan2(dir.y, Math.hypot(dir.x, dir.z)), -0.5, 0.45) - this.gaze * 0.22 + this.gazeDown * 0.25;
    this.tilt = damp(this.tilt, this.tiltTarget, 2, dt);

    // o quanto o olhar "manda" sobre a animação (um pouco de liberdade deixa mais vivo)
    const w = this.walkTarget ? 0.35 : speaking ? 0.7 : 0.85;
    this._q1.setFromEuler(this._e.set(pitch * 0.4, yaw * 0.4, 0));
    neck.quaternion.slerp(this._q1, w);
    this._q1.setFromEuler(this._e.set(pitch * 0.6, yaw * 0.6, this.tilt));
    head.quaternion.slerp(this._q1, w);

    // olhos: micro-movimentos (sacadas)
    this.saccadeTimer -= dt;
    if (this.saccadeTimer <= 0) {
      this.saccade.set(rand(-0.03, 0.03), rand(-0.02, 0.02), 0);
      this.saccadeTimer = rand(0.4, 2.0);
    }
    this.lookTarget.position.copy(cameraPos).add(this.saccade);
    if (this.gaze > 0.3) this.lookTarget.position.add(this._v1.set(0.3 * this.gaze, 0.22 * this.gaze, 0));
    if (this.gazeDown > 0.3) this.lookTarget.position.y -= 0.35 * this.gazeDown;
    this.lookTarget.updateMatrixWorld(true);
  }

  _face(dt, voice, speaking, level) {
    const em = this.vrm.expressionManager;
    // emoção some aos poucos
    if (this.emotionTimer > 0) {
      this.emotionTimer -= dt;
      if (this.emotionTimer <= 0) {
        this.faceTarget = { happy: 0.08, surprised: 0, sad: 0, relaxed: 0.15, angry: 0 };
        this.emotion = 'neutra';
        this.tiltTarget *= 0.3;
      }
    }
    for (const m of MOODS) this.face[m] = damp(this.face[m], this.faceTarget[m], 4, dt);

    // piscar (mais rápido ao falar; às vezes duas vezes)
    this.blink.next -= dt;
    if (this.blink.next <= 0 && this.blink.phase < 0) this.blink.phase = 0;
    let blinkW = 0;
    if (this.blink.phase >= 0) {
      this.blink.phase += dt / 0.15;
      blinkW = Math.sin(clamp(this.blink.phase) * Math.PI);
      if (this.blink.phase >= 1) {
        this.blink.phase = -1;
        this.blink.next = Math.random() < 0.15 ? 0.22 : rand(speaking ? 1.8 : 2.5, 5.5);
      }
    }
    // surpresa arregala os olhos (pisca menos)
    em.setValue('blink', blinkW * (1 - this.face.surprised * 0.6));

    const target = voice && speaking ? voice.visemes : null;
    for (const k of ['aa', 'ih', 'ou', 'ee', 'oh']) {
      this.mouth[k] = damp(this.mouth[k], target ? target[k] || 0 : 0, 20, dt);
      em.setValue(k, this.mouth[k]);
    }
    // emoções mais contidas enquanto fala (senão a boca "trava")
    const cap = speaking ? 0.6 : 1;
    for (const m of MOODS) em.setValue(m, Math.min(cap, this.face[m]));
  }

  _shadows() {
    const lf = this.bone('leftFoot'), rf = this.bone('rightFoot');
    for (const [foot, s] of [[lf, this.footL], [rf, this.footR]]) {
      foot.getWorldPosition(this._v1);
      this.root.worldToLocal(this._v1);
      s.position.set(this._v1.x, 0.004, this._v1.z + 0.03);
      s.material.opacity = clamp(1 - this._v1.y * 6, 0.15, 1); // pé no ar → sombra mais fraca
    }
    this.bone('hips').getWorldPosition(this._v1);
    this.root.worldToLocal(this._v1);
    this.shadow.position.set(this._v1.x, 0.003, this._v1.z);
  }
}

function blob(w, h, alpha) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(64, 64, 2, 64, 64, 64);
  grd.addColorStop(0, `rgba(0,0,0,${alpha})`);
  grd.addColorStop(0.45, `rgba(0,0,0,${alpha * 0.5})`);
  grd.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(w, h),
    new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false })
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.renderOrder = -1;
  return mesh;
}
