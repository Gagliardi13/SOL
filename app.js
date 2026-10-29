// Sol: junta tudo (cena 3D, realidade aumentada, voz, emoções e interface).
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { XREstimatedLight } from 'three/addons/webxr/XREstimatedLight.js';
import { loadAvatar } from './avatar.js';
import { loadClips } from './anim.js';
import { VoiceLink, guessEmotion } from './voice.js';
import { EmotionEngine } from './emotion.js';
import { PERSONA, SAUDACAO, preencher } from './persona.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);

// Correção para celulares Android: o three.js usa por padrão o modo "WebXR Layers"
// quando o navegador anuncia suporte, mas em vários aparelhos esse modo não mostra
// nada na tela. Removendo o anúncio, ele volta ao modo clássico (XRWebGLLayer).
// Para testar o modo novo: adicione ?layers=1 ao endereço.
if (!params.has('layers') && window.XRWebGLBinding) {
  try { delete XRWebGLBinding.prototype.createProjectionLayer; } catch {}
}

// ---------- configurações salvas no aparelho ----------
const store = {
  get(k, d = '') { try { return localStorage.getItem('sol.' + k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('sol.' + k, v); } catch {} },
};
$('fWorker').value = store.get('worker');
$('fToken').value = store.get('token');
$('fName').value = store.get('name');
$('fVoice').value = store.get('voice', 'marin');
$('fFone').checked = store.get('fone', '0') === '1';

// ---------- diagnóstico na tela (o celular não tem console) ----------
const diag = { frames: 0, hits: 0, err: '', fps: 0, fpsFrames: 0, fpsT: performance.now() };
function reportError(where, e) {
  const msg = `${where}: ${e && e.message ? e.message : e}`;
  if (diag.err === msg) return;
  diag.err = msg;
  console.error(where, e);
  $('diag').textContent = 'ERRO ' + msg;
}
window.addEventListener('error', (e) => reportError('erro', e.error || e.message));
window.addEventListener('unhandledrejection', (e) => reportError('promessa', e.reason));

// ---------- cena ----------
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.xr.enabled = true;
renderer.xr.setFramebufferScaleFactor(0.85);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.05, 50);
camera.position.set(0, 1.45, 1.6);

const hemi = new THREE.HemisphereLight(0xfff4e8, 0x5a4a3c, 1.6);
const sunLight = new THREE.DirectionalLight(0xffffff, 1.6);
sunLight.position.set(0.6, 2.5, 1.5);
scene.add(hemi, sunLight);

// luz do ambiente real: a Sol fica mais clara, escura ou amarelada conforme a sua sala
const xrLight = new XREstimatedLight(renderer);
xrLight.addEventListener('estimationstart', () => {
  scene.add(xrLight);
  scene.remove(sunLight);
  hemi.intensity = 0.35; // um pouco de luz de preenchimento para nunca ficar preta
  if (xrLight.environment) scene.environment = xrLight.environment;
});
xrLight.addEventListener('estimationend', () => {
  scene.remove(xrLight);
  scene.add(sunLight);
  hemi.intensity = 1.6;
  scene.environment = null;
});

const reticle = new THREE.Mesh(
  new THREE.RingGeometry(0.12, 0.16, 40).rotateX(-Math.PI / 2),
  new THREE.MeshBasicMaterial({ color: 0xffb347, transparent: true, opacity: 0.9 })
);
reticle.matrixAutoUpdate = false;
reticle.visible = false;
scene.add(reticle);

// ---------- estado ----------
let avatar = null;
let voice = null;
let emotions = null;
let mode = 'none'; // none | ar | preview
let picking = null; // null | 'place' | 'walk'
let placedOnce = false;
let hitSource = null;
let lastHit = null;
let anchor = null, anchorPos = null;
let controls = null;
let floor = null;
let subsOn = true;
let muted = false;
let solLine = '', sentence = '', userLine = '', userPartial = '';
let pendingSolReaction = null;
let newResponse = true;
let thinkTimer = null;
const clock = new THREE.Clock();
const camPos = new THREE.Vector3();

// ---------- carregar a Sol (modelo + animações) ----------
loadClips('./animacoes.json', './animacoes.bin')
  .then((clips) => loadAvatar('./sol.vrm', clips, (p) => ($('bar').style.width = Math.round(p * 100) + '%')))
  .then((a) => {
    avatar = a;
    avatar.root.visible = false;
    scene.add(avatar.root);
    $('bar').style.width = '100%';
    setStatus('Sol pronta. Preencha os campos e conecte a voz.');
    $('btnConnect').disabled = false;
    $('btnPreview').disabled = false;
  })
  .catch((e) => setStatus('Erro ao carregar: ' + e.message, true));

function setStatus(msg, err = false) {
  $('setupStatus').textContent = msg;
  $('setupStatus').className = err ? 'err' : '';
}

// ---------- 1. conectar a voz ----------
$('btnConnect').onclick = async () => {
  const worker = $('fWorker').value.trim();
  const token = $('fToken').value.trim();
  const name = $('fName').value.trim();
  const v = $('fVoice').value;
  const fone = $('fFone').checked;
  if (!worker || !token) return setStatus('Preencha o endereço do servidor e a senha.', true);
  store.set('worker', worker); store.set('token', token); store.set('name', name); store.set('voice', v); store.set('fone', fone ? '1' : '0');

  $('btnConnect').disabled = true;
  setStatus('Pedindo acesso ao microfone…');
  try {
    const mic = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    setStatus('Conectando com a voz da Sol…');
    voice?.close();
    voice = new VoiceLink({ workerUrl: worker, appToken: token, voice: v, spatial: fone });
    wireVoice(voice);
    await voice.connect(mic);
    voice.setInstructions(preencher(PERSONA, name));
    voice.enableUserTranscript();
    voice.setMicEnabled(false); // só escuta depois que ela aparecer

    emotions = new EmotionEngine({
      workerUrl: worker,
      appToken: token,
      onReaction: onReaction,
      onError: (m) => toast(m),
    });

    setStatus('Voz conectada. Agora entre no AR (ou teste a prévia).');
    $('btnConnect').textContent = '✓ Voz conectada';
    checkAR();
  } catch (e) {
    console.error(e);
    setStatus(e.message || String(e), true);
    $('btnConnect').disabled = false;
  }
};

async function checkAR() {
  const ok = navigator.xr && (await navigator.xr.isSessionSupported('immersive-ar').catch(() => false));
  $('btnAR').disabled = !ok;
  if (!ok) $('btnAR').textContent = 'AR indisponível neste aparelho';
}

// ---------- emoções ----------
function onReaction(data, who) {
  if (!avatar) return;
  if (who === 'sol' && avatar.mode !== 'speaking') {
    pendingSolReaction = data; // o texto chega antes do áudio: espera ela começar a falar
    return;
  }
  avatar.react(data, { listening: who === 'user' });
}

function wireVoice(v) {
  v.addEventListener('user-start', () => {
    userPartial = '';
    avatar?.setMode('listening');
    setState('listening', 'Ouvindo você');
  });
  v.addEventListener('user-text-delta', (e) => {
    userPartial += e.detail;
    emotions?.analyze('user', userPartial); // reage enquanto você ainda está falando
  });
  v.addEventListener('user-stop', () => {
    avatar?.nodOnce();
    avatar?.setMode('thinking');
    setState('thinking', 'Pensando…');
    clearTimeout(thinkTimer);
    thinkTimer = setTimeout(() => {
      if (avatar?.mode === 'thinking') { avatar.setMode('idle'); setState('', 'Pode falar'); }
    }, 7000);
  });
  v.addEventListener('user-text', (e) => {
    userLine = e.detail;
    emotions?.remember('user', e.detail);
    if (e.detail && e.detail !== userPartial) emotions?.analyze('user', e.detail, { urgent: true });
    showSubs();
  });
  v.addEventListener('sol-start', () => {
    clearTimeout(thinkTimer);
    avatar?.setMode('speaking');
    setState('speaking', 'Sol falando');
    if (pendingSolReaction) { avatar?.react(pendingSolReaction); pendingSolReaction = null; }
  });
  v.addEventListener('sol-stop', () => {
    if (v.userSpeaking) { avatar?.setMode('listening'); setState('listening', 'Ouvindo você'); }
    else { avatar?.setMode('idle'); setState('', muted ? 'Microfone desligado' : 'Pode falar'); }
  });
  v.addEventListener('sol-text', (e) => {
    if (newResponse) { solLine = ''; newResponse = false; }
    solLine += e.detail;
    sentence += e.detail;
    if (/[.!?…]\s*$/.test(sentence) || sentence.length > 110) {
      if (emotions && !emotions.disabled) emotions.analyze('sol', sentence, { urgent: true });
      else {
        const g = guessEmotion(sentence); // plano B, se as emoções falharem
        if (g) avatar?.react({ emocao: { laugh: 'risada', surprised: 'surpresa', sad: 'triste', happy: 'feliz', curious: 'curiosa' }[g] || 'neutra', intensidade: 0.6 });
      }
      sentence = '';
    }
    showSubs();
  });
  v.addEventListener('sol-text-done', (e) => {
    emotions?.remember('sol', e.detail);
    if (sentence.trim() && emotions && !emotions.disabled) emotions.analyze('sol', sentence, { urgent: true });
    sentence = '';
    newResponse = true;
  });
  v.addEventListener('api-error', (e) => toast(e.detail));
  v.addEventListener('closed', () => { setState('', 'Conexão caiu'); toast('A conexão de voz caiu. Saia e conecte de novo.'); });
}

function showSubs() {
  if (!subsOn) { $('subs').innerHTML = ''; return; }
  const tail = solLine.length > 160 ? '…' + solLine.slice(-160) : solLine;
  $('subs').innerHTML =
    (userLine ? `<span class="you">Você: ${escapeHtml(userLine)}</span>` : '') +
    (tail ? `<span>${escapeHtml(tail)}</span>` : '');
}
const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function setState(cls, text) {
  $('dot').className = 'dot ' + cls;
  $('state').textContent = text;
}
let toastTimer;
function toast(msg) {
  $('toast').textContent = msg;
  $('toast').style.display = 'block';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($('toast').style.display = 'none'), 6000);
}

// ---------- 2. realidade aumentada ----------
$('btnAR').onclick = async () => {
  try {
    const session = await navigator.xr.requestSession('immersive-ar', {
      requiredFeatures: ['hit-test'],
      optionalFeatures: ['dom-overlay', 'light-estimation', 'anchors'],
      domOverlay: { root: $('overlay') },
    });
    renderer.xr.setReferenceSpaceType('local');
    await renderer.xr.setSession(session);
    const viewer = await session.requestReferenceSpace('viewer');
    hitSource = await session.requestHitTestSource({ space: viewer });
    session.addEventListener('select', onSelect);
    session.addEventListener('end', onARend);
    enterConversation('ar');
    startPicking('place');
  } catch (e) {
    console.error(e);
    setStatus('Não consegui abrir o AR: ' + e.message, true);
  }
};

function onSelect() {
  if (!picking || !reticle.visible) return;
  const p = new THREE.Vector3().setFromMatrixPosition(reticle.matrix);
  if (picking === 'walk') {
    avatar.walkTo(p);
    stopPicking();
  } else {
    placeAt(p, lastHit);
  }
}

function placeAt(p, hit) {
  getCameraPos();
  avatar.placeAt(p, camPos);
  // âncora: mantém a Sol presa ao mesmo ponto do chão, mesmo se o rastreamento corrigir a posição
  anchor = null; anchorPos = null;
  if (hit && hit.createAnchor) {
    hit.createAnchor().then((a) => { anchor = a; }).catch(() => {});
  }
  stopPicking();
  afterPlaced();
}

// plano B: coloca a Sol 1,4 m à sua frente, estimando o chão ~1,45 m abaixo do celular
function placeInFront() {
  if (picking !== 'place') return;
  const cam = renderer.xr.getCamera();
  getCameraPos();
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.getWorldQuaternion(new THREE.Quaternion()));
  fwd.y = 0;
  if (fwd.lengthSq() < 1e-4) fwd.set(0, 0, -1);
  fwd.normalize().multiplyScalar(1.4);
  placeAt(new THREE.Vector3(camPos.x + fwd.x, camPos.y - 1.45, camPos.z + fwd.z), null);
}

function onARend() {
  hitSource = null;
  anchor = null;
  reticle.visible = false;
  leaveConversation();
}

let pickSince = 0;
let floorFound = false;
function startPicking(kind) {
  picking = kind;
  pickSince = performance.now();
  floorFound = false;
  $('bFront').style.display = 'none';
  $('bWalk').classList.toggle('on', kind === 'walk');
  $('hint').textContent = kind === 'walk'
    ? 'Aponte para onde ela deve ir e toque na tela.'
    : 'Aponte para o chão a uns 2 metros e mova o celular devagar, de um lado para o outro.';
}
function stopPicking() {
  picking = null;
  reticle.visible = false;
  $('hint').textContent = '';
  $('bFront').style.display = 'none';
  $('bWalk').classList.remove('on');
}

function updatePickingHint(hasHit) {
  const secs = (performance.now() - pickSince) / 1000;
  if (hasHit) {
    if (!floorFound) $('hint').textContent = picking === 'walk' ? 'Toque na tela para ela ir até o anel.' : 'Chão encontrado! Toque na tela onde o anel está.';
    floorFound = true;
  } else if (floorFound) {
    $('hint').textContent = 'Perdi o chão de vista. Aponte de novo para onde estava o anel.';
  } else if (secs > 4) {
    $('hint').textContent = `Procurando o chão… (${Math.floor(secs)}s) Precisa de luz e de um piso com textura.`;
  }
  if (picking === 'place' && secs > 6) $('bFront').style.display = '';
}

// ---------- prévia sem AR (funciona no PC também) ----------
$('btnPreview').onclick = () => {
  scene.background = new THREE.Color(0x2a211b);
  if (!floor) {
    floor = new THREE.Mesh(new THREE.CircleGeometry(3, 48).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial({ color: 0x3b3029 }));
    scene.add(floor);
  }
  floor.visible = true;
  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 1.2, 0);
  controls.enablePan = false;
  controls.minDistance = 0.5;
  controls.maxDistance = 4;
  controls.update();
  avatar.placeAt(new THREE.Vector3(0, 0, 0), camera.position);
  enterConversation('preview');
  $('hint').textContent = voice ? '' : 'Prévia sem voz: conecte a voz antes para conversar.';
  afterPlaced();
};

function enterConversation(m) {
  mode = m;
  $('setup').style.display = 'none';
  $('overlay').classList.add('on');
  $('bMove').style.display = m === 'ar' ? '' : 'none';
  $('bWalk').style.display = m === 'ar' ? '' : 'none';
  setState('', voice?.connected ? 'Pode falar' : 'Sem voz');
  navigator.wakeLock?.request('screen').catch(() => {});
}

function afterPlaced() {
  if (!placedOnce) {
    placedOnce = true;
    avatar.greet();
    if (voice?.connected) voice.say(preencher(SAUDACAO, $('fName').value));
  }
  if (voice?.connected) voice.setMicEnabled(!muted);
}

function leaveConversation() {
  mode = 'none';
  stopPicking();
  voice?.setMicEnabled(false);
  if (controls) { controls.dispose(); controls = null; }
  if (floor) floor.visible = false;
  scene.background = null;
  avatar.root.visible = false;
  $('overlay').classList.remove('on');
  $('setup').style.display = '';
}

// ---------- botões durante a conversa ----------
// impede que tocar num botão também conte como "toque no AR"
for (const el of [document.querySelector('.bar'), $('bFront')]) el.addEventListener('beforexrselect', (e) => e.preventDefault());
$('bMove').onclick = () => startPicking('place');
$('bWalk').onclick = () => (picking === 'walk' ? stopPicking() : startPicking('walk'));
$('bFront').onclick = () => placeInFront();
$('bMute').onclick = () => {
  muted = !muted;
  voice?.setMicEnabled(!muted);
  $('bMute').classList.toggle('on', muted);
  setState('', muted ? 'Microfone desligado' : 'Pode falar');
};
$('bSubs').onclick = () => {
  subsOn = !subsOn;
  $('bSubs').classList.toggle('on', subsOn);
  showSubs();
};
$('bExit').onclick = () => {
  const s = renderer.xr.getSession();
  if (s) s.end();
  else leaveConversation();
};

// ---------- laço de animação ----------
function getCameraPos() {
  if (renderer.xr.isPresenting) renderer.xr.getCamera().getWorldPosition(camPos);
  else camera.getWorldPosition(camPos);
  return camPos;
}

const _fwd = new THREE.Vector3(), _up = new THREE.Vector3(), _q = new THREE.Quaternion(), _mouth = new THREE.Vector3();

renderer.setAnimationLoop((time, frame) => {
  const dt = clock.getDelta();
  try {
    if (frame) {
      const ref = renderer.xr.getReferenceSpace();
      // procura o chão (para colocar ou para mandar andar)
      if (hitSource && picking) {
        const hits = frame.getHitTestResults(hitSource);
        lastHit = hits.length ? hits[0] : null;
        const pose = lastHit ? lastHit.getPose(ref) : null;
        if (pose) { reticle.visible = true; reticle.matrix.fromArray(pose.transform.matrix); diag.hits++; }
        else reticle.visible = false;
        updatePickingHint(!!pose);
      }
      // âncora: corrige o "escorregão" aplicando o quanto o ponto ancorado se mexeu
      if (anchor && frame.trackedAnchors && frame.trackedAnchors.has(anchor)) {
        const ap = frame.getPose(anchor.anchorSpace, ref);
        if (ap) {
          const p = ap.transform.position;
          if (anchorPos) {
            const dx = p.x - anchorPos.x, dy = p.y - anchorPos.y, dz = p.z - anchorPos.z;
            avatar.root.position.x += dx; avatar.root.position.y += dy; avatar.root.position.z += dz;
            if (avatar.walkTarget) { avatar.walkTarget.x += dx; avatar.walkTarget.y += dy; avatar.walkTarget.z += dz; }
          }
          anchorPos = { x: p.x, y: p.y, z: p.z };
        }
      }
    }

    controls?.update();
    voice?.tick();
    if (avatar && avatar.root.visible) {
      avatar.update(dt, getCameraPos(), voice);
      // som 3D: a voz sai da boca dela
      if (voice?.panner) {
        const cam = renderer.xr.isPresenting ? renderer.xr.getCamera() : camera;
        cam.getWorldQuaternion(_q);
        _fwd.set(0, 0, -1).applyQuaternion(_q);
        _up.set(0, 1, 0).applyQuaternion(_q);
        avatar.bone('head').getWorldPosition(_mouth);
        voice.setSpatial(camPos, _fwd, _up, _mouth);
      }
    }
  } catch (e) {
    reportError('animação', e);
  }
  try {
    renderer.render(scene, camera);
    diag.frames++;
  } catch (e) {
    reportError('desenho', e);
  }
  // quadros por segundo + diagnóstico
  diag.fpsFrames++;
  const now = performance.now();
  if (now - diag.fpsT > 1000) {
    diag.fps = Math.round((diag.fpsFrames * 1000) / (now - diag.fpsT));
    diag.fpsFrames = 0; diag.fpsT = now;
    if (mode !== 'none' && !diag.err) {
      $('diag').textContent = `${diag.fps} fps · chão ${diag.hits} · ${anchor ? 'ancorada' : 'sem âncora'}`;
    }
  }
});

window.addEventListener('resize', () => {
  if (renderer.xr.isPresenting) return;
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// para testes no computador (console): window.sol.avatar.react({emocao:'surpresa', gesto:'surpresa'})
window.sol = { get avatar() { return avatar; }, get voice() { return voice; }, scene, camera };
