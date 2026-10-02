// Colour Debt 3D - browser side code.
// I made this file for the 3D look (Three.js) and the gameplay loop.
// All game DATA and saving is done in Python (app.py), this file only
// draws the 3D scene, moves blocks, and asks the server to save things.
'use strict';

const $ = (id) => document.getElementById(id);
const COLOUR_NAMES = ['RED', 'BLUE', 'GREEN', 'YELLOW'];
const PLATFORM_HALF_WIDTH = 4.2;
const FALL_START_Y = 8;
const CATCH_Y = 0.6;
const CATCH_TOLERANCE = 0.55;
const CATCH_X_RADIUS = 1.1;

// I keep the server data in S. The server sends it on page load
// and after every save (coins, levels, shop etc).
let S = null;

// run holds only the current level attempt (score, lives, blocks).
// I never save this - it resets every time a level starts.
// ending stops the same level-clear from being sent twice.
let run = {
  screen: 'START',
  difficulty: 'EASY',
  currentLevel: 0,
  score: 0,
  lives: 5,
  playerX: 0,
  cubes: [],
  lastSpawn: 0,
  isTraining: false,
  activeAbility: null,
  lastReward: 0,
  lastDiamond: false,
  ending: false,
};

// I call the Python server through this one helper.
// If body is given it sends POST, otherwise GET. The server
// returns the fresh state and I store it in S right away.
async function api(path, body) {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body || {}),
  });
  const data = await res.json();
  if (data.state) S = data.state;
  return data;
}

function currentLevelInfo() {
  if (run.isTraining) return S.trainingLevel;
  return S.levels[run.currentLevel];
}

// ---------------------------------------------------------
// 3D scene setup
// I create the renderer, camera, lights, ground and the player
// ball here once. Everything else (falling blocks) is added
// and removed during the level.
// ---------------------------------------------------------
const canvas = $('three-canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1b1f2a);
scene.fog = new THREE.Fog(0x1b1f2a, 12, 26);

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.set(0, 6, 13);
camera.lookAt(0, 2, -2);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  if (run.screen === 'LEVEL_SELECT') renderLevelGrid();
});

scene.add(new THREE.AmbientLight(0xffffff, 0.55));
const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
dirLight.position.set(5, 12, 6);
scene.add(dirLight);

const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(12, 20, 12, 20),
  new THREE.MeshStandardMaterial({ color: 0x252b3a })
);
ground.rotation.x = -Math.PI / 2;
scene.add(ground);

const grid = new THREE.GridHelper(12, 12, 0x3a4157, 0x3a4157);
grid.position.set(0, 0.01, 0);
scene.add(grid);

// I build the player as a glowing white ball with a gold ring under it
// plus a soft light circle on the ground for extra 3D depth.
// The emoji face bought in the shop is drawn on the ball as a canvas
// texture (playerFaceMesh), always turned towards the camera.
const playerGroup = new THREE.Group();
const playerSphere = new THREE.Mesh(
  new THREE.SphereGeometry(0.55, 24, 24),
  new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0x222222 })
);
playerSphere.position.y = 0.55;
playerGroup.add(playerSphere);
// 3D emoji face on the ball: a THREE.Sprite that always turns
// towards the camera, so the face never smears or hides behind
// the ball. Hidden when "No Face" is selected.
const playerFaceSprite = new THREE.Sprite(
  new THREE.SpriteMaterial({ transparent: true, depthTest: false })
);
playerFaceSprite.position.y = 0.55;
playerFaceSprite.scale.set(0.75, 0.75, 1);
playerFaceSprite.visible = false;
playerFaceSprite.renderOrder = 5;
playerGroup.add(playerFaceSprite);
function emojiIconById(id) {
  // I read the icon from the server list so shop and ball never mismatch.
  const found = (S && S.emojis || []).find((e) => e.id === id);
  if (found) return found.icon;
  const fallback = { none: '', smile: '😊', cool: '😎', star: '🤩', fire: '🔥', crown: '👑' };
  return fallback[id] || '';
}
function applyPlayerEmoji() {
  // I redraw the face sprite from the selected shop emoji here.
  // Called on boot and after every shop buy/select, so the ball
  // always shows the face the player is wearing right now.
  const id = (S && S.selectedEmoji) || 'none';
  if (!id || id === 'none') { playerFaceSprite.visible = false; return; }
  const c = document.createElement('canvas'); c.width = 128; c.height = 128;
  const cx = c.getContext('2d');
  cx.clearRect(0, 0, 128, 128);
  cx.font = '92px serif';
  cx.textAlign = 'center'; cx.textBaseline = 'middle';
  cx.fillText(emojiIconById(id), 64, 70);
  const tex = new THREE.CanvasTexture(c);
  playerFaceSprite.material.map = tex;
  playerFaceSprite.material.needsUpdate = true;
  playerFaceSprite.visible = true;
}
const ring = new THREE.Mesh(
  new THREE.TorusGeometry(0.75, 0.06, 12, 32),
  new THREE.MeshStandardMaterial({ color: 0xf5c93b, emissive: 0x664e00 })
);
ring.rotation.x = Math.PI / 2;
ring.position.y = 0.15;
playerGroup.add(ring);
const glow = new THREE.Mesh(
  new THREE.CircleGeometry(1.1, 32),
  new THREE.MeshBasicMaterial({ color: 0x3b82f6, transparent: true, opacity: 0.18 })
);
glow.rotation.x = -Math.PI / 2;
glow.position.y = 0.02;
playerGroup.add(glow);
scene.add(playerGroup);

// ---------------------------------------------------------
// Shop skin shapes
// I make a different 3D shape for each shop skin here:
// classic = plain box, gem = diamond shape, striped = box with
// white stripes texture, star = 5-point star, crystal = glassy
// ball, rainbow = glowing twisted ring.
// ---------------------------------------------------------
const HEXMAP = { RED: 0xe5484d, BLUE: 0x3b82f6, GREEN: 0x2fbf71, YELLOW: 0xf5c93b };
const stripedTextureCache = {};
function getStripedTexture(colorName) {
  if (stripedTextureCache[colorName]) return stripedTextureCache[colorName];
  const c = document.createElement('canvas'); c.width = 64; c.height = 64;
  const cx = c.getContext('2d');
  const css = (S && S.coloursCss[colorName]) || '#e5484d';
  cx.fillStyle = css; cx.fillRect(0, 0, 64, 64);
  cx.strokeStyle = 'rgba(255,255,255,0.85)'; cx.lineWidth = 9;
  for (let off = -64; off < 128; off += 16) {
    cx.beginPath(); cx.moveTo(off, 64); cx.lineTo(off + 64, 0); cx.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  stripedTextureCache[colorName] = tex;
  return tex;
}

let starGeometry = null;
function getStarGeometry() {
  if (starGeometry) return starGeometry;
  const shape = new THREE.Shape();
  const outerR = 0.55, innerR = 0.24, spikes = 5;
  for (let i = 0; i < spikes * 2; i++) {
    const r = i % 2 === 0 ? outerR : innerR;
    const angle = (Math.PI / spikes) * i - Math.PI / 2;
    const x = Math.cos(angle) * r, y = Math.sin(angle) * r;
    if (i === 0) shape.moveTo(x, y); else shape.lineTo(x, y);
  }
  shape.closePath();
  starGeometry = new THREE.ExtrudeGeometry(shape, { depth: 0.32, bevelEnabled: false });
  starGeometry.center();
  return starGeometry;
}

function buildSkinGeometryAndMaterial(skinId, hex, colorNameForTexture) {
  let geo, mat;
  if (skinId === 'gem') {
    geo = new THREE.OctahedronGeometry(0.62);
    mat = new THREE.MeshStandardMaterial({ color: hex, emissive: 0x111111, flatShading: true });
  } else if (skinId === 'striped') {
    geo = new THREE.BoxGeometry(0.9, 0.9, 0.9);
    mat = colorNameForTexture
      ? new THREE.MeshStandardMaterial({ map: getStripedTexture(colorNameForTexture), emissive: 0x0a0a0a })
      : new THREE.MeshStandardMaterial({ color: hex, emissive: 0x0a0a0a });
  } else if (skinId === 'star') {
    geo = getStarGeometry();
    mat = new THREE.MeshStandardMaterial({ color: hex, emissive: 0x111111 });
  } else if (skinId === 'crystal') {
    geo = new THREE.IcosahedronGeometry(0.62);
    mat = new THREE.MeshStandardMaterial({ color: hex, emissive: hex, emissiveIntensity: 0.25, transparent: true, opacity: 0.72, flatShading: true });
  } else if (skinId === 'rainbow') {
    geo = new THREE.TorusKnotGeometry(0.32, 0.13, 64, 8);
    mat = new THREE.MeshStandardMaterial({ color: hex, emissive: hex, emissiveIntensity: 0.6, metalness: 0.4, roughness: 0.25 });
  } else {
    geo = new THREE.BoxGeometry(0.9, 0.9, 0.9);
    mat = new THREE.MeshStandardMaterial({ color: hex, emissive: 0x111111 });
  }
  return { geo, mat };
}

function createSkinMesh(colorName, skinId) {
  const hex = HEXMAP[colorName];
  const { geo, mat } = buildSkinGeometryAndMaterial(skinId, hex, colorName);
  return new THREE.Mesh(geo, mat);
}

// ---------------------------------------------------------
// Gameplay - spawning, catching, scoring
// spawnCube drops one random block from the top. If color bomb
// ability is running, every block becomes the target colour.
// updatePlaying runs each frame: moves blocks down, checks catch
// (right colour = +1 score, wrong colour = -1 life) and miss
// (missing target colour = -1 life), then ends level or game over.
// ---------------------------------------------------------
function isAbilityActive(id) {
  return run.activeAbility && run.activeAbility.id === id && performance.now() < run.activeAbility.endsAt;
}

function spawnCube() {
  let colorName = COLOUR_NAMES[Math.floor(Math.random() * COLOUR_NAMES.length)];
  if (isAbilityActive('colorbomb')) colorName = currentLevelInfo().color;
  const mesh = createSkinMesh(colorName, S.selectedSkin);
  const x = (Math.random() * 2 - 1) * PLATFORM_HALF_WIDTH;
  mesh.position.set(x, FALL_START_Y, 0);
  scene.add(mesh);
  run.cubes.push({ mesh, color: colorName });
}

function clearCubes() {
  for (const c of run.cubes) scene.remove(c.mesh);
  run.cubes = [];
}

function startLevel(index) {
  run.currentLevel = index;
  run.isTraining = false;
  run.score = 0;
  run.lives = S.startingLives;
  run.activeAbility = null;
  run.ending = false;
  run.playerX = 0;
  playerGroup.position.x = 0;
  clearCubes();
  run.lastSpawn = performance.now();
  setScreen('PLAYING');
}

function startTraining() {
  run.isTraining = true;
  run.difficulty = 'EASY';
  run.score = 0;
  run.lives = S.startingLives;
  run.ending = false;
  run.playerX = 0;
  playerGroup.position.x = 0;
  clearCubes();
  run.lastSpawn = performance.now();
  setScreen('PLAYING');
}

async function updatePlaying() {
  if (run.activeAbility && performance.now() >= run.activeAbility.endsAt) {
    run.activeAbility = null;
  }
  const settings = S.difficulty[run.difficulty];
  const now = performance.now();
  if (now - run.lastSpawn > settings.spawnMs) {
    spawnCube();
    run.lastSpawn = now;
  }

  playerGroup.position.x += (run.playerX - playerGroup.position.x) * 0.35;
  playerSphere.position.y = 0.55 + Math.abs(Math.sin(now * 0.005)) * 0.08; // bounce
  ring.rotation.z += 0.02;

  const targetColor = currentLevelInfo().color;
  const remaining = [];
  for (const cube of run.cubes) {
    const speedMul = isAbilityActive('slowmo') ? 0.4 : 1;
    cube.mesh.position.y -= settings.speed * 4 * speedMul;
    cube.mesh.rotation.x += 0.03;
    cube.mesh.rotation.y += 0.04;

    const dy = Math.abs(cube.mesh.position.y - CATCH_Y);
    const dx = Math.abs(cube.mesh.position.x - playerGroup.position.x);

    if (dy < CATCH_TOLERANCE && dx < CATCH_X_RADIUS) {
      if (cube.color === targetColor) run.score += 1;
      else { run.lives -= 1; vibrate(); }
      scene.remove(cube.mesh);
      continue;
    }
    if (cube.mesh.position.y < -1) {
      if (cube.color === targetColor) { run.lives -= 1; vibrate(); }
      scene.remove(cube.mesh);
      continue;
    }
    remaining.push(cube);
  }
  run.cubes = remaining;
  updateHUD();

  if (run.isTraining) {
    if (run.lives <= 0) {
      run.score = 0;
      run.lives = S.startingLives;
      clearCubes();
    } else if (run.score >= S.trainingLevel.targetScore) {
      await api('/api/training-seen', {});
      setScreen('TRAINING_COMPLETE');
    }
    return;
  }

  if (run.lives <= 0) {
    if (!run.ending) { run.ending = true; setScreen('GAME_OVER'); }
  } else if (run.score >= S.levels[run.currentLevel].targetScore) {
    // I send the reward only once per clear. Without this lock the
    // frame loop can call the server many times and add extra coins.
    if (run.ending) return;
    run.ending = true;
    const data = await api('/api/level-complete', { difficulty: run.difficulty, level: run.currentLevel });
    if (data.ok) {
      run.lastReward = data.reward;
      run.lastDiamond = data.gotDiamond;
      setScreen('LEVEL_COMPLETE');
    } else {
      run.ending = false;
    }
  }
}

// When a life is lost I give feedback three ways: real phone
// vibration on mobile, plus screen shake, red flash and a short
// buzz sound on desktop so PC players feel it too.
function vibrate() {
  if (!S || !S.vibrationOn) return;
  try { if (navigator.vibrate) navigator.vibrate(300); } catch (e) {}
  try {
    const c = $('three-canvas');
    if (c) { c.classList.remove('shake'); void c.offsetWidth; c.classList.add('shake'); }
  } catch (e) {}
  try {
    const f = $('lifeFlash');
    if (f) { f.classList.remove('show'); void f.offsetWidth; f.classList.add('show'); }
  } catch (e) {}
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) {
      const ctx = new AC();
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sawtooth';
      o.frequency.value = 140;
      g.gain.value = 0.12;
      o.connect(g); g.connect(ctx.destination);
      o.start();
      o.stop(ctx.currentTime + 0.28);
      o.onended = () => { try { ctx.close(); } catch (e) {} };
    }
  } catch (e) {}
}

// ---------------------------------------------------------
// Player input
// I support three ways to move: arrow keys, mouse drag and
// touch drag on mobile. All three just change run.playerX,
// the player ball follows it smoothly in updatePlaying.
// ---------------------------------------------------------
let keys = { left: false, right: false };
window.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowLeft') keys.left = true;
  if (e.key === 'ArrowRight') keys.right = true;
});
window.addEventListener('keyup', (e) => {
  if (e.key === 'ArrowLeft') keys.left = false;
  if (e.key === 'ArrowRight') keys.right = false;
});

function setPlayerFromClientX(clientX) {
  const norm = (clientX / window.innerWidth) * 2 - 1;
  run.playerX = norm * PLATFORM_HALF_WIDTH;
}
let dragging = false;
canvas.addEventListener('mousedown', (e) => { if (run.screen === 'PLAYING') { dragging = true; setPlayerFromClientX(e.clientX); } });
window.addEventListener('mousemove', (e) => { if (dragging) setPlayerFromClientX(e.clientX); });
window.addEventListener('mouseup', () => { dragging = false; });
canvas.addEventListener('touchstart', (e) => { if (run.screen === 'PLAYING') setPlayerFromClientX(e.touches[0].clientX); }, { passive: true });
canvas.addEventListener('touchmove', (e) => { if (run.screen === 'PLAYING') setPlayerFromClientX(e.touches[0].clientX); }, { passive: true });

// ---------------------------------------------------------
// Screens
// I show one screen at a time with setScreen: it hides all
// overlays first, then shows only the asked one and refreshes
// its data (level map, shop items, profile rows etc).
// ---------------------------------------------------------
function setScreen(name) {
  run.screen = name;
  if (name === 'NAME_ENTRY') renderSavedUsers();
  document.querySelectorAll('.overlay').forEach((el) => el.classList.remove('active'));
  $('hud').classList.remove('active');
  $('hint').classList.remove('active');
  $('trainBanner').classList.remove('active');
  $('abilityBar').classList.remove('active');
  $('cornerButtons').classList.toggle('hidden', name !== 'START');

  if (name === 'PLAYING') {
    $('hud').classList.add('active');
    if (run.isTraining) $('trainBanner').classList.add('active');
    else { $('hint').classList.add('active'); $('abilityBar').classList.add('active'); renderAbilityBar(); }
    updateHUD();
  } else {
    const el = $('screen-' + name);
    if (el) el.classList.add('active');
    if (name === 'LEVEL_SELECT') renderLevelGrid();
    if (name === 'SHOP') { renderShop(); animateShopPreviews(); }
    if (name === 'PROFILE') renderProfile();
    if (name === 'SETTINGS') renderSettings();
    if (name === 'DAILY_REWARD') renderDailyReward();
    if (name === 'START') {
      $('welcomeText').textContent = S.username ? ('Welcome, ' + S.username + '! Select Difficulty') : 'Select Difficulty';
    }
    if (name === 'LEVEL_COMPLETE') {
      $('lcText').textContent = 'Level ' + (run.currentLevel + 1) + ' cleared';
      $('lcCoins').textContent = '+' + run.lastReward + ' 🪙 coins earned';
      const dEl = $('lcDiamond');
      if (run.lastDiamond) {
        dEl.textContent = '💎 +1 Diamond! (' + S.levelsCompletedCount + ' levels completed)';
        dEl.style.display = 'block';
      } else dEl.style.display = 'none';
      const hasNext = run.currentLevel + 1 < S.levels.length;
      const btn = $('nextLevelBtn');
      btn.textContent = hasNext ? 'Next Level' : 'All Levels Done!';
      btn.classList.toggle('btn-disabled', !hasNext);
      btn.classList.toggle('btn-green', hasNext);
    }
    if (name === 'GAME_OVER') {
      $('goText').textContent = 'Score: ' + run.score + ' / ' + S.levels[run.currentLevel].targetScore;
      const canContinue = S.coins >= S.continueCost;
      const btn = $('continueBtn');
      btn.disabled = !canContinue;
      btn.classList.toggle('btn-disabled', !canContinue);
      btn.classList.toggle('btn-gold', canContinue);
      btn.textContent = canContinue ? 'Continue  −' + S.continueCost + ' 🪙' : 'Continue — Need ' + S.continueCost + ' 🪙';
      $('goContinueText').textContent = canContinue
        ? 'Pay ' + S.continueCost + ' coins to continue from Score ' + run.score + ' with 1 ❤️.'
        : 'You have ' + S.coins + ' coins. You need ' + S.continueCost + '.';
    }
  }
}

function updateHUD() {
  const lvl = currentLevelInfo();
  $('hudSwatch').style.background = S.coloursCss[lvl.color];
  $('hudCatch').textContent = 'Catch: ' + lvl.color;
  $('hudScore').textContent = 'Score: ' + run.score + ' / ' + lvl.targetScore;
  $('hudLives').textContent = 'Lives: ' + '❤ '.repeat(Math.max(0, run.lives));
  $('hudCoins').textContent = '🪙 ' + S.coins + '  💎 ' + S.diamonds;
}

function renderLevelGrid() {
  $('diffLabel').textContent = 'Difficulty: ' + run.difficulty;
  const road = $('levelRoad'), svg = $('roadSvg'), wrap = $('levelRoadWrap');
  road.querySelectorAll('.levelNode, .levelStars').forEach((el) => el.remove());
  svg.innerHTML = '';

  const BASE_W = 620, BASE_NODE_R = 42, BASE_TOP_Y = 70, BASE_GAP_Y = 95;
  const n = S.levels.length;
  const BASE_BOTTOM_Y = BASE_TOP_Y + (n - 1) * BASE_GAP_Y;
  const BASE_H = BASE_BOTTOM_Y + 90;
  const maxW = window.innerWidth - 40;
  const maxViewH = window.innerHeight - 210;
  const scale = Math.min(1, maxW / BASE_W);
  const ROAD_W = BASE_W * scale, ROAD_H = BASE_H * scale;
  const nodeR = BASE_NODE_R * scale, gapY = BASE_GAP_Y * scale, bottomY = BASE_BOTTOM_Y * scale;
  road.style.width = ROAD_W + 'px';
  road.style.height = ROAD_H + 'px';
  svg.setAttribute('viewBox', '0 0 ' + ROAD_W + ' ' + ROAD_H);
  wrap.style.width = ROAD_W + 'px';
  wrap.style.height = Math.min(ROAD_H, maxViewH) + 'px';

  const positions = S.levels.map((_, i) => ({
    x: (i % 2 === 0) ? ROAD_W / 2 + 110 * scale : ROAD_W / 2 - 110 * scale,
    y: bottomY - i * gapY,
  }));

  const ns = 'http://www.w3.org/2000/svg';
  for (let i = 0; i < positions.length - 1; i++) {
    const p1 = positions[i], p2 = positions[i + 1];
    const midX = (p1.x + p2.x) / 2, midY = (p1.y + p2.y) / 2;
    const d = 'M ' + p1.x + ' ' + p1.y + ' Q ' + midX + ' ' + p1.y + ' ' + midX + ' ' + midY +
              ' Q ' + midX + ' ' + p2.y + ' ' + p2.x + ' ' + p2.y;
    const base = document.createElementNS(ns, 'path');
    base.setAttribute('d', d);
    base.setAttribute('stroke', '#D9A441');
    base.setAttribute('stroke-width', Math.max(10, 20 * scale));
    base.setAttribute('fill', 'none');
    base.setAttribute('stroke-linecap', 'round');
    svg.appendChild(base);
    const dash = document.createElementNS(ns, 'path');
    dash.setAttribute('d', d);
    dash.setAttribute('stroke', 'rgba(255,255,255,0.85)');
    dash.setAttribute('stroke-width', Math.max(2, 4 * scale));
    dash.setAttribute('stroke-dasharray', (12 * scale) + ' ' + (10 * scale));
    dash.setAttribute('fill', 'none');
    dash.setAttribute('stroke-linecap', 'round');
    svg.appendChild(dash);
  }

  const nodeSize = nodeR * 2;
  S.levels.forEach((lvl, i) => {
    const { x, y } = positions[i];
    const locked = i > S.unlockedLevel[run.difficulty];
    const completed = i < S.unlockedLevel[run.difficulty];
    const node = document.createElement('div');
    node.className = 'levelNode' + (locked ? ' locked' : '');
    node.style.left = (x - nodeR) + 'px';
    node.style.top = (y - nodeR) + 'px';
    node.style.width = nodeSize + 'px';
    node.style.height = nodeSize + 'px';
    node.style.fontSize = (1.5 * scale) + 'em';
    node.style.background = locked ? '#3c3c3c' : S.coloursCss[lvl.color];
    node.textContent = locked ? '🔒' : String(i + 1);
    if (!locked) node.addEventListener('click', () => startLevel(i));
    road.appendChild(node);
    if (!locked) {
      const stars = document.createElement('div');
      stars.className = 'levelStars';
      stars.style.left = (x - 45 * scale) + 'px';
      stars.style.top = (y + nodeR + 10 * scale) + 'px';
      stars.style.width = (90 * scale) + 'px';
      stars.style.fontSize = (1.05 * scale) + 'em';
      const filled = completed ? 3 : 0;
      stars.innerHTML = ['★', '★', '★'].map((s, idx) =>
        '<span style="color:' + (idx < filled ? '#f5c93b' : 'rgba(255,255,255,0.25)') + '">' + s + '</span>').join('');
      road.appendChild(stars);
    }
  });
  wrap.scrollTop = wrap.scrollHeight;
}

// I show a small 3D preview of every skin in the shop so the player
// can see the design before buying it. Earlier I made one LIVE
// WebGLRenderer per card (6 skins + 6 faces + main game = 13 live
// contexts). Browsers allow only ~8-16, so the boxes went BLACK.
// Now I use ONE shared offscreen renderer and save each preview as a
// static photo (dataURL <img>). The shop uses 0 extra live contexts,
// so opening the shop any number of times never goes black.
let shopPreviewScenes = []; // kept only to free very old live previews, if any
let previewRenderer = null;
function getPreviewRenderer() {
  // Single 70x70 renderer for all snapshots. preserveDrawingBuffer
  // must be true, otherwise toDataURL() returns a blank photo.
  if (!previewRenderer) {
    const cv = document.createElement('canvas');
    cv.width = 70; cv.height = 70;
    previewRenderer = new THREE.WebGLRenderer({ canvas: cv, alpha: true, antialias: true, preserveDrawingBuffer: true });
    previewRenderer.setSize(70, 70, false);
  }
  return previewRenderer;
}
function snapshotToImage(sc, cam) {
  // I draw the scene once and return it as a normal <img> photo.
  // The shared canvas is reused, but the dataURL copy stays safe.
  const r = getPreviewRenderer();
  r.render(sc, cam);
  const img = document.createElement('img');
  img.src = r.domElement.toDataURL();
  img.width = 70; img.height = 70;
  return img;
}
function disposePreviewScene(sc) {
  // I free only this photo's shapes and materials here. The shared
  // renderer itself stays alive for the next photo.
  sc.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => {
      if (m.map && !Object.values(stripedTextureCache).includes(m.map)) m.map.dispose();
      m.dispose();
    });
  });
}
function disposeShopPreviews() {
  // I free every OLD live preview fully here (very old code made one
  // renderer per card). renderer.dispose() alone does NOT free the
  // browser 3D context (only ~16 allowed) - without loseContext
  // the main game went black after opening the shop a few times.
  shopPreviewScenes.forEach((p) => {
    try {
      p.scene.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => {
          if (m.map) m.map.dispose();
          m.dispose();
        });
      });
      const gl = p.renderer.getContext();
      const lose = gl && gl.getExtension('WEBGL_lose_context');
      if (lose) lose.loseContext();
      p.renderer.dispose();
    } catch (e) {}
  });
  shopPreviewScenes = [];
}
function previewSceneBase() {
  // Small helper: one camera + lights setup shared by all photos.
  const sc = new THREE.Scene();
  const cam = new THREE.PerspectiveCamera(40, 1, 0.1, 10);
  cam.position.set(0, 0, 2.4);
  sc.add(new THREE.AmbientLight(0xffffff, 0.7));
  const dl = new THREE.DirectionalLight(0xffffff, 0.9);
  dl.position.set(2, 2, 3);
  sc.add(dl);
  return { sc, cam };
}
function shopFallbackBox(text) {
  // If 3D fails on some phone, I still show a box with an icon
  // instead of a black square, so the shop never looks broken.
  const d = document.createElement('div');
  d.className = 'shopPreview';
  d.style.cssText = 'background:#31405c;display:flex;align-items:center;justify-content:center;font-size:1.6em;';
  d.textContent = text || '🎲';
  return d;
}
function createShopPreviewCanvas(skinId, hex) {
  // I take ONE photo of the skin shape from a fixed nice angle.
  // No live renderer per card, so no black boxes anymore.
  try {
    const { sc, cam } = previewSceneBase();
    const { geo, mat } = buildSkinGeometryAndMaterial(skinId, hex, null);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.set(0.5, 0.6, 0);
    sc.add(mesh);
    const img = snapshotToImage(sc, cam);
    disposePreviewScene(sc);
    return img;
  } catch (e) {
    return shopFallbackBox('🎲');
  }
}
// 3D ball-face preview photo: a real mini white ball (sphere + face
// sprite) instead of a flat emoji, so the shop shows exactly what the
// player will wear in the game. Photo only, same shared renderer.
function createFacePreviewCanvas(icon) {
  try {
    const { sc, cam } = previewSceneBase();
    const grp = new THREE.Group();
    const ball = new THREE.Mesh(
      new THREE.SphereGeometry(0.5, 20, 20),
      new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0x222222 })
    );
    grp.add(ball);
    if (icon) {
      const c = document.createElement('canvas'); c.width = 128; c.height = 128;
      const cx = c.getContext('2d');
      cx.font = '92px serif'; cx.textAlign = 'center'; cx.textBaseline = 'middle';
      cx.fillText(icon, 64, 70);
      const faceMesh = new THREE.Sprite(new THREE.SpriteMaterial({
        map: new THREE.CanvasTexture(c), transparent: true, depthTest: false,
      }));
      faceMesh.scale.set(0.68, 0.68, 1);
      faceMesh.renderOrder = 5;
      grp.add(faceMesh);
    }
    sc.add(grp);
    const img = snapshotToImage(sc, cam);
    disposePreviewScene(sc);
    return img;
  } catch (e) {
    return shopFallbackBox(icon || '⚪');
  }
}
function animateShopPreviews() {
  // No live loop now: previews are static photos, nothing to redraw.
  // I keep this function so the SHOP screen code keeps working.
}

async function renderShop() {
  $('shopCoins').textContent = '🪙 ' + S.coins + ' coins   •   💎 ' + S.diamonds + ' diamonds';
  const list = $('shopList');
  list.innerHTML = '';
  disposeShopPreviews();

  for (const skin of S.skins) {
    const owned = S.ownedSkins.includes(skin.id);
    const selected = S.selectedSkin === skin.id;
    const isDiamond = skin.currency === 'diamond';
    const balance = isDiamond ? S.diamonds : S.coins;
    const icon = isDiamond ? '💎' : '🪙';
    const card = document.createElement('div');
    card.className = 'shopCard' + (selected ? ' selected' : '');
    const preview = createShopPreviewCanvas(skin.id, isDiamond ? 0x7dd3fc : 0xf5c93b);
    preview.className += ' shopPreview';
    const info = document.createElement('div');
    info.className = 'shopInfo';
    info.innerHTML = '<div class="name">' + skin.name + '</div><div class="desc">' + skin.desc + '</div>';
    const btn = document.createElement('button');
    btn.className = 'shopBtnSmall';
    if (selected) {
      btn.textContent = 'Selected'; btn.style.background = '#3f9a6b'; btn.style.color = '#fff'; btn.disabled = true;
    } else if (owned) {
      btn.textContent = 'Select'; btn.style.background = '#50556a'; btn.style.color = '#fff';
      btn.addEventListener('click', async () => { await api('/api/shop/select-skin', { skin_id: skin.id }); renderShop(); });
    } else {
      btn.textContent = skin.cost + ' ' + icon;
      btn.style.background = isDiamond ? '#7dd3fc' : '#f5c93b'; btn.style.color = '#1b1f2a';
      if (balance < skin.cost) btn.style.opacity = '0.55';
      btn.addEventListener('click', async () => {
        const d = await api('/api/shop/buy-skin', { skin_id: skin.id });
        if (!d.ok) alert(d.error || 'Cannot buy');
        renderShop();
      });
    }
    card.appendChild(preview); card.appendChild(info); card.appendChild(btn);
    list.appendChild(card);
  }

  // Ball faces first, abilities last: faces change the player look,
  // abilities are used up during a level, so their note sits above them.
  const faceHeader = document.createElement('div');
  faceHeader.style.cssText = 'color:#f5c93b; font-weight:bold; margin:14px 0 4px; text-align:left; font-size:0.95em;';
  faceHeader.textContent = 'BALL FACES (your player ball wears this)';
  list.appendChild(faceHeader);

  for (const emo of (S.emojis || [])) {
    const owned = (S.ownedEmojis || ['none']).includes(emo.id);
    const selected = S.selectedEmoji === emo.id;
    const card = document.createElement('div');
    card.className = 'shopCard' + (selected ? ' selected' : '');
    // 3D preview: mini white ball wearing this face (or plain ball for No Face).
    const preview = createFacePreviewCanvas(emo.id === 'none' ? '' : emo.icon);
    preview.className += ' shopPreview';
    const info = document.createElement('div');
    info.className = 'shopInfo';
    info.innerHTML = '<div class="name">' + emo.name + '</div><div class="desc">' + emo.desc + '</div>';
    const btn = document.createElement('button');
    btn.className = 'shopBtnSmall';
    if (selected) {
      btn.textContent = 'Wearing'; btn.style.background = '#3f9a6b'; btn.style.color = '#fff'; btn.disabled = true;
    } else if (owned) {
      btn.textContent = 'Wear'; btn.style.background = '#50556a'; btn.style.color = '#fff';
      btn.addEventListener('click', async () => {
        await api('/api/shop/select-emoji', { emoji_id: emo.id });
        applyPlayerEmoji(); renderShop();
      });
    } else {
      btn.textContent = emo.cost === 0 ? 'Free' : (emo.cost + ' 🪙');
      btn.style.background = '#f5c93b'; btn.style.color = '#1b1f2a';
      if (S.coins < emo.cost) btn.style.opacity = '0.55';
      btn.addEventListener('click', async () => {
        const d = await api('/api/shop/buy-emoji', { emoji_id: emo.id });
        if (!d.ok) { alert(d.error || 'Cannot buy'); return; }
        applyPlayerEmoji(); renderShop();
      });
    }
    card.appendChild(preview); card.appendChild(info); card.appendChild(btn);
    list.appendChild(card);
  }

  const abHeader = document.createElement('div');
  abHeader.style.cssText = 'color:#f5c93b; font-weight:bold; margin:14px 0 4px; text-align:left; font-size:0.95em;';
  abHeader.textContent = 'ABILITIES (used during a level)';
  list.appendChild(abHeader);

  for (const ab of S.abilities) {
    const owned = S.abilityCounts[ab.id] || 0;
    const card = document.createElement('div');
    card.className = 'shopCard';
    const preview = document.createElement('div');
    preview.className = 'shopPreview';
    preview.style.cssText = 'background:#31405c;display:flex;align-items:center;justify-content:center;font-size:1.6em;';
    preview.textContent = ab.icon;
    const info = document.createElement('div');
    info.className = 'shopInfo';
    info.innerHTML = '<div class="name">' + ab.name + (owned > 0 ? ' (x' + owned + ' owned)' : '') +
                     '</div><div class="desc">' + ab.desc + '</div>';
    const btn = document.createElement('button');
    btn.className = 'shopBtnSmall';
    btn.textContent = 'Buy ' + ab.cost + ' 🪙';
    btn.style.background = '#f5c93b'; btn.style.color = '#1b1f2a';
    if (S.coins < ab.cost) btn.style.opacity = '0.55';
    btn.addEventListener('click', async () => {
      const d = await api('/api/shop/buy-ability', { ability_id: ab.id });
      if (!d.ok) alert(d.error || 'Cannot buy');
      renderShop();
    });
    card.appendChild(preview); card.appendChild(info); card.appendChild(btn);
    list.appendChild(card);
  }
}

async function renderSavedUsers() {
  const box = $('savedUsersList');
  if (!box) return;
  box.innerHTML = '';
  try {
    const res = await fetch('/api/users');
    const data = await res.json();
    (data.users || []).forEach((u) => {
      const b = document.createElement('button');
      b.className = 'shopBtnSmall';
      b.style.cssText = 'background:#50556a;color:#fff;padding:8px 14px;';
      b.textContent = '👤 ' + u;
      // Clicking a name only fills the box — login needs the password + Login button.
      // So nobody can open someone else's account by just clicking their name.
      b.addEventListener('click', () => {
        $('nameInput').value = u;
        $('nameError').textContent = 'Now type your password above and press Login.';
        const pw = $('passwordInput');
        if (pw) pw.focus();
      });
      box.appendChild(b);
    });
  } catch (e) {}
}

function renderProfile() {
  const total = S.levels.length;
  const rows = [
    ['Name', S.username || '—'],
    ['Coins', '🪙 ' + S.coins],
    ['Diamonds', '💎 ' + S.diamonds],
    ['Levels Completed (total)', S.levelsCompletedCount],
    ['Easy Progress', S.unlockedLevel.EASY + ' / ' + total + ' unlocked'],
    ['Medium Progress', S.unlockedLevel.MEDIUM + ' / ' + total + ' unlocked'],
    ['Hard Progress', S.unlockedLevel.HARD + ' / ' + total + ' unlocked'],
    ['Skins Owned', S.ownedSkins.length + ' / ' + S.skins.length],
  ];
  $('profileCard').innerHTML = rows.map((r) =>
    '<div class="profileRow"><span>' + r[0] + '</span><span>' + r[1] + '</span></div>').join('');
}

// Browsers block music from playing alone, so I start it on the
// first click or key press. The Music toggle in Settings pauses it.
function applyMusicSetting() {
  const audio = $('bgMusic');
  if (!audio) return;
  if (S && S.musicOn) {
    audio.volume = 0.5;
    const p = audio.play();
    if (p && p.catch) p.catch(() => {});
  } else {
    audio.pause();
  }
}
['click', 'keydown', 'touchstart'].forEach((ev) =>
  window.addEventListener(ev, () => { applyMusicSetting(); }, { once: false, passive: true })
);

function renderSettings() {
  $('musicToggle').classList.toggle('on', S.musicOn);
  $('vibrationToggle').classList.toggle('on', S.vibrationOn);
  applyMusicSetting();
}

function renderDailyReward() {
  const day = S.dailyRewardDay;
  const claimBtn = $('dailyRewardClaimBtn');
  if (S.dailyRewardPending) {
    $('dailyRewardSub').textContent = 'Day ' + day + ' of 7 — come back tomorrow to keep your streak!';
    claimBtn.style.display = 'inline-block';
  } else {
    $('dailyRewardSub').textContent = 'Day ' + day + ' of 7 already claimed today — come back tomorrow!';
    claimBtn.style.display = 'none';
  }
  const daysDiv = $('dailyRewardDays');
  daysDiv.innerHTML = '';
  S.dailyRewards.forEach((r) => {
    const box = document.createElement('div');
    const claimed = !S.dailyRewardPending && r.day === day;
    box.className = 'dayBox' + (r.day < day || claimed ? ' claimed' : '') + (r.day === day && S.dailyRewardPending ? ' today' : '');
    const icon = r.type === 'ability' ? '✨' : '🪙';
    box.innerHTML = '<div class="dayIcon">' + icon + '</div><div class="dayNum">Day ' + r.day + '</div>';
    daysDiv.appendChild(box);
  });
  const reward = S.dailyRewards[day - 1];
  $('dailyRewardBig').textContent = reward.type === 'coin' ? ('🪙 +' + reward.amount) : '✨ Free Ability!';
}

function renderAbilityBar() {
  for (const ab of S.abilities) {
    const btn = $('abilityBtn-' + ab.id);
    if (!btn) continue;
    const count = S.abilityCounts[ab.id] || 0;
    btn.innerHTML = ab.icon + '<span class="abilityCount">' + count + '</span>';
    if (ab.id === 'lifeplus') {
      const disabled = count <= 0 || run.lives >= 5;
      btn.classList.toggle('disabled', disabled);
      btn.classList.toggle('running', !disabled);
    } else {
      btn.classList.toggle('disabled', count <= 0);
      btn.classList.toggle('running', isAbilityActive(ab.id));
    }
    btn.title = ab.name + ' — ' + ab.desc;
  }
}

async function activateAbility(id) {
  if (run.screen !== 'PLAYING' || run.isTraining) return;
  if (id === 'lifeplus') {
    if ((S.abilityCounts.lifeplus || 0) <= 0 || run.lives >= 5) return;
    const d = await api('/api/ability/consume', { ability_id: 'lifeplus' });
    if (d.ok) { run.lives += 1; updateHUD(); renderAbilityBar(); }
    return;
  }
  if ((S.abilityCounts[id] || 0) <= 0) return;
  if (run.activeAbility && performance.now() < run.activeAbility.endsAt) return;
  const ab = S.abilities.find((a) => a.id === id);
  const d = await api('/api/ability/consume', { ability_id: id });
  if (d.ok) {
    run.activeAbility = { id, endsAt: performance.now() + ab.duration };
    renderAbilityBar();
  }
}

// I connect every button on every screen to its action here.
// Most buttons just change the screen, some call the Python
// server first (buy, claim reward, continue) and then refresh.
document.querySelectorAll('#screen-START button[data-diff]').forEach((btn) => {
  btn.addEventListener('click', () => { run.difficulty = btn.dataset.diff; setScreen('LEVEL_SELECT'); });
});
$('backBtn').addEventListener('click', () => setScreen('START'));
$('shopBtn').addEventListener('click', () => setScreen('SHOP'));
$('shopBackBtn').addEventListener('click', () => setScreen('START'));
$('trainingBtn').addEventListener('click', () => setScreen('TRAINING'));
$('trainingGoBtn').addEventListener('click', startTraining);
$('trainingIntroBackBtn').addEventListener('click', () => setScreen('START'));
$('trainingDoneBtn').addEventListener('click', () => setScreen(S.dailyRewardPending ? 'DAILY_REWARD' : 'START'));
$('profileBtn').addEventListener('click', () => setScreen('PROFILE'));
$('profileBackBtn').addEventListener('click', () => setScreen('START'));
$('logoutBtn').addEventListener('click', async () => {
  await api('/api/logout', {});
  $('nameInput').value = '';
  if ($('passwordInput')) $('passwordInput').value = '';
  S = (await api('/api/state')).state || S;
  setScreen('NAME_ENTRY');
  renderSavedUsers();
});
$('settingsBtn').addEventListener('click', () => setScreen('SETTINGS'));
$('settingsBackBtn').addEventListener('click', () => setScreen('START'));
$('musicToggle').addEventListener('click', async () => { await api('/api/settings', { musicOn: !S.musicOn }); renderSettings(); applyMusicSetting(); });
$('vibrationToggle').addEventListener('click', async () => { await api('/api/settings', { vibrationOn: !S.vibrationOn }); renderSettings(); });
$('dailyRewardBtn').addEventListener('click', async () => { S = (await api('/api/state')).state || S; setScreen('DAILY_REWARD'); });
$('dailyRewardBackBtn').addEventListener('click', () => setScreen('START'));
$('dailyRewardClaimBtn').addEventListener('click', async () => {
  const d = await api('/api/daily-reward/claim', {});
  if (!d.ok) alert(d.error || 'Already claimed');
  setScreen('START');
});
$('abilityBtn-colorbomb').addEventListener('click', () => activateAbility('colorbomb'));
$('abilityBtn-slowmo').addEventListener('click', () => activateAbility('slowmo'));
$('abilityBtn-lifeplus').addEventListener('click', () => activateAbility('lifeplus'));
function goToStart() {
  setScreen(!S.seenTraining ? 'TRAINING' : (S.dailyRewardPending ? 'DAILY_REWARD' : 'START'));
}
$('nameContinueBtn').addEventListener('click', async () => {
  const d = await api('/api/name', { name: $('nameInput').value, password: $('passwordInput').value });
  if (!d.ok) { $('nameError').textContent = d.error; return; }
  $('nameError').textContent = '';
  $('passwordInput').value = '';
  goToStart();
});
$('nameLoginBtn').addEventListener('click', async () => {
  const d = await api('/api/login', { name: $('nameInput').value, password: $('passwordInput').value });
  if (!d.ok) { $('nameError').textContent = d.error; return; }
  $('nameError').textContent = '';
  $('passwordInput').value = '';
  goToStart();
});
$('nameInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('nameLoginBtn').click(); });
$('passwordInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('nameLoginBtn').click(); });
$('nextLevelBtn').addEventListener('click', () => {
  if (run.currentLevel + 1 < S.levels.length) startLevel(run.currentLevel + 1);
});
$('lcMenuBtn').addEventListener('click', () => setScreen('LEVEL_SELECT'));
$('continueBtn').addEventListener('click', async () => {
  const d = await api('/api/continue', {});
  if (!d.ok) { alert(d.error); return; }
  run.lives = 1;
  run.ending = false;
  run.activeAbility = null;
  run.playerX = 0;
  playerGroup.position.x = 0;
  clearCubes();
  run.lastSpawn = performance.now();
  setScreen('PLAYING');
});
$('retryBtn').addEventListener('click', () => { run.ending = false; startLevel(run.currentLevel); });
$('goMenuBtn').addEventListener('click', () => { run.ending = false; setScreen('LEVEL_SELECT'); });

// Main loop: I redraw the 3D scene every frame. During PLAYING
// I also move the player and the blocks. On page load (boot)
// I ask the server for my saved data and open the right screen.
function animate() {
  requestAnimationFrame(animate);
  if (S && run.screen === 'PLAYING') {
    if (keys.left) run.playerX = Math.max(-PLATFORM_HALF_WIDTH, run.playerX - 0.12);
    if (keys.right) run.playerX = Math.min(PLATFORM_HALF_WIDTH, run.playerX + 0.12);
    updatePlaying();
    if (!run.isTraining) renderAbilityBar();
  }
  camera.position.x = Math.sin(performance.now() * 0.0002) * 0.5;
  camera.lookAt(0, 2, -2);
  renderer.render(scene, camera);
}

(async function boot() {
  const data = await api('/api/state');
  S = data.state || data;
  run.difficulty = 'EASY';
  run.lives = S.startingLives;
  applyPlayerEmoji();
  setScreen(S.initialScreen || 'START');
  if ((S.initialScreen || 'START') === 'NAME_ENTRY') renderSavedUsers();
  applyMusicSetting();
  animate();
})();
