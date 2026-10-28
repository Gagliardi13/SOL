// Corpo da Sol: carrega o modelo VRM e anima tudo de forma procedural
// (respiração, olhar, piscadas, boca, gestos, emoções, virar o corpo).
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';

// ---------- utilidades ----------
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const lerp = (a, b, k) => a + (b - a) * k;
// suavização independente do FPS (k = "velocidade" por segundo)
const damp = (a, b, k, dt) => lerp(a, b, 1 - Math.exp(-k * dt));
const rand = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
function angleDiff(a, b) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}
// ruído suave barato (soma de senos) para micro-movimentos
const noise = (t, s = 0) =>
  Math.sin(t * 0.73 + s) * 0.5 + Math.sin(t * 1.37 + s * 1.7) * 0.3 + Math.sin(t * 2.11 + s * 2.3) * 0.2;

export async function loadAvatar(url, onProgress = () => {}) {
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));
  const gltf = await loader.loadAsync(url, (e) => {
    if (e.total) onProgress(e.loaded / e.total);
  });
  const vrm = gltf.userData.vrm;
  if (!vrm) throw new Error('O arquivo não é um modelo VRM válido.');
  VRMUtils.removeUnnecessaryVertices(gltf.scene);
  VRMUtils.combineSkeletons(gltf.scene);
  VRMUtils.rotateVRM0(vrm); // modelos VRM 0.x olham para o lado errado; corrige
  vrm.scene.traverse((o) => {
    o.frustumCulled = false;
  });
  return new Avatar(vrm);
}

// Poses de gesto, descritas para um braço genérico:
// raise = abre o braço para o lado, fwd = leva o braço à frente,
// bend = dobra o cotovelo, twist = gira o antebraço (palma).
const REST = { raise: 0, fwd: 0.05, bend: 0.25, twist: 0 };
const GESTURES = {
  explicaD: { R: { raise: 0.15, fwd: 0.35, bend: 1.35, twist: 0.5 }, L: REST },
  explicaE: { L: { raise: 0.15, fwd: 0.35, bend: 1.35, twist: 0.5 }, R: REST },
  abreDuas: {
    R: { raise: 0.2, fwd: 0.35, bend: 1.15, twist: 0.7 },
    L: { raise: 0.2, fwd: 0.35, bend: 1.15, twist: 0.7 },
  },
  ombros: {
    R: { raise: 0.25, fwd: 0.2, bend: 0.95, twist: 0.9 },
    L: { raise: 0.25, fwd: 0.2, bend: 0.95, twist: 0.9 },
    ombro: 0.12,
  },
  apontaSi: { R: { raise: -0.1, fwd: 0.55, bend: 1.9, twist: 0.2 }, L: REST },
  baixaD: { R: { raise: 0.1, fwd: 0.25, bend: 0.85, twist: 0.3 }, L: REST },
  baixaE: { L: { raise: 0.1, fwd: 0.25, bend: 0.85, twist: 0.3 }, R: REST },
};
const THINK = { R: { raise: -0.05, fwd: 0.75, bend: 2.25, twist: 0.1 }, L: { raise: 0, fwd: 0.35, bend: 1.4, twist: -0.2 } };
const SURPRISE = { R: { raise: 0.12, fwd: 0.45, bend: 1.7, twist: 0.4 }, L: { raise: 0.12, fwd: 0.45, bend: 1.7, twist: 0.4 } };

export class Avatar {
  constructor(vrm) {
    this.vrm = vrm;
    this.root = new THREE.Group(); // ponto no chão onde ela está
    this.root.add(vrm.scene);
    this.bone = (n) => vrm.humanoid.getNormalizedBoneNode(n);
    // ordem das rotações: cabeça vira e depois inclina; antebraço gira no próprio eixo e depois dobra
    for (const n of ['head', 'neck', 'leftLowerArm', 'rightLowerArm']) {
      const b = this.bone(n);
      if (b) b.rotation.order = 'YXZ';
    }

    // alvo do olhar (os olhos seguem este objeto)
    this.lookTarget = new THREE.Object3D();
    vrm.lookAt.target = this.lookTarget;
    vrm.lookAt.autoUpdate = true;

    // sombra suave no chão (barata e convincente)
    this.shadow = makeBlobShadow();
    this.root.add(this.shadow);

    // estado
    this.mode = 'idle'; // idle | listening | thinking | speaking
    this.t = 0;
    this.blink = { next: rand(1, 3), phase: -1 };
    this.mouth = { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 };
    this.mood = { happy: 0, surprised: 0, sad: 0, relaxed: 0.15, angry: 0 };
    this.moodTarget = { happy: 0.1, surprised: 0, sad: 0, relaxed: 0.2, angry: 0 };
    this.excite = 0.4; // energia dos gestos
    this.arms = { R: { ...REST }, L: { ...REST } };
    this.armTarget = { R: REST, L: REST };
    this.shoulderLift = 0;
    this.shoulderTarget = 0;
    this.gestureTimer = 0;
    this.nod = 0; // aceno de cabeça (0..1 decaindo)
    this.headTilt = 0;
    this.headTiltTarget = 0;
    this.saccade = new THREE.Vector3();
    this.saccadeTimer = 0;
    this.gazeAway = 0; // desvia o olhar ao pensar
    this.yaw = 0;
    this.turning = false;
    this.turnPhase = 0;
    this.lean = 0;

    this.hipsRest = this.bone('hips').position.clone();
    this._v1 = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
  }

  setMode(mode) {
    if (mode === this.mode) return;
    const prev = this.mode;
    this.mode = mode;
    if (mode === 'listening') {
      this.headTiltTarget = rand(-0.08, 0.08);
      this.armTarget = { R: REST, L: REST };
    }
    if (mode === 'thinking') {
      this.gazeAway = 1;
      if (Math.random() < 0.45) this.armTarget = THINK;
    }
    if (mode === 'speaking') {
      this.gazeAway = 0;
      this.gestureTimer = rand(0.2, 0.6);
    }
    if (mode === 'idle' && prev === 'speaking') {
      this.armTarget = { R: REST, L: REST };
      this.shoulderTarget = 0;
    }
  }

  // aceno curto, ex.: quando você termina de falar
  nodOnce() {
    this.nod = 1;
  }

  // emoções vindas da fala dela
  feel(emotion, strength = 0.6) {
    const m = this.moodTarget;
    for (const k of Object.keys(m)) m[k] *= 0.4;
    if (emotion === 'happy') {
      m.happy = strength;
      this.excite = 0.8;
    } else if (emotion === 'laugh') {
      m.happy = 0.75;
      this.excite = 1;
      this.shoulderTarget = 0.08;
    } else if (emotion === 'surprised') {
      m.surprised = strength;
      this.excite = 0.9;
      if (this.mode === 'speaking') this.armTarget = SURPRISE;
    } else if (emotion === 'sad') {
      m.sad = strength * 0.8;
      this.excite = 0.2;
    } else if (emotion === 'curious') {
      m.relaxed = 0.3;
      this.headTiltTarget = rand(0.08, 0.14) * (Math.random() < 0.5 ? -1 : 1);
      this.excite = 0.5;
    } else {
      m.relaxed = 0.25;
      m.happy = 0.1;
      this.excite = 0.45;
    }
    this.moodDecay = 4; // segundos até voltar ao neutro
  }

  // coloca a Sol num ponto do chão, já de frente para a câmera
  placeAt(position, cameraPos) {
    this.root.position.copy(position);
    this.yaw = Math.atan2(cameraPos.x - position.x, cameraPos.z - position.z);
    this.root.rotation.set(0, this.yaw, 0);
    this.root.visible = true;
  }

  update(dt, cameraPos, voice) {
    dt = Math.min(dt, 0.1);
    this.t += dt;
    const t = this.t;
    const level = voice ? voice.level : 0;
    const speaking = this.mode === 'speaking';

    // ---------- virar o corpo para você ----------
    const want = Math.atan2(cameraPos.x - this.root.position.x, cameraPos.z - this.root.position.z);
    const diff = angleDiff(this.yaw, want);
    if (!this.turning && Math.abs(diff) > 0.6) this.turning = true;
    if (this.turning) {
      const step = Math.sign(diff) * Math.min(Math.abs(diff), 1.7 * dt);
      this.yaw += step;
      this.turnPhase += dt * 7;
      if (Math.abs(diff) < 0.08) this.turning = false;
    } else {
      this.turnPhase = damp(this.turnPhase, Math.round(this.turnPhase / Math.PI) * Math.PI, 6, dt);
    }
    this.root.rotation.y = this.yaw;

    // posição da câmera no espaço local dela
    const camLocal = this.root.worldToLocal(this._v1.copy(cameraPos));
    const dist = Math.hypot(camLocal.x, camLocal.z);

    // ---------- humor (decai devagar para o neutro) ----------
    if (this.moodDecay > 0) {
      this.moodDecay -= dt;
      if (this.moodDecay <= 0) {
        this.moodTarget = { happy: 0.1, surprised: 0, sad: 0, relaxed: 0.2, angry: 0 };
        this.excite = 0.45;
      }
    }
    for (const k of Object.keys(this.mood)) this.mood[k] = damp(this.mood[k], this.moodTarget[k], 3, dt);

    // ---------- gestos ----------
    if (speaking) {
      this.gestureTimer -= dt;
      if (this.gestureTimer <= 0) {
        const energy = clamp(this.excite * 0.7 + level * 0.6);
        if (Math.random() < 0.25 + energy * 0.6) {
          const options = energy > 0.65
            ? ['abreDuas', 'explicaD', 'explicaE', 'ombros', 'apontaSi', 'explicaD']
            : ['explicaD', 'explicaE', 'baixaD', 'baixaE', 'apontaSi'];
          this.armTarget = GESTURES[pick(options)];
          this.shoulderTarget = this.armTarget.ombro || 0;
        } else {
          this.armTarget = { R: REST, L: REST };
          this.shoulderTarget = 0;
        }
        this.gestureTimer = rand(0.9, 2.2) / (0.6 + energy * 0.6);
      }
    } else if (this.mode !== 'thinking') {
      this.armTarget = this.armTarget === THINK ? { R: REST, L: REST } : this.armTarget;
    }
    const armSpeed = speaking ? 5 : 3;
    for (const side of ['R', 'L']) {
      const cur = this.arms[side];
      const tgt = this.armTarget[side] || REST;
      for (const k of ['raise', 'fwd', 'bend', 'twist']) cur[k] = damp(cur[k], tgt[k], armSpeed, dt);
    }
    this.shoulderLift = damp(this.shoulderLift, this.shoulderTarget, 5, dt);

    // ---------- corpo ----------
    const breath = Math.sin(t * (Math.PI * 2) / (speaking ? 3.2 : 4.2));
    const hips = this.bone('hips');
    hips.position.set(
      this.hipsRest.x + noise(t * 0.4, 1) * 0.012,
      this.hipsRest.y + Math.abs(Math.sin(this.turnPhase)) * 0.012,
      this.hipsRest.z
    );
    hips.rotation.set(0, noise(t * 0.3, 2) * 0.03, noise(t * 0.4, 3) * 0.015);

    // inclina para trás se você chegar muito perto
    this.lean = damp(this.lean, dist < 0.55 ? -0.08 : 0, 3, dt);
    const spine = this.bone('spine');
    spine.rotation.set(this.lean + noise(t * 0.5, 4) * 0.01, 0, noise(t * 0.35, 5) * 0.02);
    const chest = this.bone('chest');
    chest.rotation.set(breath * 0.018 + (this.mood.sad * 0.08), noise(t * 0.45, 6) * 0.02, 0);
    const upper = this.bone('upperChest');
    if (upper) upper.rotation.set(breath * 0.012, 0, 0);

    // pernas: passinhos quando está virando
    const step = Math.sin(this.turnPhase) * (this.turning ? 0.18 : 0);
    this.bone('leftUpperLeg').rotation.set(-Math.max(0, step), 0, 0);
    this.bone('rightUpperLeg').rotation.set(-Math.max(0, -step), 0, 0);
    this.bone('leftLowerLeg').rotation.set(Math.max(0, step) * 1.6, 0, 0);
    this.bone('rightLowerLeg').rotation.set(Math.max(0, -step) * 1.6, 0, 0);

    // ombros
    const sh = this.shoulderLift + breath * 0.01;
    this.bone('leftShoulder').rotation.set(0, 0, sh);
    this.bone('rightShoulder').rotation.set(0, 0, -sh);

    // braços (com "batida" acompanhando a voz)
    const beat = speaking ? level * 0.18 : 0;
    this._applyArm('L', this.arms.L, t, beat);
    this._applyArm('R', this.arms.R, t, beat);

    // ---------- cabeça e olhar ----------
    const head = this.bone('head');
    const neck = this.bone('neck');
    head.getWorldPosition(this._v2);
    const headLocal = this.root.worldToLocal(this._v2);
    const dx = camLocal.x - headLocal.x;
    const dy = camLocal.y - headLocal.y;
    const dz = camLocal.z - headLocal.z;
    let yaw = clamp(Math.atan2(dx, dz), -1.1, 1.1);
    let pitch = clamp(-Math.atan2(dy, Math.hypot(dx, dz)), -0.5, 0.45);

    this.gazeAway = damp(this.gazeAway, this.mode === 'thinking' ? 1 : 0, 2.5, dt);
    yaw += this.gazeAway * 0.35;
    pitch += -this.gazeAway * 0.25;

    this.nod = Math.max(0, this.nod - dt * 1.6);
    const nodAngle = Math.sin((1 - this.nod) * Math.PI * 2) * this.nod * 0.12;
    this.headTilt = damp(this.headTilt, this.mode === 'listening' || this.mood.relaxed > 0.25 ? this.headTiltTarget : 0, 2, dt);
    const talkBob = speaking ? noise(t * 3, 7) * 0.04 * (0.3 + level) : 0;

    neck.rotation.set(pitch * 0.35, yaw * 0.4, 0);
    head.rotation.set(
      pitch * 0.55 + nodAngle + talkBob + noise(t * 0.6, 8) * 0.015,
      yaw * 0.6 + noise(t * 0.5, 9) * 0.02,
      this.headTilt + noise(t * 0.4, 10) * 0.02
    );

    // micro-movimentos dos olhos (sacadas)
    this.saccadeTimer -= dt;
    if (this.saccadeTimer <= 0) {
      this.saccade.set(rand(-0.03, 0.03), rand(-0.02, 0.02), 0);
      this.saccadeTimer = rand(0.4, 2.0);
    }
    this.lookTarget.position.copy(cameraPos).add(this.saccade);
    if (this.gazeAway > 0.3) this.lookTarget.position.add(this._v1.set(0.25 * this.gazeAway, 0.2 * this.gazeAway, 0));
    this.lookTarget.updateMatrixWorld(true);

    // ---------- rosto ----------
    const em = this.vrm.expressionManager;
    // piscar
    this.blink.next -= dt;
    if (this.blink.next <= 0 && this.blink.phase < 0) this.blink.phase = 0;
    let blinkW = 0;
    if (this.blink.phase >= 0) {
      this.blink.phase += dt / 0.16;
      blinkW = Math.sin(clamp(this.blink.phase) * Math.PI);
      if (this.blink.phase >= 1) {
        this.blink.phase = -1;
        this.blink.next = Math.random() < 0.15 ? 0.25 : rand(2, 5.5); // às vezes pisca duas vezes
      }
    }
    em.setValue('blink', blinkW);

    // boca: segue a voz; suavizada
    const target = voice && speaking ? voice.visemes : { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 };
    for (const k of ['aa', 'ih', 'ou', 'ee', 'oh']) {
      this.mouth[k] = damp(this.mouth[k], target[k] || 0, 18, dt);
      em.setValue(k, this.mouth[k]);
    }

    // emoções (mais contidas enquanto fala, para não travar a boca)
    const cap = speaking ? 0.5 : 0.9;
    em.setValue('happy', Math.min(cap, this.mood.happy));
    em.setValue('surprised', Math.min(cap, this.mood.surprised));
    em.setValue('sad', Math.min(cap, this.mood.sad));
    em.setValue('relaxed', Math.min(cap, this.mood.relaxed));
    em.setValue('angry', Math.min(cap, this.mood.angry));

    this.vrm.update(dt);
  }

  _applyArm(side, p, t, beat) {
    const s = side === 'L' ? 1 : -1; // espelha o lado
    const n = noise(t * 0.6, side === 'L' ? 11 : 13);
    const ua = this.bone(side === 'L' ? 'leftUpperArm' : 'rightUpperArm');
    const la = this.bone(side === 'L' ? 'leftLowerArm' : 'rightLowerArm');
    const hand = this.bone(side === 'L' ? 'leftHand' : 'rightHand');
    ua.rotation.set(-(p.fwd + n * 0.02), 0, s * (-1.22 + p.raise + n * 0.015));
    la.rotation.set(s * p.twist, -s * (p.bend + beat * (p.bend > 0.6 ? 1 : 0)), 0);
    hand.rotation.set(0, 0, s * (-0.12 + n * 0.05));
    // dedos levemente curvados (mão relaxada)
    for (const f of ['Index', 'Middle', 'Ring', 'Little']) {
      const curl = 0.18 + (f === 'Little' ? 0.12 : f === 'Ring' ? 0.08 : 0);
      for (const seg of ['Proximal', 'Intermediate', 'Distal']) {
        const b = this.bone((side === 'L' ? 'left' : 'right') + f + seg);
        if (b) b.rotation.set(0, 0, -s * curl);
      }
    }
  }
}

function makeBlobShadow() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(64, 64, 4, 64, 64, 64);
  grd.addColorStop(0, 'rgba(0,0,0,0.55)');
  grd.addColorStop(0.5, 'rgba(0,0,0,0.25)');
  grd.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(0.75, 0.55),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false })
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = 0.003;
  mesh.renderOrder = -1;
  return mesh;
}
