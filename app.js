// Sol: junta tudo (cena 3D, realidade aumentada, voz e interface).
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { loadAvatar } from './avatar.js';
import { VoiceLink, guessEmotion } from './voice.js';
import { PERSONA, SAUDACAO, preencher } from './persona.js';

const $ = (id) => document.getElementById(id);

// ---------- configurações salvas no aparelho ----------
const store = {
  get(k, d = '') { try { return localStorage.getItem('sol.' + k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('sol.' + k, v); } catch {} },
};
$('fWorker').value = store.get('worker');
$('fToken').value = store.get('token');
$('fName').value = store.get('name');
$('fVoice').value = store.get('voice', 'marin');

// ---------- cena ----------
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.xr.enabled = true;
renderer.xr.setFramebufferScaleFactor(0.85); // mais leve para celulares antigos
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.05, 50);
camera.position.set(0, 1.45, 1.6);

const hemi = new THREE.HemisphereLight(0xfff4e8, 0x5a4a3c, 1.6);
const sunLight = new THREE.DirectionalLight(0xffffff, 1.6);
sunLight.position.set(0.6, 2.5, 1.5);
scene.add(hemi, sunLight);

// ---------- diagnóstico: mostra na tela qualquer erro (o celular não tem console) ----------
const diag = { frames: 0, hits: 0, err: '' };
function reportError(where, e) {
  const msg = `${where}: ${e && e.message ? e.message : e}`;
  if (diag.err === msg) return;
  diag.err = msg;
  console.error(where, e);
  const el = $('diag');
  if (el) el.textContent = 'ERRO ' + msg;
}
window.addEventListener('error', (e) => reportError('erro', e.error || e.message));
window.addEventListener('unhandledrejection', (e) => reportError('promessa', e.reason));

// anel que mostra onde ela vai aparecer
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
let mode = 'none'; // none | ar | preview
let placing = false;
let placedOnce = false;
let hitSource = null;
let controls = null;
let floor = null;
let subsOn = true;
let muted = false;
let solLine = '';
let sentence = '';
let thinkTimer = null;
const clock = new THREE.Clock();
const camPos = new THREE.Vector3();

// ---------- carregar a Sol ----------
loadAvatar('./sol.vrm', (p) => ($('bar').style.width = Math.round(p * 100) + '%'))
  .then((a) => {
    avatar = a;
    avatar.root.visible = false;
    scene.add(avatar.root);
    $('bar').style.width = '100%';
    setStatus('Sol pronta. Preencha os campos e conecte a voz.');
    $('btnConnect').disabled = false;
    $('btnPreview').disabled = false;
  })
  .catch((e) => setStatus('Erro ao carregar o modelo: ' + e.message, true));

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
  if (!worker || !token) return setStatus('Preencha o endereço do servidor e a senha.', true);
  store.set('worker', worker); store.set('token', token); store.set('name', name); store.set('voice', v);

  $('btnConnect').disabled = true;
  setStatus('Pedindo acesso ao microfone…');
  try {
    const mic = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    setStatus('Conectando com a voz da Sol…');
    voice?.close();
    voice = new VoiceLink({ workerUrl: worker, appToken: token, voice: v });
    wireVoice(voice);
    await voice.connect(mic);
    voice.setInstructions(preencher(PERSONA, name));
    voice.enableUserTranscript();
    voice.setMicEnabled(false); // só escuta depois que ela aparecer
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

function wireVoice(v) {
  v.addEventListener('user-start', () => { avatar?.setMode('listening'); setState('listening', 'Ouvindo você'); });
  v.addEventListener('user-stop', () => {
    avatar?.nodOnce();
    avatar?.setMode('thinking');
    setState('thinking', 'Pensando…');
    // se não vier resposta (ex.: foi só um barulho), volta ao normal
    clearTimeout(thinkTimer);
    thinkTimer = setTimeout(() => {
      if (avatar?.mode === 'thinking') { avatar.setMode('idle'); setState('', 'Pode falar'); }
    }, 7000);
  });
  v.addEventListener('sol-start', () => { clearTimeout(thinkTimer); avatar?.setMode('speaking'); setState('speaking', 'Sol falando'); solLine = ''; sentence = ''; });
  v.addEventListener('sol-stop', () => {
    if (v.userSpeaking) { avatar?.setMode('listening'); setState('listening', 'Ouvindo você'); }
    else { avatar?.setMode('idle'); setState('', muted ? 'Microfone desligado' : 'Pode falar'); }
  });
  v.addEventListener('sol-text', (e) => {
    solLine += e.detail;
    sentence += e.detail;
    // a cada frase terminada, ajusta a emoção dela
    if (/[.!?…]\s*$/.test(sentence) || sentence.length > 90) {
      const emo = guessEmotion(sentence);
      if (emo) avatar?.feel(emo);
      sentence = '';
    }
    showSubs();
  });
  v.addEventListener('user-text', (e) => { userLine = e.detail; showSubs(); });
  v.addEventListener('api-error', (e) => toast(e.detail));
  v.addEventListener('closed', () => { setState('', 'Conexão caiu'); toast('A conexão de voz caiu. Saia e conecte de novo.'); });
}

let userLine = '';
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
      optionalFeatures: ['dom-overlay'],
      domOverlay: { root: $('overlay') },
    });
    renderer.xr.setReferenceSpaceType('local');
    await renderer.xr.setSession(session);
    const viewer = await session.requestReferenceSpace('viewer');
    hitSource = await session.requestHitTestSource({ space: viewer });
    session.addEventListener('select', onSelect);
    session.addEventListener('end', onARend);
    enterConversation('ar');
    startPlacing();
  } catch (e) {
    console.error(e);
    setStatus('Não consegui abrir o AR: ' + e.message, true);
  }
};

function onSelect() {
  if (!placing || !reticle.visible) return;
  placeAt(new THREE.Vector3().setFromMatrixPosition(reticle.matrix));
}

function placeAt(p) {
  getCameraPos();
  avatar.placeAt(p, camPos);
  placing = false;
  reticle.visible = false;
  $('hint').textContent = '';
  $('bFront').style.display = 'none';
  afterPlaced();
}

// plano B: se o chão não for detectado, coloca a Sol 1,4 m à sua frente,
// estimando o chão ~1,45 m abaixo do celular
function placeInFront() {
  if (!placing) return;
  const cam = renderer.xr.getCamera();
  getCameraPos();
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.getWorldQuaternion(new THREE.Quaternion()));
  fwd.y = 0;
  if (fwd.lengthSq() < 1e-4) fwd.set(0, 0, -1);
  fwd.normalize().multiplyScalar(1.4);
  placeAt(new THREE.Vector3(camPos.x + fwd.x, camPos.y - 1.45, camPos.z + fwd.z));
}

function onARend() {
  hitSource = null;
  reticle.visible = false;
  leaveConversation();
}

let placingSince = 0;
let floorFound = false;
function startPlacing() {
  placing = true;
  placingSince = performance.now();
  floorFound = false;
  $('bFront').style.display = 'none';
  $('hint').textContent = 'Aponte para o chão a uns 2 metros e mova o celular devagar, de um lado para o outro.';
}

// mensagens enquanto procura o chão + botão do plano B
function updatePlacingHint(hasHit) {
  const secs = (performance.now() - placingSince) / 1000;
  if (hasHit) {
    if (!floorFound) $('hint').textContent = 'Chão encontrado! Toque na tela onde o anel está.';
    floorFound = true;
  } else if (floorFound) {
    $('hint').textContent = 'Perdi o chão de vista. Aponte de novo para onde estava o anel.';
  } else if (secs > 4) {
    $('hint').textContent = `Procurando o chão… (${Math.floor(secs)}s) Precisa de luz e de um piso com textura. Mova o celular devagar.`;
  }
  if (secs > 6) $('bFront').style.display = '';
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
  setState('', voice?.connected ? 'Pode falar' : 'Sem voz');
  navigator.wakeLock?.request('screen').catch(() => {});
}

function afterPlaced() {
  if (!voice?.connected) return;
  voice.setMicEnabled(!muted);
  if (!placedOnce) {
    placedOnce = true;
    voice.say(preencher(SAUDACAO, $('fName').value));
  }
}

function leaveConversation() {
  mode = 'none';
  placing = false;
  voice?.setMicEnabled(false);
  if (controls) { controls.dispose(); controls = null; }
  if (floor) floor.visible = false;
  scene.background = null;
  avatar.root.visible = false;
  $('overlay').classList.remove('on');
  $('setup').style.display = '';
  $('hint').textContent = '';
}

// ---------- botões durante a conversa ----------
// impede que tocar num botão também conte como "toque no AR"
document.querySelector('.bar').addEventListener('beforexrselect', (e) => e.preventDefault());
$('bMove').onclick = () => startPlacing();
$('bFront').onclick = () => placeInFront();
$('bFront').addEventListener('beforexrselect', (e) => e.preventDefault());
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

renderer.setAnimationLoop((time, frame) => {
  const dt = clock.getDelta();
  try {
    if (frame && hitSource && placing) {
      const ref = renderer.xr.getReferenceSpace();
      const hits = frame.getHitTestResults(hitSource);
      const pose = hits.length ? hits[0].getPose(ref) : null;
      if (pose) {
        reticle.visible = true;
        reticle.matrix.fromArray(pose.transform.matrix);
      } else reticle.visible = false;
      if (pose) diag.hits++;
      updatePlacingHint(!!pose);
    }

    controls?.update();
    voice?.tick();
    if (avatar && avatar.root.visible) avatar.update(dt, getCameraPos(), voice);
  } catch (e) {
    reportError('animação', e);
  }
  try {
    renderer.render(scene, camera);
    diag.frames++;
  } catch (e) {
    reportError('desenho', e);
  }
  if (mode === 'ar' && diag.frames % 30 === 0 && !diag.err) {
    const el = $('diag');
    if (el) el.textContent = `quadros ${diag.frames} · chão ${diag.hits} · Sol ${avatar && avatar.root.visible ? 'visível' : 'oculta'}`;
  }
});

window.addEventListener('resize', () => {
  if (renderer.xr.isPresenting) return;
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
