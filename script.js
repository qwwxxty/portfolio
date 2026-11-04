/* =========================================================================
   Artur Kulik — immersive portfolio
   One ES module, no build step.

   1. Core: works in every mode (no WebGL, reduced motion, CDN down):
      timeline navigation, reel player, compare slider, layers, copy email.
   2. Immersive layer: imported dynamically (three.js + GSAP). The html gets
      .is-immersive only after WebGL2 and both libraries are confirmed.
   ========================================================================= */

/* ---------- Video slots for footage that is not shot yet ----------------
   Put files in assets/videos/ (see VIDEOS.md, encode.sh) and flip `ready`.
   While a slot is not ready the scene uses graphics drawn in code, and no
   request is made, so a missing file never shows up as a 404. */
const VIDEO_SLOTS = {
  hero:   { ready: false, mp4: 'assets/videos/hero.mp4',   webm: 'assets/videos/hero.webm' },   // 01 Slate background, loops
  scrub:  { ready: false, mp4: 'assets/videos/scrub.mp4',  webm: 'assets/videos/scrub.webm' },  // 04 Layers backdrop, follows the scroll
  export: { ready: false, mp4: 'assets/videos/export.mp4', webm: 'assets/videos/export.webm' }, // 06 Export background, loops
};

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, v) => { const t = clamp((v - a) / (b - a)); return t * t * (3 - 2 * t); };
const pad = (n) => String(n).padStart(2, '0');

const root = document.documentElement;
const reduceMQ = matchMedia('(prefers-reduced-motion: reduce)');
const fineMQ = matchMedia('(hover: hover) and (pointer: fine)');
const wideMQ = matchMedia('(min-width: 900px)');
const params = new URLSearchParams(location.search);

const store = (kind) => ({
  get(k) { try { return window[kind].getItem(k); } catch { return null; } },
  set(k, v) { try { window[kind].setItem(k, v); } catch { /* storage blocked */ } },
});
const session = store('sessionStorage');

// 9 reels, 403.98 s in total; the timeline runs 00:00:00:00 → 00:06:44:00 at 24 fps.
const FPS = 24;
const TOTAL_FRAMES = Math.round(403.98 * FPS);
const smpte = (frames) => {
  const f = Math.round(frames);
  const s = Math.floor(f / FPS);
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}:${pad(f % FPS)}`;
};
const clock = (sec) => `${Math.floor(sec / 60)}:${pad(Math.floor(sec % 60))}`;

const state = {
  immersive: false,
  suspended: false, // the player is open
  world: null,
  vw: root.clientWidth,
  vh: window.innerHeight,
};

/* =========================================================================
   1. CORE
   ========================================================================= */

/* ---------- Silent preview playback (HTML videos) ---------- */
const wanted = new Set();
const previewsOff = () => reduceMQ.matches;
function applyVideo(v) {
  if (wanted.has(v) && !state.suspended && !previewsOff()) {
    if (!v.getAttribute('src')) v.src = v.dataset.src;
    const p = v.play();
    if (p) p.catch(() => {});
  } else if (!v.paused) {
    v.pause();
  }
}
const setWanted = (v, on) => {
  if (!v) return;
  if (on) wanted.add(v); else wanted.delete(v);
  applyVideo(v);
};
const applyAll = () => $$('video[data-src]').forEach(applyVideo);
$$('video[data-src]').forEach((v) => {
  let retries = 0;
  v.addEventListener('playing', () => { retries = 0; v.classList.add('is-playing'); });
  v.addEventListener('error', () => {
    v.classList.remove('is-playing');
    if (retries >= 2 || !v.getAttribute('src')) return;
    retries += 1;
    setTimeout(() => { v.load(); applyVideo(v); }, retries * 1000);
  });
});

/* ---------- Scenes: geometry shared by the timeline and the 3D layer ---------- */
const sceneEls = $$('[data-scene]');
const SCENE_NAMES = ['Slate', 'Selects', 'Two looks', 'Layers', 'Rate card', 'Export'];
const scenes = sceneEls.map((el) => ({ el, pin: $('.scene__pin', el), top: 0, h: 0, start: 0, end: 0 }));
let docRange = 1;

function measureScenes() {
  state.vw = root.clientWidth;
  state.vh = window.innerHeight;
  const y = window.scrollY;
  scenes.forEach((s) => {
    const r = s.el.getBoundingClientRect();
    s.top = r.top + y;
    s.h = r.height;
    s.start = s.top;
    s.end = Math.max(s.top, s.top + s.h - state.vh);
    s.sticky = Boolean(s.pin) && getComputedStyle(s.pin).position === 'sticky';
  });
  docRange = Math.max(1, root.scrollHeight - state.vh);
}

/** Continuous scene coordinate: integer while a scene holds, fractional between scenes. */
function sceneCoord(y) {
  const n = scenes.length;
  if (y <= scenes[0].end) return 0;
  for (let i = 0; i < n - 1; i += 1) {
    const a = scenes[i].end;
    const b = scenes[i + 1].start;
    if (y < a) return i;
    if (y <= b) return i + (b > a ? (y - a) / (b - a) : 1);
    if (y <= scenes[i + 1].end) return i + 1;
  }
  return n - 1;
}
const localProgress = (i, y) => {
  const s = scenes[i];
  return s.end > s.start ? clamp((y - s.start) / (s.end - s.start)) : (y >= s.start ? 1 : 0);
};

/* ---------- Timeline navigation (fixed at the bottom) ---------- */
const tl = {
  lane: $('[data-tl-lane]'),
  head: $('[data-tl-head]'),
  tc: $('[data-tc]'),
  clips: $$('[data-tl-clip]'),
  items: $$('.tl__clips li'),
  sceneN: $('[data-scene-n]'),
  sceneName: $('[data-scene-name]'),
  active: -1,
  text: '',
};
function layoutTimeline() {
  // Each clip is as long as its scene, like clips on a real timeline.
  scenes.forEach((s, i) => { if (tl.items[i]) tl.items[i].style.setProperty('--w', (s.h / state.vh).toFixed(3)); });
  tl.lane.style.setProperty('--lane-w', `${tl.lane.clientWidth}px`);
}
function renderTimeline(y) {
  const p = clamp(y / docRange);
  tl.lane.style.setProperty('--p', p.toFixed(5));
  const text = smpte(p * TOTAL_FRAMES);
  if (text !== tl.text) { tl.tc.textContent = text; tl.text = text; }
  let active = 0;
  scenes.forEach((s, i) => { if (y + state.vh * 0.5 >= s.top) active = i; });
  if (active !== tl.active) {
    tl.active = active;
    tl.clips.forEach((c, i) => {
      c.classList.toggle('is-active', i === active);
      if (i === active) c.setAttribute('aria-current', 'step'); else c.removeAttribute('aria-current');
    });
    tl.sceneN.textContent = pad(active + 1);
    tl.sceneName.textContent = SCENE_NAMES[active];
  }
}
// Drag the playhead to scrub the page; a plain click still follows the clip link.
(function scrubTimeline() {
  let downX = 0;
  let dragging = false;
  let pointer = null;
  const scrubTo = (e) => {
    const r = tl.lane.getBoundingClientRect();
    const p = clamp((e.clientX - r.left) / r.width);
    window.scrollTo({ top: p * docRange, behavior: 'instant' });
  };
  tl.lane.addEventListener('pointerdown', (e) => {
    if (e.button) return;
    downX = e.clientX; dragging = false; pointer = e.pointerId;
  });
  tl.lane.addEventListener('pointermove', (e) => {
    if (pointer !== e.pointerId) return;
    if (!dragging && Math.abs(e.clientX - downX) > 6) {
      dragging = true;
      tl.lane.setPointerCapture(e.pointerId);
      root.classList.add('is-scrubbing');
    }
    if (dragging) scrubTo(e);
  });
  const end = (e) => {
    if (pointer !== e.pointerId) return;
    pointer = null;
    if (dragging) {
      root.classList.remove('is-scrubbing');
      const swallow = (ev) => { ev.preventDefault(); ev.stopPropagation(); };
      tl.lane.addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => tl.lane.removeEventListener('click', swallow, { capture: true }), 50);
    }
    dragging = false;
  };
  tl.lane.addEventListener('pointerup', end);
  tl.lane.addEventListener('pointercancel', end);
})();

/* ---------- Text splitting (words, for reveals) ---------- */
function splitWords(el) {
  const words = [];
  const walk = (node) => {
    [...node.childNodes].forEach((child) => {
      if (child.nodeType === Node.TEXT_NODE) {
        const frag = document.createDocumentFragment();
        child.textContent.split(/(\s+)/).forEach((part) => {
          if (!part) return;
          if (/^\s+$/.test(part)) { frag.append(' '); return; }
          const w = document.createElement('span');
          w.className = 'w';
          const inner = document.createElement('span');
          inner.className = 'w__in';
          inner.textContent = part;
          w.append(inner);
          frag.append(w);
          words.push(inner);
        });
        child.replaceWith(frag);
      } else if (child.nodeType === Node.ELEMENT_NODE && child.tagName !== 'BR') {
        walk(child);
      }
    });
  };
  walk(el);
  return words;
}

/* ---------- Selects: active reel ---------- */
const reelItems = $$('[data-reels] .reel');
const bin = $('[data-bin]');
let activeReel = -1;
const reelListeners = new Set();
function activateReel(i) {
  if (i === activeReel) return;
  const prev = activeReel;
  activeReel = i;
  reelItems.forEach((el, j) => el.classList.toggle('is-active', j === i));
  $$('button', bin).forEach((b, j) => b.classList.toggle('is-active', j === i));
  reelListeners.forEach((fn) => fn(i, prev));
}
reelItems.forEach((li, i) => {
  const b = document.createElement('button');
  b.type = 'button';
  b.tabIndex = -1;
  b.className = 'tc';
  b.textContent = pad(i + 1);
  b.addEventListener('click', () => scrollToReel(i, true));
  bin.append(b);
});
function reelScrollY(i) {
  const s = scenes[1];
  const p = 0.06 + (i / (reelItems.length - 1)) * 0.88;
  return s.start + p * (s.end - s.start);
}
function scrollToReel(i, smoothScroll) {
  window.scrollTo({ top: reelScrollY(i), behavior: smoothScroll && !reduceMQ.matches ? 'smooth' : 'instant' });
}
// Keyboard: focusing a hidden reel's button brings that reel to the front.
$('[data-reels]').addEventListener('focusin', (e) => {
  if (!state.immersive) return;
  const i = reelItems.findIndex((li) => li.contains(e.target));
  if (i >= 0 && i !== activeReel) scrollToReel(i, false);
});

// Static mode: hover / focus plays the silent preview; on touch, the card in view plays.
reelItems.forEach((li) => {
  const link = $('.reel__poster', li);
  const video = $('video', link);
  const on = () => { if (!state.immersive) setWanted(video, true); };
  const off = () => setWanted(video, false);
  if (fineMQ.matches) { link.addEventListener('pointerenter', on); link.addEventListener('pointerleave', off); }
  link.addEventListener('focus', on);
  link.addEventListener('blur', off);
});
const touchReelIO = !fineMQ.matches ? new IntersectionObserver((entries) => {
  entries.forEach((e) => setWanted($('video', e.target), e.isIntersecting && !state.immersive));
}, { threshold: 0.7 }) : null;
if (touchReelIO) $$('.reel__poster').forEach((el) => touchReelIO.observe(el));

/* ---------- Layers: active layer + monitor ---------- */
const layerItems = $$('[data-layer]');
const layerClips = $$('[data-layer-clip]');
const layerVideos = layerClips.map((c) => $('video', c));
const layerCount = $('[data-layer-count]');
const layerTicks = $$('.layers__ticks i');
let activeLayer = 0;
let monitorVisible = false;
const syncLayerVideos = () => layerVideos.forEach((v, i) => setWanted(v, monitorVisible && i === activeLayer));
function activateLayer(i) {
  if (i === activeLayer) return;
  activeLayer = i;
  layerItems.forEach((el, j) => el.classList.toggle('is-active', j === i));
  layerClips.forEach((el, j) => el.classList.toggle('is-active', j === i));
  layerCount.textContent = pad(i + 1);
  syncLayerVideos();
}
new IntersectionObserver(([e]) => { monitorVisible = e.isIntersecting; syncLayerVideos(); }).observe($('.monitor__screen'));
const layerIO = new IntersectionObserver((entries) => {
  if (state.immersive) return;
  entries.forEach((e) => { if (e.isIntersecting) activateLayer(layerItems.indexOf(e.target)); });
}, { rootMargin: '-45% 0px -45% 0px' });
layerItems.forEach((el) => layerIO.observe(el));

/* ---------- Compare slider (Notebook / Noir Gold) ---------- */
const compare = (() => {
  const box = $('[data-compare]');
  const a = $('[data-compare-a]', box);
  const b = $('[data-compare-b]', box);
  const range = $('.compare__range', box);
  const api = { box, pos: 50, visible: false };
  let touched = reduceMQ.matches;
  let dragging = false;
  let startedAt = 0;

  const setPos = (v) => {
    api.pos = v;
    box.style.setProperty('--pos', `${v.toFixed(2)}%`);
    range.value = String(Math.round(v));
  };
  const fromPointer = (e) => {
    const r = box.getBoundingClientRect();
    setPos(clamp((e.clientX - r.left) / r.width) * 100);
  };
  box.addEventListener('pointerdown', (e) => {
    touched = true;
    if (e.pointerType === 'mouse') {
      dragging = true;
      box.classList.add('is-dragging');
      box.setPointerCapture(e.pointerId);
      fromPointer(e);
    } else {
      dragging = 'touch';
    }
  });
  box.addEventListener('pointermove', (e) => { if (dragging) fromPointer(e); });
  const end = () => { dragging = false; box.classList.remove('is-dragging'); };
  box.addEventListener('pointerup', (e) => { if (dragging === 'touch') fromPointer(e); end(); });
  box.addEventListener('pointercancel', end);
  box.addEventListener('lostpointercapture', end);
  range.addEventListener('input', () => { touched = true; setPos(Number(range.value)); });

  // Notebook follows Noir Gold; both clips share one timeline.
  a.addEventListener('ended', () => { a.currentTime = 0; b.currentTime = 0; applyVideo(a); applyVideo(b); });

  function loop(t) {
    if (!api.visible) return;
    if (!startedAt) startedAt = t;
    if (!touched) setPos(50 + Math.sin((t - startedAt) / 1500) * 30);
    if (!a.paused && !b.paused && a.readyState > 1 && b.readyState > 1) {
      const drift = a.currentTime - b.currentTime;
      if (Math.abs(drift) > 0.3) { b.currentTime = a.currentTime; b.playbackRate = 1; } else { b.playbackRate = 1 + clamp(drift * 0.8, -0.08, 0.08); }
    }
    requestAnimationFrame(loop);
  }
  new IntersectionObserver(([e]) => {
    api.visible = e.isIntersecting;
    setWanted(a, api.visible);
    setWanted(b, api.visible);
    if (api.visible) { startedAt = 0; requestAnimationFrame(loop); }
  }, { threshold: 0.2 }).observe(box);
  return api;
})();

/* ---------- Copy email ---------- */
(function copyEmail() {
  const btn = $('[data-copy]');
  const label = $('[data-copy-label]', btn);
  const status = $('[data-copy-status]');
  btn.addEventListener('click', async () => {
    const text = btn.dataset.copy;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      window.prompt('Copy this email:', text);
      return;
    }
    label.textContent = 'Copied';
    status.textContent = 'Email copied';
    setTimeout(() => { label.textContent = 'Copy email'; status.textContent = ''; }, 2000);
  });
})();

/* ---------- Player (dialog with sound) ---------- */
const player = (() => {
  const dlg = $('#player');
  const video = $('[data-p-video]', dlg);
  const frameEl = $('[data-p-frame]', dlg);
  const seek = $('[data-p-seek]', dlg);
  const timeEl = $('[data-p-time]', dlg);
  const toggleBtn = $('[data-p-toggle]', dlg);
  const toggleIcon = $('[data-p-toggle-icon]', dlg);
  const muteBtn = $('[data-p-mute]', dlg);
  const muteIcon = $('[data-p-mute-icon]', dlg);
  const bg = $('[data-p-bg]', dlg);
  const errorEl = $('[data-p-error]', dlg);
  const directLink = $('[data-p-direct]', dlg);

  const reels = $$('[data-reel]').map((el) => ({
    slug: el.dataset.reel,
    title: el.dataset.title,
    desc: $('[data-desc]', el).textContent,
    meta: $('[data-meta]', el).textContent,
  }));
  const srcOf = (r) => `assets/media/reels/${r.slug}.mp4`;
  const posterOf = (r) => `assets/media/posters/${r.slug}.jpg`;

  let index = 0;
  let openedIndex = 0;
  let origin = null;
  let originSlug = '';
  let scrubbing = false;
  let rafId = 0;
  let closing = false;

  function load(i, autoplay = true) {
    index = (i + reels.length) % reels.length;
    const r = reels[index];
    $('[data-p-index]', dlg).textContent = `${pad(index + 1)} / ${pad(reels.length)}`;
    $('[data-p-title]', dlg).textContent = r.title;
    $('[data-p-desc]', dlg).textContent = r.desc;
    $('[data-p-meta]', dlg).textContent = r.meta;
    bg.src = posterOf(r);
    directLink.href = srcOf(r);
    errorEl.hidden = true;
    video.poster = posterOf(r);
    video.src = srcOf(r);
    seek.value = 0;
    seek.style.setProperty('--p', '0%');
    dlg.classList.add('is-buffering');
    if (autoplay) playVideo();
  }
  function playVideo() {
    const p = video.play();
    if (p) {
      p.catch((err) => {
        if (err.name === 'NotAllowedError' && !video.muted) {
          video.muted = true;
          renderMute();
          video.play().catch(() => {});
        }
      });
    }
  }
  function renderToggle() {
    const paused = video.paused;
    toggleIcon.setAttribute('href', paused ? '#i-play' : '#i-pause');
    toggleBtn.setAttribute('aria-label', paused ? 'Play' : 'Pause');
  }
  function renderMute() {
    muteIcon.setAttribute('href', video.muted ? '#i-mute' : '#i-sound');
    muteBtn.setAttribute('aria-label', video.muted ? 'Unmute' : 'Mute');
  }
  const togglePlay = () => { if (video.paused) playVideo(); else video.pause(); };
  const toggleMute = () => { video.muted = !video.muted; renderMute(); };
  const nudge = (s) => { if (video.duration) video.currentTime = clamp(video.currentTime + s, 0, video.duration - 0.05); };

  function renderTime() {
    const d = video.duration || 0;
    const t = video.currentTime || 0;
    if (!scrubbing && d) {
      seek.value = String(Math.round((t / d) * 1000));
      seek.style.setProperty('--p', `${(t / d) * 100}%`);
    }
    const label = `${clock(t)} / ${d ? clock(Math.round(d)) : '–:––'}`;
    if (timeEl.textContent !== label) timeEl.textContent = label;
  }
  function timeLoop() { renderTime(); rafId = requestAnimationFrame(timeLoop); }

  // Where the frame sits over its card: a DOM element, or a glass card in the 3D scene.
  function originPose() {
    if (state.immersive && state.world && originSlug) {
      const pose = state.world.cardPose(originSlug);
      if (pose) return pose;
    }
    if (!origin || !origin.isConnected) return null;
    const r = origin.getBoundingClientRect();
    if (!r.width) return null;
    return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, width: r.width, angle: 0 };
  }
  // The video always fills the frame's width, so matching widths also works on phones.
  function poseTransform(pose) {
    const to = frameEl.getBoundingClientRect();
    const dx = pose.cx - (to.left + to.width / 2);
    const dy = pose.cy - (to.top + to.height / 2);
    return `translate(${dx}px,${dy}px) rotate(${pose.angle}deg) scale(${pose.width / to.width})`;
  }
  function flipFromOrigin() {
    if (reduceMQ.matches) return;
    const pose = originPose();
    if (!pose || !pose.width) return;
    frameEl.animate([{ transform: poseTransform(pose) }, { transform: 'none' }], { duration: 800, easing: 'cubic-bezier(.16,1,.3,1)' });
  }

  function open(slug, trigger) {
    const i = reels.findIndex((r) => r.slug === slug);
    if (i < 0) return;
    const poster = trigger && trigger.closest('.reel') ? $('.reel__poster', trigger.closest('.reel')) : null;
    origin = poster && poster.offsetWidth ? poster : (trigger && trigger.closest('[data-compare], .look') ? $('[data-compare]') : trigger);
    originSlug = trigger && trigger.closest('.reel') ? slug : '';
    state.suspended = true;
    applyAll();
    if (state.world) state.world.pause(true);
    root.classList.add('is-locked');
    video.muted = false;
    renderMute();
    dlg.classList.remove('is-closing');
    dlg.showModal();
    load(i);
    openedIndex = i;
    flipFromOrigin();
    requestAnimationFrame(() => { if (!closing) dlg.classList.add('is-open'); });
    cancelAnimationFrame(rafId);
    timeLoop();
  }

  function close() {
    if (closing || !dlg.open) return;
    closing = true;
    video.pause();
    state.suspended = false;
    if (state.world) state.world.pause(false);
    if (reduceMQ.matches) { dlg.close(); return; }
    frameEl.getAnimations().forEach((an) => an.cancel());
    dlg.classList.remove('is-open');
    dlg.classList.add('is-closing');
    applyAll();
    // After switching reels the card shows something else, so just fade away.
    const pose = index === openedIndex ? originPose() : null;
    const onScreen = pose && pose.width && pose.cy > 0 && pose.cy < state.vh && pose.cx > 0 && pose.cx < state.vw;
    const move = frameEl.animate(
      [{ transform: 'none' }, { transform: onScreen ? poseTransform(pose) : 'scale(.94)' }],
      { duration: onScreen ? 620 : 360, easing: 'cubic-bezier(.65,0,.2,1)', fill: 'forwards' },
    );
    const fade = frameEl.animate(
      [{ opacity: 1 }, { opacity: 0 }],
      { duration: onScreen ? 280 : 300, delay: onScreen ? 340 : 60, easing: 'linear', fill: 'forwards' },
    );
    Promise.all([move.finished, fade.finished]).catch(() => {}).then(() => { if (dlg.open) dlg.close(); });
  }

  dlg.addEventListener('close', () => {
    closing = false;
    dlg.classList.remove('is-open', 'is-closing');
    frameEl.getAnimations().forEach((an) => an.cancel());
    cancelAnimationFrame(rafId);
    video.pause();
    video.removeAttribute('src');
    video.load();
    root.classList.remove('is-locked');
    state.suspended = false;
    if (state.world) state.world.pause(false);
    applyAll();
  });
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(); });

  video.addEventListener('play', renderToggle);
  video.addEventListener('pause', renderToggle);
  video.addEventListener('ended', () => load(index + 1));
  ['waiting', 'loadstart'].forEach((ev) => video.addEventListener(ev, () => dlg.classList.add('is-buffering')));
  ['playing', 'canplay', 'pause', 'error'].forEach((ev) => video.addEventListener(ev, () => dlg.classList.remove('is-buffering')));
  video.addEventListener('error', () => { if (video.getAttribute('src')) errorEl.hidden = false; });
  video.addEventListener('click', togglePlay);

  toggleBtn.addEventListener('click', togglePlay);
  muteBtn.addEventListener('click', toggleMute);
  $('[data-p-prev]', dlg).addEventListener('click', () => load(index - 1));
  $('[data-p-next]', dlg).addEventListener('click', () => load(index + 1));
  $$('[data-player-close]', dlg).forEach((el) => el.addEventListener('click', close));

  seek.addEventListener('pointerdown', () => { scrubbing = true; });
  ['pointerup', 'pointercancel', 'change'].forEach((ev) => seek.addEventListener(ev, () => { scrubbing = false; }));
  seek.addEventListener('input', () => {
    const v = Number(seek.value) / 1000;
    seek.style.setProperty('--p', `${v * 100}%`);
    if (video.duration) video.currentTime = v * video.duration;
  });

  // Physical key codes, so the shortcuts work on any keyboard layout.
  dlg.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = e.target.tagName;
    switch (e.code) {
      case 'Space':
        if (tag === 'BUTTON' || tag === 'A') return;
        e.preventDefault(); togglePlay(); break;
      case 'KeyK': togglePlay(); break;
      case 'KeyJ': nudge(-5); break;
      case 'KeyL': nudge(5); break;
      case 'KeyM': toggleMute(); break;
      case 'ArrowLeft': if (tag !== 'INPUT') nudge(-5); break;
      case 'ArrowRight': if (tag !== 'INPUT') nudge(5); break;
      case 'ArrowUp': e.preventDefault(); load(index - 1); break;
      case 'ArrowDown': e.preventDefault(); load(index + 1); break;
      default:
    }
  });

  document.addEventListener('click', (e) => {
    const trigger = e.target.closest ? e.target.closest('[data-open]') : null;
    if (!trigger || e.metaKey || e.ctrlKey || e.shiftKey || e.button) return;
    e.preventDefault();
    open(trigger.dataset.open, trigger);
  });

  return { open };
})();

/* ---------- Static-mode scroll loop (timeline only) ---------- */
let staticTicking = false;
function onScrollStatic() {
  if (state.immersive || staticTicking) return;
  staticTicking = true;
  requestAnimationFrame(() => { staticTicking = false; renderTimeline(window.scrollY); });
}
addEventListener('scroll', onScrollStatic, { passive: true });

function relayout() {
  measureScenes();
  layoutTimeline();
  if (state.world) state.world.resize();
  renderTimeline(window.scrollY);
}
let resizeTimer = 0;
let lastW = root.clientWidth;
let lastH = window.innerHeight;
addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    // Ignore the mobile URL bar showing and hiding.
    const w = root.clientWidth;
    const h = window.innerHeight;
    if (w === lastW && Math.abs(h - lastH) < 120 && state.immersive) { measureScenes(); return; }
    lastW = w; lastH = h;
    relayout();
  }, 150);
});
addEventListener('load', relayout);
if (document.fonts && document.fonts.ready) document.fonts.ready.then(relayout);
relayout();

/* =========================================================================
   2. IMMERSIVE LAYER
   ========================================================================= */

const loader = {
  el: $('#loader'),
  tc: $('[data-loader-tc]'),
  bar: $('[data-loader-bar]'),
  pct: $('[data-loader-pct]'),
  step: $('[data-loader-step]'),
  target: 0,
  shown: 0,
  raf: 0,
  skipped: false,
};
function loaderProgress(p, step) {
  loader.target = Math.max(loader.target, p);
  if (step) loader.step.textContent = step;
  if (!loader.raf) {
    const tick = () => {
      loader.shown += (loader.target - loader.shown) * 0.12;
      if (loader.target - loader.shown < 0.002) loader.shown = loader.target;
      loader.bar.style.transform = `scaleX(${loader.shown.toFixed(4)})`;
      loader.pct.textContent = `${Math.round(loader.shown * 100)}%`;
      loader.tc.textContent = smpte(loader.shown * TOTAL_FRAMES);
      loader.raf = loader.shown < 1 ? requestAnimationFrame(tick) : 0;
    };
    loader.raf = requestAnimationFrame(tick);
  }
}
function hideLoader(instant) {
  if (!loader.el.isConnected) return;
  if (instant || reduceMQ.matches) { loader.el.remove(); root.classList.remove('boot'); return; }
  loader.el.classList.add('is-out');
  setTimeout(() => { loader.el.remove(); root.classList.remove('boot'); }, 1300);
}
$('[data-skip]').addEventListener('click', () => {
  loader.skipped = true;
  if (state.world && state.world.intro) state.world.intro.progress(1);
  hideLoader(true);
  root.classList.remove('boot');
  const first = $('#slate-title');
  if (first) { first.setAttribute('tabindex', '-1'); first.focus({ preventScroll: true }); }
});

function webgl2Available() {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2', { failIfMajorPerformanceCaveat: false });
    const ok = Boolean(gl);
    if (gl) { const ext = gl.getExtension('WEBGL_lose_context'); if (ext) ext.loseContext(); }
    return ok;
  } catch {
    return false;
  }
}
const withTimeout = (promise, ms, what) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} timed out`)), ms)),
]);

async function boot() {
  if (!root.classList.contains('boot') || reduceMQ.matches) { root.classList.remove('boot'); return; }
  if (!webgl2Available()) { root.classList.remove('boot'); hideLoader(true); return; }
  loaderProgress(0.04, 'Loading fonts');
  try {
    const fonts = (document.fonts ? Promise.all([
      document.fonts.load('400 100px "League Gothic"'),
      document.fonts.load('500 16px "Instrument Sans"'),
    ]) : Promise.resolve()).then(() => loaderProgress(0.16, 'Loading three.js'));
    const libs = Promise.all([
      import('three').then((m) => { loaderProgress(0.62, 'Loading GSAP'); return m; }),
      import('gsap').then((m) => { loaderProgress(0.2); return m; }),
      import('gsap/ScrollTrigger').then((m) => { loaderProgress(0.24); return m; }),
    ]);
    const [, [THREE, gsapMod, stMod]] = await withTimeout(Promise.all([fonts.catch(() => {}), libs]), 12000, 'libraries');
    const gsap = gsapMod.gsap || gsapMod.default;
    const { ScrollTrigger } = stMod;
    gsap.registerPlugin(ScrollTrigger);
    loaderProgress(0.74, 'Building scenes');
    await new Promise((r) => requestAnimationFrame(r));
    const world = createWorld(THREE, gsap, ScrollTrigger);
    loaderProgress(0.9, 'Compiling shaders');
    await world.warmUp();
    loaderProgress(1, 'Ready');
    // If the visitor skipped while we loaded and already scrolled away, stay static.
    if (loader.skipped && window.scrollY > 40) { world.dispose(); return; }
    enterImmersive(world, gsap, ScrollTrigger);
  } catch (err) {
    console.info('[portfolio] Static version shown:', err && err.message ? err.message : err);
    root.classList.remove('boot', 'is-immersive');
    hideLoader(true);
  }
}

function enterImmersive(world, gsap, ScrollTrigger) {
  state.world = world;
  state.immersive = true;
  root.classList.add('is-immersive');
  touchReelIO && $$('.reel__poster video').forEach((v) => setWanted(v, false));
  relayout();
  world.start();
  world.intro = runIntro(world, gsap, ScrollTrigger);
  reduceMQ.addEventListener('change', () => { if (reduceMQ.matches) location.reload(); });
}

function runIntro(world, gsap, ScrollTrigger) {
  const fast = loader.skipped || session.get('intro-seen');
  session.set('intro-seen', '1');

  // Scene text: words rise out of a mask, other blocks fade up, once, as they enter.
  const slateWords = splitWords($('.slate__tag'));
  $$('[data-split]').forEach((el) => {
    if (el.closest('.scene--slate')) return;
    const words = splitWords(el);
    gsap.set(words, { yPercent: 115, rotate: 4 });
    ScrollTrigger.create({
      trigger: el,
      start: 'top 88%',
      once: true,
      onEnter: () => gsap.to(words, { yPercent: 0, rotate: 0, duration: 1.15, ease: 'expo.out', stagger: 0.055 }),
    });
  });
  $$('[data-reveal]').forEach((el) => {
    if (el.closest('.scene--slate')) return;
    gsap.set(el, { opacity: 0, y: 26 });
    ScrollTrigger.create({
      trigger: el,
      start: 'top 92%',
      once: true,
      onEnter: () => gsap.to(el, { opacity: 1, y: 0, duration: 1.1, ease: 'expo.out', delay: 0.12 }),
    });
  });

  const slateBits = $$('.scene--slate [data-reveal], .slate__scroll');
  const chrome = [$('.top'), $('.tl')];
  const tlIntro = gsap.timeline({ defaults: { ease: 'expo.out' } });
  gsap.set(slateWords, { yPercent: 115, rotate: 4 });
  gsap.set(slateBits, { opacity: 0, y: 24 });
  gsap.set(chrome, { opacity: 0 });

  const D = fast ? 0.5 : 1;
  if (!loader.skipped) tlIntro.add(() => hideLoader(false), 0);
  tlIntro
    .add(world.assemble(fast ? 1.3 : 2.6), loader.skipped ? 0 : 0.35)
    .add(() => $('.slate__name').classList.add('is-lit'), `-=${0.7 * D}`)
    .to(slateWords, { yPercent: 0, rotate: 0, duration: 1.2, stagger: 0.05 }, `-=${0.9 * D}`)
    .to(slateBits, { opacity: 1, y: 0, duration: 1, stagger: 0.07 }, `-=${0.9 * D}`)
    .to(chrome, { opacity: 1, duration: 0.8, ease: 'power1.out' }, '<');
  if (loader.skipped) tlIntro.progress(1);
  return tlIntro;
}

/* ---------- Shaders ---------- */
const GLSL_NOISE = /* glsl */`
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3. - 2. * f);
  return mix(mix(hash12(i), hash12(i + vec2(1., 0.)), u.x), mix(hash12(i + vec2(0., 1.)), hash12(i + vec2(1., 1.)), u.x), u.y); }
float fbm(vec2 p){ float v = 0., a = .5; mat2 m = mat2(1.6, 1.2, -1.2, 1.6); for (int i = 0; i < 5; i++){ v += a * vnoise(p); p = m * p; a *= .5; } return v; }
`;
// Shared by the particles and the glowing line, so the oscilloscope trace and its dust match.
const GLSL_WAVE = /* glsl */`
float waveFn(float u, float t, float ph){
  return sin(u * 9. + t * 2. + ph) * .55 + sin(u * 23. - t * 3.1 + ph * 1.3) * .25 + sin(u * 51. + t * 5.3) * .12;
}
float waveEnv(float u){ return pow(max(sin(u * 3.14159265), 0.), .7); }
`;
const FS_VERT = /* glsl */`
varying vec2 vUv;
void main(){ vUv = uv; gl_Position = vec4(position.xy, 0., 1.); }
`;

const NEBULA_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform float uTime, uAspect, uWarm, uHue, uSplit, uSplitAmt, uLift, uGlowAmt;
uniform vec2 uGlow, uMouse;
uniform vec3 uBg, uSurf, uA, uB;
${GLSL_NOISE}
void main(){
  vec2 p = vUv - .5; p.x *= uAspect;
  float t = uTime * .035;
  vec2 m = (uMouse - .5) * .12;
  vec2 q = vec2(fbm(p * 1.3 + vec2(0., t) + m), fbm(p * 1.3 + vec2(5.2, -t * .8)));
  vec2 r = vec2(fbm(p * 1.9 + 1.7 * q + vec2(1.7, 9.2) + t * .6), fbm(p * 1.9 + 1.7 * q + vec2(8.3, 2.8) - t * .5));
  float f = fbm(p * 1.6 + 2. * r);
  vec3 col = uBg;
  col = mix(col, uSurf * 2.3, smoothstep(.34, .95, f) * .55 * uLift * (.55 + .45 * vUv.y));
  vec2 gp = vUv - uGlow; gp.x *= uAspect;
  float g = exp(-dot(gp, gp) * 2.4);
  float side = smoothstep(uSplit - .2, uSplit + .2, vUv.x);
  float hueMix = mix(clamp(uHue + (r.x - .5) * .9, 0., 1.), side, uSplitAmt);
  vec3 warm = mix(uA, uB, hueMix);
  float burn = smoothstep(.38, .95, f + q.y * .35);
  col += warm * burn * (.025 + .62 * g) * uWarm;
  col += warm * g * .09 * uGlowAmt;
  float seam = exp(-abs(vUv.x - uSplit) * 24.) * uSplitAmt;
  col += mix(uA, uB, side) * seam * .2;
  gl_FragColor = vec4(col, 1.);
}
`;

const BACKDROP_VERT = /* glsl */`
varying vec2 vUv;
void main(){ vUv = uv; gl_Position = vec4(position.xy, .9999, 1.); }
`;
const BACKDROP_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform sampler2D uNeb, uSlot;
uniform float uSlotAmt, uFilmAmt, uScrub, uTime;
uniform vec4 uFilm;
uniform vec2 uRes, uSlotSize;
uniform vec3 uA, uB, uBg, uSurf, uText;
${GLSL_NOISE}
float sdRR(vec2 p, vec2 b, float r){ vec2 q = abs(p) - b + r; return length(max(q, 0.)) + min(max(q.x, q.y), 0.) - r; }
// Stand-in for the scroll-scrubbed footage: a vertical strip of film running behind the
// program monitor, frames advancing with the scroll.
vec3 filmStrip(vec2 uv, float aspect){
  float hw = uFilm.y, fh = uFilm.z;
  float x = (uv.x - uFilm.x) * aspect / (2. * hw) + .5;
  if (x < 0. || x > 1.) return vec3(0.);
  float fy = uv.y / fh + uScrub;
  float fi = floor(fy), f = fract(fy);
  vec3 col = uSurf * .9;
  float img = smoothstep(.155, .165, x) * smoothstep(.845, .835, x) * smoothstep(0., .025, f) * smoothstep(1., .975, f);
  vec2 fp = vec2((x - .16) / .68, f);
  vec2 c = vec2(hash12(vec2(fi, 1.)), hash12(vec2(fi, 2.)));
  float blob = exp(-dot(fp - c, fp - c) * 6.) + .5 * exp(-dot(fp - c.yx, fp - c.yx) * 11.);
  vec3 frame = mix(uBg * 1.6, mix(uA, uB, hash12(vec2(fi, 3.))), clamp(blob, 0., 1.) * .5);
  frame *= .85 + .15 * sin(fp.y * 260.);
  col = mix(col, frame, img);
  vec2 hp = vec2((abs(x - .5) - .42) * 2. * hw, (fract(fy * 4.) - .5) * fh * .25);
  float hole = 1. - smoothstep(0., .003, sdRR(hp, vec2(.035 * hw, fh * .25 * .27), .008));
  col = mix(col, uBg * .5, hole);
  float rail = smoothstep(.0, .01, x) * smoothstep(1., .99, x);
  return col * rail * smoothstep(0., .18, uv.y) * smoothstep(1., .82, uv.y);
}
void main(){
  vec3 col = texture2D(uNeb, vUv).rgb;
  float aspect = uRes.x / uRes.y;
  if (uSlotAmt > .001) {
    float va = uSlotSize.x / uSlotSize.y;
    vec2 cuv = vUv - .5;
    if (aspect > va) cuv.y *= va / aspect; else cuv.x *= aspect / va;
    vec3 v = texture2D(uSlot, cuv + .5).rgb;
    float l = dot(v, vec3(.299, .587, .114));
    // graded into the palette and kept low, so the footage reads as atmosphere behind the type
    vec3 graded = mix(uBg, mix(uSurf * 2.4, uText * .8, l * l), .8) * .4 + v * .1;
    col = mix(col, max(col, graded), uSlotAmt);
  }
  if (uFilmAmt > .001) col = mix(col, col + filmStrip(vUv, aspect), uFilmAmt);
  vec2 vq = (vUv - .5) * vec2(aspect * .8, 1.);
  col *= 1. - dot(vq, vq) * .45;
  col += (hash12(gl_FragCoord.xy + fract(uTime) * 91.) - .5) / 160.;
  gl_FragColor = vec4(col, 1.);
}
`;

const PARTICLE_VERT = /* glsl */`
attribute vec3 aName;
attribute vec4 aSeed;
uniform float uTime, uMix, uStagger, uSize, uPR, uSweep, uSweepOn, uScatter, uFly, uAlpha, uWavePhase, uReelRot, uReelTilt;
uniform int uFrom, uTo;
uniform vec2 uSweepRange;
uniform vec4 uReel, uSplitP, uTrack, uWave, uRing;
uniform mat4 uTrackMat;
uniform vec3 uMouse, uA, uB, uText;
varying vec3 vColor;
varying float vAlpha;
${GLSL_WAVE}
vec3 shapePos(int id){
  vec4 s = aSeed;
  if (id == 0) {
    return position + vec3(sin(uTime * .11 + s.x * 6.28), cos(uTime * .13 + s.y * 6.28), sin(uTime * .07 + s.z * 6.28)) * .18;
  }
  if (id == 1) {
    vec3 p = aName + vec3(sin(uTime * 1.3 + s.x * 40.), cos(uTime * 1.1 + s.y * 40.), 0.) * .005;
    return p + (s.xyz - .5) * vec3(3.2, 2.4, 9.) * uScatter * (.4 + s.w);
  }
  if (id == 2) {
    // a film reel standing behind the glass frames: flange rim, hub, three spokes, wound film
    float R = uReel.w; float ang = s.y * 6.2831853 + uReelRot; float rr;
    if (s.x < .26) rr = R * (.955 + s.z * .045);
    else if (s.x < .34) rr = R * (.1 + s.z * .05);
    else if (s.x < .6) { float sp = floor(s.z * 3.); ang = sp * 2.0943951 + (s.w - .5) * .2 + uReelRot; rr = R * (.16 + s.y * .78); }
    else rr = R * (.3 + floor(s.z * 8.) / 8. * .62 + (s.w - .5) * .01);
    vec3 p = vec3(cos(ang) * rr, sin(ang) * rr, (s.w - .5) * .05);
    float ct = cos(uReelTilt), st = sin(uReelTilt);
    p = vec3(p.x * ct + p.z * st, p.y, -p.x * st + p.z * ct);
    return uReel.xyz + p;
  }
  if (id == 3) {
    float side = s.x < .5 ? -1. : 1.;
    float spread = pow(s.y, 3.) * uSplitP.w;
    float y = mix(uSplitP.z, uSplitP.y, s.z) + sin(uTime * .4 + s.w * 20.) * .04;
    return vec3(uSplitP.x + side * (spread + .006), y, (s.w - .5) * (spread * 1.6 + .15));
  }
  if (id == 4) {
    float lane = floor(s.x * 4.);
    float lx = fract(s.y - uTrack.z * .04) - .5;
    float ly = (lane + .5) / 4. - .5 + (s.z - .5) * .06;
    return (uTrackMat * vec4(lx * uTrack.x, ly * uTrack.y, .015 + s.w * .02, 1.)).xyz;
  }
  if (id == 5) {
    float ghost = step(.82, s.x);
    float u = s.y;
    float tt = uTime * 1.6 - ghost * .4;
    float y = uWave.z + waveFn(u, tt, uWavePhase) * waveEnv(u) * uWave.w + (s.z - .5) * .03 * (1. + ghost * 4.);
    return vec3(mix(uWave.x, uWave.y, u), y, (s.w - .5) * .25);
  }
  float ang = s.y * 6.2831853; float R = uRing.z; vec2 pp;
  if (s.x < .55) pp = vec2(cos(ang), sin(ang)) * R * (1. + (s.z - .5) * .03);
  else if (s.x < .75) pp = vec2(cos(ang), sin(ang)) * R * (.84 + (s.z - .5) * .015);
  else if (s.x < .875) pp = vec2((s.z - .5) * 2.16 * R, (s.w - .5) * .01);
  else pp = vec2((s.w - .5) * .01, (s.z - .5) * 2.16 * R);
  return vec3(uRing.xy + pp, (s.w - .5) * .08);
}
vec3 shapeColor(int id, vec3 p){
  vec4 s = aSeed;
  if (id == 0) return mix(uA, uB, s.x) * .8;
  if (id == 1) return mix(mix(uA, uB, s.x * .6), uText, step(.88, s.z) * .7);
  if (id == 2) return mix(uB, uText, s.z * .35);
  if (id == 3) return s.x < .5 ? uA : uB;
  if (id == 4) { float lane = floor(s.x * 4.); return lane < 1. ? mix(uText, uB, .5) : (lane < 2. ? uB : (lane < 3. ? uA : mix(uA, uB, s.y))); }
  if (id == 5) return mix(uB, uText, step(.82, s.x) * .0 + s.z * .3);
  float a = atan(p.y - uRing.y, p.x - uRing.x);
  return mix(uA, uB, .5 + .5 * sin(a));
}
float shapeAlpha(int id, vec3 p){
  if (id == 0) return .35;
  if (id == 2) return .5;
  if (id == 5) return aSeed.x > .82 ? .35 : 1.;
  if (id == 6) {
    float a = atan(p.y - uRing.y, p.x - uRing.x);
    float d = mod(uRing.w - a, 6.2831853);
    return .55 + .9 * exp(-d * 1.4);
  }
  return 1.;
}
void main(){
  vec3 A = shapePos(uFrom);
  vec3 B = shapePos(uTo);
  float t;
  if (uSweepOn > .5) {
    float nx = (aName.x - uSweepRange.x) / max(uSweepRange.y - uSweepRange.x, 1e-3);
    t = clamp((uSweep - nx) * 2.6 - aSeed.w * .35, 0., 1.);
  } else {
    t = clamp((uMix - aSeed.w * uStagger) / (1. - uStagger), 0., 1.);
  }
  t = t * t * (3. - 2. * t);
  vec3 off = vec3(sin(aSeed.x * 31. + uTime * .7), cos(aSeed.y * 29. + uTime * .6), sin(aSeed.z * 23. + uTime * .5)) * sin(t * 3.14159265) * uFly;
  vec3 pos = mix(A, B, t) + off;
  vec2 dm = pos.xy - uMouse.xy;
  float dl = length(dm);
  pos.xy += dm / max(dl, 1e-3) * uMouse.z * smoothstep(.85, 0., dl) * .32;
  vec4 mv = modelViewMatrix * vec4(pos, 1.);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = uSize * uPR * (.55 + aSeed.z * .9) * (10. / max(-mv.z, .5));
  vColor = mix(shapeColor(uFrom, A), shapeColor(uTo, B), t);
  float tw = .75 + .25 * sin(uTime * 2.3 + aSeed.x * 50.);
  vAlpha = mix(shapeAlpha(uFrom, A), shapeAlpha(uTo, B), t) * tw * uAlpha;
}
`;
const PARTICLE_FRAG = /* glsl */`
varying vec3 vColor;
varying float vAlpha;
void main(){
  vec2 c = gl_PointCoord - .5;
  float d = dot(c, c) * 4.;
  if (d > 1.) discard;
  float a = exp(-d * 3.5) * vAlpha;
  gl_FragColor = vec4(vColor * a, 1.);
}
`;

const CARD_VERT = /* glsl */`
uniform vec2 uSize;
uniform float uBend;
varying vec2 vUv;
void main(){
  vUv = uv;
  vec3 p = position;
  p.xy *= uSize;
  if (uBend > 0.) { float a = p.x / uBend; p.x = sin(a) * uBend; p.z = (cos(a) - 1.) * uBend; }
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.);
}
`;
const CARD_FRAG = /* glsl */`
precision highp float;
uniform sampler2D uPoster, uVideo, uNeb;
uniform float uVideoMix, uHasPoster, uActive, uOpacity, uSweep, uHover;
uniform vec2 uRes, uSize, uBorder;
uniform vec3 uA, uB, uSurf, uText;
varying vec2 vUv;
float sdRR(vec2 p, vec2 b, float r){ vec2 q = abs(p) - b + r; return length(max(q, 0.)) + min(max(q.x, q.y), 0.) - r; }
void main(){
  vec2 p = (vUv - .5) * uSize;
  float dO = sdRR(p, uSize * .5, .07);
  float aa = fwidth(dO) * 1.2;
  float mO = 1. - smoothstep(-aa, aa, dO);
  if (mO <= 0.) discard;
  vec2 ib = uSize * .5 - uBorder;
  float dI = sdRR(p, ib, .03);
  float mI = 1. - smoothstep(-aa, aa, dI);
  // 35 mm perforations in the top and bottom border
  float band = step(ib.y + uBorder.y * .08, abs(p.y));
  float holes = 5.;
  float hxw = uSize.x / holes;
  vec2 hc = vec2((fract(p.x / hxw + .5) - .5) * hxw, abs(p.y) - (ib.y + uBorder.y * .52));
  float dH = sdRR(hc, vec2(hxw * .24, uBorder.y * .2), .012);
  float mH = (1. - smoothstep(-aa, aa, dH)) * band;
  // glass: refract the nebula behind, with a little chromatic split on the bevel
  vec2 suv = gl_FragCoord.xy / uRes;
  float edge = smoothstep(0., -.14, dO);
  vec2 n = vec2(dFdx(dO), dFdy(dO)); n /= max(length(n), 1e-5);
  vec2 off = n * (1. - edge) * .04 + (p / uSize) * .025;
  vec3 refr = vec3(texture2D(uNeb, suv - off * 1.2).r, texture2D(uNeb, suv - off).g, texture2D(uNeb, suv - off * .8).b);
  vec3 glass = refr * 1.7 + uSurf * .4 + uText * .02;
  glass = mix(glass, texture2D(uNeb, suv).rgb * 1.1, mH);
  glass += uText * mH * .05;
  // picture: cover-fit the 9:16 frame inside the inner rect
  vec2 iuv = p / (ib * 2.) + .5;
  float ia = ib.x / ib.y, pa = 9. / 16.;
  if (ia > pa) iuv.y = (iuv.y - .5) * (pa / ia) + .5; else iuv.x = (iuv.x - .5) * (ia / pa) + .5;
  vec3 img = mix(texture2D(uPoster, iuv).rgb, texture2D(uVideo, iuv).rgb, uVideoMix);
  img = mix(uSurf * 1.4, img, uHasPoster);
  float lum = dot(img, vec3(.299, .587, .114));
  img = mix(mix(vec3(lum), img, .5) * .5, img, uActive);
  vec3 col = mix(glass, img, mI);
  col += uText * (1. - smoothstep(0., aa * 2.5, abs(dI))) * (.12 + .2 * uActive);
  float rim = 1. - smoothstep(0., .04, -dO);
  col += mix(uA, uB, vUv.y) * rim * (.22 + .4 * uActive + .3 * uHover);
  float s = fract(vUv.x * .7 + vUv.y * .45 - uSweep);
  col += uText * smoothstep(.12, 0., abs(s - .5)) * .07;
  float alpha = mix(.82, 1., mI) * mO * uOpacity;
  if (!gl_FrontFacing) col *= .3;
  gl_FragColor = vec4(col, alpha);
}
`;

const TRACKS_VERT = /* glsl */`
varying vec2 vUv;
uniform vec2 uSize;
void main(){ vUv = uv; vec3 p = position; p.xy *= uSize; gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.); }
`;
const TRACKS_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform vec2 uSize;
uniform float uScroll, uActive, uOpacity, uPlay, uFadeL, uFadeMin;
uniform vec2 uRes;
uniform vec3 uA, uB, uSurf, uText, uMuted;
${GLSL_NOISE}
float sdRR(vec2 p, vec2 b, float r){ vec2 q = abs(p) - b + r; return length(max(q, 0.)) + min(max(q.x, q.y), 0.) - r; }
void main(){
  float ruler = .1;
  float y = vUv.y;
  vec3 col = vec3(0.);
  float a = 0.;
  float wx = vUv.x * uSize.x;
  if (y > 1. - ruler) {
    float x = (wx + uScroll) * 4.;
    float fw = fwidth(x);
    float minor = 1. - smoothstep(0., fw * 1.5, abs(fract(x) - .5) * 2. - (1. - fw * 3.));
    float major = 1. - smoothstep(0., fw * 1.5, abs(fract(x / 8.) - .5) * 2. - (1. - fw / 8. * 3.));
    float ry = (y - (1. - ruler)) / ruler;
    col = uMuted * (minor * step(.55, ry) * .5 + major * .9);
    a = max(minor * step(.55, ry) * .5, major) * .8 + .12;
  } else {
    float lf = y / (1. - ruler) * 4.;
    float li = floor(lf), ly = fract(lf);
    float laneH = uSize.y * (1. - ruler) / 4.;
    float x = wx + uScroll * (1. + li * .08);
    float cw = 1.25 + li * .3;
    float ci = floor(x / cw), cx = x - ci * cw;
    float h1 = hash12(vec2(ci, li)), h2 = hash12(vec2(ci, li + 7.)), on = step(.16, hash12(vec2(ci, li + 3.)));
    float x0 = .03 + h1 * .3 * cw, x1 = cw - .03 - h2 * .22 * cw;
    vec2 q = vec2(cx - (x0 + x1) * .5, (ly - .5) * laneH);
    vec2 b = vec2((x1 - x0) * .5, laneH * .36);
    float d = sdRR(q, b, .045);
    float fw = fwidth(d) * 1.2;
    float fill = (1. - smoothstep(-fw, fw, d)) * on;
    float stroke = (1. - smoothstep(0., fw * 1.6, abs(d))) * on;
    vec3 lc = li < 1. ? mix(uSurf * 2.6, uMuted, .35) : (li < 2. ? uB : (li < 3. ? uA : mix(uA, uB, (q.x / b.x) * .5 + .5)));
    vec2 cl = q / b;
    float detail = 1.;
    if (li < 1.) detail = .75 + .25 * step(.5, fract(cl.x * 3.));
    else if (li < 2.) { vec2 k = vec2(fract(cl.x * 2.5) - .5, cl.y); detail = 1. + 1.4 * (1. - smoothstep(.05, .09, abs(k.x) + abs(k.y) * .28)); }
    else if (li < 3.) { float w = hash12(vec2(floor(cl.x * 6.), ci)); detail = .55 + .9 * step(abs(cl.y), .35) * step(.25, fract(cl.x * 6.)) * step(fract(cl.x * 6.), .25 + w * .7); }
    float focus = 1. - clamp(abs(li - uActive), 0., 1.);
    float bright = mix(.28, 1., focus);
    col = lc * fill * detail * .6 * bright + mix(lc, uText, .4) * stroke * bright;
    a = fill * mix(.35, .75, focus) + stroke * .9 * bright;
    float sep = 1. - smoothstep(0., fwidth(ly) * 1.5, min(ly, 1. - ly));
    col += uMuted * sep * .12; a = max(a, sep * .15);
  }
  float ph = 1. - smoothstep(0., fwidth(vUv.x) * 2., abs(vUv.x - uPlay));
  col += uA * ph * 1.4; a = max(a, ph);
  float fade = smoothstep(0., .14, vUv.x) * smoothstep(1., .86, vUv.x) * mix(1., .35, y);
  fade *= mix(uFadeMin, 1., smoothstep(uFadeL - .16, uFadeL, gl_FragCoord.x / uRes.x));
  gl_FragColor = vec4(col, a * fade * uOpacity);
}
`;

const LINE_VERT = /* glsl */`
attribute float aT;
attribute float aSide;
uniform int uFrom, uTo;
uniform float uMix, uTime, uWidth, uWavePhase;
uniform vec2 uRes;
uniform vec3 uP0, uP1;
uniform vec4 uWave, uRing;
varying float vSide, vT;
${GLSL_WAVE}
vec3 lineP(int id, float t){
  if (id == 0) return mix(uP0, uP1, t);
  if (id == 1) return vec3(mix(uWave.x, uWave.y, t), uWave.z + waveFn(t, uTime * 1.6, uWavePhase) * waveEnv(t) * uWave.w, 0.);
  float a = t * 6.2831853 + 1.5707963;
  return vec3(uRing.xy + vec2(cos(a), sin(a)) * uRing.z, 0.);
}
vec3 P(float t){
  float k = clamp((uMix - (1. - abs(t - .5) * 2.) * .25) / .75, 0., 1.);
  k = k * k * (3. - 2. * k);
  return mix(lineP(uFrom, t), lineP(uTo, t), k);
}
void main(){
  vT = aT; vSide = aSide;
  float e = .002;
  vec4 c0 = projectionMatrix * modelViewMatrix * vec4(P(aT), 1.);
  vec4 c1 = projectionMatrix * modelViewMatrix * vec4(P(min(aT + e, 1.)), 1.);
  vec4 cm = projectionMatrix * modelViewMatrix * vec4(P(max(aT - e, 0.)), 1.);
  vec2 s0 = c0.xy / c0.w, s1 = c1.xy / c1.w, sm = cm.xy / cm.w;
  vec2 dir = (s1 - sm) * uRes;
  dir = length(dir) > 1e-5 ? normalize(dir) : vec2(0., 1.);
  vec2 n = vec2(-dir.y, dir.x);
  c0.xy += n * aSide * uWidth / uRes * c0.w;
  gl_Position = c0;
}
`;
const LINE_FRAG = /* glsl */`
uniform vec3 uA, uB, uText;
uniform float uAlpha, uClosed;
varying float vSide, vT;
void main(){
  float d = abs(vSide);
  float core = exp(-d * d * 70.);
  float halo = exp(-d * d * 5.) * .45;
  vec3 c = mix(uA, uB, vT);
  vec3 col = c * (core * 1.5 + halo) + uText * core * .8;
  float ends = mix(smoothstep(0., .06, vT) * smoothstep(1., .94, vT), 1., uClosed);
  gl_FragColor = vec4(col * uAlpha * ends, 1.);
}
`;

const BRIGHT_FRAG = /* glsl */`
varying vec2 vUv;
uniform sampler2D uTex;
uniform float uThreshold;
void main(){
  vec3 c = texture2D(uTex, vUv).rgb;
  float l = max(c.r, max(c.g, c.b));
  gl_FragColor = vec4(c * smoothstep(uThreshold, uThreshold + .6, l), 1.);
}
`;
const BLUR_FRAG = /* glsl */`
varying vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uDir;
void main(){
  vec3 c = texture2D(uTex, vUv).rgb * .227027;
  c += texture2D(uTex, vUv + uDir * 1.3846154).rgb * .3162162;
  c += texture2D(uTex, vUv - uDir * 1.3846154).rgb * .3162162;
  c += texture2D(uTex, vUv + uDir * 3.2307692).rgb * .0702703;
  c += texture2D(uTex, vUv - uDir * 3.2307692).rgb * .0702703;
  gl_FragColor = vec4(c, 1.);
}
`;
const COMPOSITE_FRAG = /* glsl */`
varying vec2 vUv;
uniform sampler2D uScene, uBloomA, uBloomB;
uniform float uBloom, uTime, uGrain;
${GLSL_NOISE}
void main(){
  vec2 d = (vUv - .5) * .0016;
  vec3 c = vec3(texture2D(uScene, vUv + d).r, texture2D(uScene, vUv).g, texture2D(uScene, vUv - d).b);
  c += (texture2D(uBloomA, vUv).rgb * .6 + texture2D(uBloomB, vUv).rgb * .9) * uBloom;
  c += (hash12(gl_FragCoord.xy + fract(uTime * 7.) * 113.) - .5) * uGrain;
  gl_FragColor = vec4(c, 1.);
}
`;

/* ---------- World ---------- */
function createWorld(THREE, gsap) {
  THREE.ColorManagement.enabled = false; // we work in display space, like the CSS
  const PAL = {
    bg: new THREE.Color(0x040e12), surf: new THREE.Color(0x0f1b20), text: new THREE.Color(0xf4efe7),
    muted: new THREE.Color(0x9db0b5), a: new THREE.Color(0xf75f4c), b: new THREE.Color(0xe1a01d),
  };
  const touch = !fineMQ.matches;
  const small = Math.min(screen.width, screen.height) < 700;
  const mobile = touch || small;
  const forced = params.get('quality');
  // Quality ladder: 3 = bloom + full DPR, 2 = bloom, 1 = no bloom, 0 = lowest
  let quality = forced !== null ? clamp(Number(forced) || 0, 0, 3) : (mobile ? 1 : 3);
  const dprFor = (q) => Math.min(window.devicePixelRatio || 1, mobile ? 1.5 : [1, 1.25, 1.5, 2][q]) * (q === 0 ? 0.8 : 1);
  const COUNT = mobile ? 9000 : 24000;

  const canvas = document.createElement('canvas');
  canvas.className = 'stage';
  canvas.setAttribute('aria-hidden', 'true');
  document.body.prepend(canvas);
  const grain = document.createElement('div');
  grain.className = 'grain';
  grain.setAttribute('aria-hidden', 'true');
  if (mobile) document.body.append(grain);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, depth: true, stencil: false, powerPreference: 'high-performance' });
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  renderer.setClearColor(PAL.bg, 1);
  renderer.autoClear = false;

  const CAM_Z = 10;
  const FOV = 35;
  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 80);
  camera.position.set(0, 0, CAM_Z);
  const scene = new THREE.Scene();

  const view = { w: 1, h: 1, worldH: 1, worldW: 1 };
  const toWorld = (x, y) => new THREE.Vector2((x / view.w - 0.5) * view.worldW, (0.5 - y / view.h) * view.worldH);
  const rectWorld = (r, dy = 0) => {
    const c = toWorld(r.left + r.width / 2, r.top + r.height / 2 + dy);
    return { x: c.x, y: c.y, w: (r.width / view.w) * view.worldW, h: (r.height / view.h) * view.worldH };
  };

  const U = (v) => ({ value: v });
  const uTime = U(0);
  const uRes = U(new THREE.Vector2(1, 1));

  // ----- Full-screen passes -----
  const fsGeo = new THREE.PlaneGeometry(2, 2);
  const fsCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const fsScene = new THREE.Scene();
  const fsMesh = new THREE.Mesh(fsGeo);
  fsMesh.frustumCulled = false;
  fsScene.add(fsMesh);
  const runPass = (material, target) => {
    fsMesh.material = material;
    renderer.setRenderTarget(target);
    renderer.render(fsScene, fsCam);
  };
  const rtOpts = { type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter };
  const nebRT = new THREE.WebGLRenderTarget(64, 64, rtOpts);
  const sceneRT = new THREE.WebGLRenderTarget(64, 64, { type: THREE.HalfFloatType, depthBuffer: true, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
  const halfRT = new THREE.WebGLRenderTarget(32, 32, rtOpts);
  const blurA = new THREE.WebGLRenderTarget(16, 16, rtOpts);
  const blurB = new THREE.WebGLRenderTarget(16, 16, rtOpts);
  const blurC = new THREE.WebGLRenderTarget(16, 16, rtOpts);

  const nebMat = new THREE.ShaderMaterial({
    vertexShader: FS_VERT, fragmentShader: NEBULA_FRAG, depthTest: false, depthWrite: false,
    uniforms: {
      uTime, uAspect: U(1), uWarm: U(1), uHue: U(0.3), uSplit: U(0.5), uSplitAmt: U(0), uLift: U(1), uGlowAmt: U(1),
      uGlow: U(new THREE.Vector2(0.2, 0)), uMouse: U(new THREE.Vector2(0.5, 0.5)),
      uBg: U(PAL.bg), uSurf: U(PAL.surf), uA: U(PAL.a), uB: U(PAL.b),
    },
  });
  const brightMat = new THREE.ShaderMaterial({ vertexShader: FS_VERT, fragmentShader: BRIGHT_FRAG, uniforms: { uTex: U(null), uThreshold: U(0.96) }, depthTest: false, depthWrite: false });
  const blurMat = new THREE.ShaderMaterial({ vertexShader: FS_VERT, fragmentShader: BLUR_FRAG, uniforms: { uTex: U(null), uDir: U(new THREE.Vector2()) }, depthTest: false, depthWrite: false });
  const compMat = new THREE.ShaderMaterial({
    vertexShader: FS_VERT, fragmentShader: COMPOSITE_FRAG, depthTest: false, depthWrite: false,
    uniforms: { uScene: U(sceneRT.texture), uBloomA: U(blurB.texture), uBloomB: U(blurC.texture), uBloom: U(0.9), uTime, uGrain: U(0.045) },
  });

  // ----- Backdrop: nebula + video slots -----
  const blackTex = new THREE.DataTexture(new Uint8Array([4, 14, 18, 255]), 1, 1);
  blackTex.needsUpdate = true;
  const backMat = new THREE.ShaderMaterial({
    vertexShader: BACKDROP_VERT, fragmentShader: BACKDROP_FRAG, depthTest: false, depthWrite: false,
    uniforms: {
      uNeb: U(nebRT.texture), uSlot: U(blackTex), uSlotAmt: U(0), uSlotSize: U(new THREE.Vector2(16, 9)),
      uFilmAmt: U(0), uScrub: U(0), uFilm: U(new THREE.Vector4(0.7, 0.2, 0.25, 0)), uTime, uRes,
      uA: U(PAL.a), uB: U(PAL.b), uBg: U(PAL.bg), uSurf: U(PAL.surf), uText: U(PAL.text),
    },
  });
  const backdrop = new THREE.Mesh(fsGeo, backMat);
  backdrop.frustumCulled = false;
  backdrop.renderOrder = -10;
  scene.add(backdrop);

  // ----- Video slots (only when configured as ready) -----
  const slots = {};
  const canWebm = document.createElement('video').canPlayType('video/webm; codecs="vp9"') !== '';
  function slot(name) {
    if (slots[name] !== undefined) return slots[name];
    const cfg = VIDEO_SLOTS[name];
    if (!cfg || !cfg.ready) { slots[name] = null; return null; }
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.loop = name !== 'scrub'; v.preload = 'auto'; v.crossOrigin = 'anonymous';
    v.src = canWebm && cfg.webm ? cfg.webm : cfg.mp4;
    const tex = new THREE.VideoTexture(v);
    tex.minFilter = THREE.LinearFilter; tex.generateMipmaps = false;
    const s = { video: v, tex, ready: false };
    v.addEventListener('loadeddata', () => { s.ready = true; });
    v.addEventListener('error', () => { s.ready = false; });
    slots[name] = s;
    return s;
  }

  // ----- Particles -----
  const pGeo = new THREE.BufferGeometry();
  const dust = new Float32Array(COUNT * 3);
  const seeds = new Float32Array(COUNT * 4);
  const nameArr = new Float32Array(COUNT * 3);
  for (let i = 0; i < COUNT; i += 1) {
    dust[i * 3] = (Math.random() - 0.5) * 22;
    dust[i * 3 + 1] = (Math.random() - 0.5) * 13;
    dust[i * 3 + 2] = -9 + Math.random() * 12;
    seeds[i * 4] = Math.random(); seeds[i * 4 + 1] = Math.random(); seeds[i * 4 + 2] = Math.random(); seeds[i * 4 + 3] = Math.random();
  }
  pGeo.setAttribute('position', new THREE.BufferAttribute(dust, 3));
  pGeo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 4));
  const nameAttr = new THREE.BufferAttribute(nameArr, 3);
  pGeo.setAttribute('aName', nameAttr);
  const pU = {
    uTime, uMix: U(0), uStagger: U(0.45), uSize: U(mobile ? 1.9 : 1.6), uPR: U(1), uSweep: U(-0.3), uSweepOn: U(1),
    uScatter: U(0), uFly: U(0.7), uAlpha: U(1), uWavePhase: U(0), uReelRot: U(0), uReelTilt: U(0.42),
    uFrom: U(0), uTo: U(1), uSweepRange: U(new THREE.Vector2(-3, 3)),
    uReel: U(new THREE.Vector4(0, -2, -3, 3)), uSplitP: U(new THREE.Vector4(0, 3, -3, 1.4)),
    uTrack: U(new THREE.Vector4(10, 3, 0, 4)), uTrackMat: U(new THREE.Matrix4()),
    uWave: U(new THREE.Vector4(-4, 4, 0, 0.8)), uRing: U(new THREE.Vector4(0, 0, 1.5, 0)),
    uMouse: U(new THREE.Vector3(99, 99, 0)), uA: U(PAL.a), uB: U(PAL.b), uText: U(PAL.text),
  };
  const pMat = new THREE.ShaderMaterial({
    vertexShader: PARTICLE_VERT, fragmentShader: PARTICLE_FRAG, uniforms: pU,
    transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending,
  });
  const points = new THREE.Points(pGeo, pMat);
  points.frustumCulled = false;
  points.renderOrder = 5;
  scene.add(points);

  // Particles land on the real h1: draw the name in canvas with the same font, at the same spot.
  const nameEl = $('[data-name]');
  function sampleName() {
    const pin = scenes[0].pin;
    const r = nameEl.getBoundingClientRect();
    const pr = pin.getBoundingClientRect();
    const cs = getComputedStyle(nameEl);
    const probe = document.createElement('span');
    probe.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline';
    nameEl.append(probe);
    const baseline = probe.getBoundingClientRect().top - r.top;
    probe.remove();
    const S = 1.5;
    const w = Math.ceil(r.width * S);
    const h = Math.ceil(r.height * S);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff';
    ctx.font = `${cs.fontWeight} ${parseFloat(cs.fontSize) * S}px ${cs.fontFamily}`;
    ctx.textBaseline = 'alphabetic';
    if ('letterSpacing' in ctx) ctx.letterSpacing = cs.letterSpacing === 'normal' ? '0px' : `${parseFloat(cs.letterSpacing) * S}px`;
    ctx.fillText(nameEl.textContent.trim().toUpperCase(), 0, baseline * S);
    const data = ctx.getImageData(0, 0, w, h).data;
    const pts = [];
    const step = Math.max(1, Math.round(Math.sqrt((w * h) / 90000)));
    for (let y = 0; y < h; y += step) for (let x = 0; x < w; x += step) if (data[(y * w + x) * 4 + 3] > 140) pts.push(x, y);
    const left = r.left - pr.left;
    const top = r.top - pr.top;
    let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity;
    const n = pts.length / 2;
    for (let i = 0; i < COUNT; i += 1) {
      const k = n ? Math.floor(Math.random() * n) : 0;
      const sx = left + (pts[k * 2] + Math.random() * step) / S;
      const sy = top + (pts[k * 2 + 1] + Math.random() * step) / S;
      const wpt = toWorld(sx, sy);
      nameArr[i * 3] = wpt.x; nameArr[i * 3 + 1] = wpt.y; nameArr[i * 3 + 2] = (Math.random() - 0.5) * 0.06;
      minX = Math.min(minX, wpt.x); maxX = Math.max(maxX, wpt.x);
      minY = Math.min(minY, wpt.y); maxY = Math.max(maxY, wpt.y);
    }
    nameAttr.needsUpdate = true;
    pU.uSweepRange.value.set(minX, maxX);
    // the box of the glyphs themselves (the span is a full-width block)
    nameBox = n ? { x: (minX + maxX) / 2, y: (minY + maxY) / 2, w: maxX - minX, h: maxY - minY } : rectWorld({ left, top, width: r.width, height: r.height });
  }
  let nameBox = { x: 0, y: 0, w: 4, h: 1 };

  // ----- Glowing playhead line -----
  const SEG = 220;
  const lGeo = new THREE.BufferGeometry();
  const lT = new Float32Array((SEG + 1) * 2);
  const lS = new Float32Array((SEG + 1) * 2);
  const lIdx = [];
  for (let i = 0; i <= SEG; i += 1) {
    lT[i * 2] = i / SEG; lT[i * 2 + 1] = i / SEG;
    lS[i * 2] = -1; lS[i * 2 + 1] = 1;
    if (i < SEG) { const a = i * 2; lIdx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  }
  lGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array((SEG + 1) * 6), 3));
  lGeo.setAttribute('aT', new THREE.BufferAttribute(lT, 1));
  lGeo.setAttribute('aSide', new THREE.BufferAttribute(lS, 1));
  lGeo.setIndex(lIdx);
  const lU = {
    uFrom: U(0), uTo: U(0), uMix: U(0), uTime, uWidth: U(14), uWavePhase: pU.uWavePhase, uRes,
    uP0: U(new THREE.Vector3(0, -3, 0)), uP1: U(new THREE.Vector3(0, 3, 0)), uWave: pU.uWave, uRing: pU.uRing,
    uA: U(PAL.a), uB: U(PAL.b), uText: U(PAL.text), uAlpha: U(0), uClosed: U(0),
  };
  const lMat = new THREE.ShaderMaterial({
    vertexShader: LINE_VERT, fragmentShader: LINE_FRAG, uniforms: lU, transparent: true, depthWrite: false, depthTest: false, side: THREE.DoubleSide,
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
  });
  const line = new THREE.Mesh(lGeo, lMat);
  line.frustumCulled = false;
  line.renderOrder = 6;
  scene.add(line);

  // ----- Glass cards on a reel (scene 02) -----
  const REEL_SLUGS = reelItems.map((li) => li.dataset.reel);
  const ring = new THREE.Group();
  scene.add(ring);
  const cardGeo = new THREE.PlaneGeometry(1, 1, 28, 1);
  const texLoader = new THREE.TextureLoader();
  const cards = REEL_SLUGS.map((slug, i) => {
    const u = {
      uPoster: U(blackTex), uVideo: U(blackTex), uNeb: U(nebRT.texture), uVideoMix: U(0), uHasPoster: U(0), uActive: U(0),
      uOpacity: U(1), uSweep: U(0), uHover: U(0), uRes, uSize: U(new THREE.Vector2(1, 1.9)), uBorder: U(new THREE.Vector2(0.06, 0.16)),
      uBend: U(0), uA: U(PAL.a), uB: U(PAL.b), uSurf: U(PAL.surf), uText: U(PAL.text),
    };
    const mat = new THREE.ShaderMaterial({ vertexShader: CARD_VERT, fragmentShader: CARD_FRAG, uniforms: u, transparent: true, depthWrite: false, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(cardGeo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 2;
    ring.add(mesh);
    return { slug, i, mesh, u, poster: null, video: null, videoTex: null, loading: false };
  });
  function loadPoster(card) {
    if (card.poster || card.loading) return;
    card.loading = true;
    texLoader.load(`assets/media/posters/${card.slug}.jpg`, (tex) => {
      tex.anisotropy = 4;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      card.poster = tex;
      card.u.uPoster.value = tex;
      gsap.to(card.u.uHasPoster, { value: 1, duration: 0.6 });
    }, undefined, () => { card.loading = false; });
  }
  function cardVideo(card, on) {
    if (on && !card.video) {
      const v = document.createElement('video');
      v.muted = true; v.loop = true; v.playsInline = true; v.preload = 'auto';
      v.src = `assets/media/previews/${card.slug}.mp4`;
      const tex = new THREE.VideoTexture(v);
      tex.minFilter = THREE.LinearFilter; tex.generateMipmaps = false;
      card.video = v; card.videoTex = tex;
      v.addEventListener('playing', () => { card.u.uVideo.value = tex; gsap.to(card.u.uVideoMix, { value: 1, duration: 0.5 }); });
    }
    if (!card.video) return;
    if (on && !state.suspended) { const p = card.video.play(); if (p) p.catch(() => {}); } else if (!card.video.paused) card.video.pause();
  }
  const ringState = { cardH: 3, cardW: 1.7, R: 2.5, cx: 2, cy: 0, active: 0, hover: false };

  // ----- Timeline tracks (scene 04) -----
  const trackU = {
    uSize: U(new THREE.Vector2(14, 4)), uScroll: U(0), uActive: U(0), uOpacity: U(0), uPlay: U(0.36), uFadeL: U(0), uFadeMin: U(0.25), uRes,
    uA: U(PAL.a), uB: U(PAL.b), uSurf: U(PAL.surf), uText: U(PAL.text), uMuted: U(PAL.muted),
  };
  const tracks = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShaderMaterial({
    vertexShader: TRACKS_VERT, fragmentShader: TRACKS_FRAG, uniforms: trackU, transparent: true, depthWrite: false, depthTest: false,
  }));
  tracks.frustumCulled = false;
  tracks.renderOrder = 1;
  scene.add(tracks);

  // ----- Layout from the HTML anchors -----
  const anchors = {
    cards: $('[data-anchor="cards"]'),
    compare: $('[data-compare]'),
    monitor: $('.monitor__screen'),
    ring: $('[data-anchor="ring"]'),
    edl: $('.edl'),
  };
  const layout = { split: { x: 0, top: 2, bot: -2 }, tracks: { y: -2, z: -1.2, tilt: 0.6 }, wave: { y: 0 } };
  function restRect(el, sceneIdx) {
    // Rect of an element inside a sticky pin, as it sits while that scene holds.
    const r = el.getBoundingClientRect();
    const pin = scenes[sceneIdx].pin;
    if (!scenes[sceneIdx].sticky) return r;
    const pr = pin.getBoundingClientRect();
    return { left: r.left - pr.left, top: r.top - pr.top, width: r.width, height: r.height };
  }
  function computeLayout() {
    const sr = restRect(anchors.cards, 1);
    const wide = wideMQ.matches;
    const cardH = Math.min(rectWorld(sr).h * (wide ? 0.82 : 0.8), view.worldH * 0.62);
    const cardW = cardH * 0.5625 * 1.1;
    const c = rectWorld(sr);
    Object.assign(ringState, { cardH: cardH * 1.18, cardW, R: cardW * 1.32, cx: c.x, cy: c.y + (wide ? 0 : cardH * 0.04) });
    cards.forEach((cd) => {
      cd.u.uSize.value.set(cardW, cardH * 1.18);
      cd.u.uBorder.value.set(cardW * 0.045, cardH * 0.09);
      cd.u.uBend.value = ringState.R;
    });
    // The desk: its near edge sits just above the timeline bar, the far edge recedes toward the monitor.
    const tw = view.worldW * (wide ? 1.5 : 2.4);
    const th = wide ? 2.1 : 1.7;
    trackU.uSize.value.set(tw, th);
    layout.tracks.tilt = wide ? 0.62 : 0.7;
    const tilt = layout.tracks.tilt;
    const zc = -1.2;
    const zNear = zc + (th / 2) * Math.sin(tilt);
    // desktop: near edge just above the timeline bar; phone: tucked behind the monitor, clear of the text
    const tlH = parseFloat(getComputedStyle(root).getPropertyValue('--tl-h')) || 52;
    const mrest = restRect(anchors.monitor, 3);
    const nearPx = wide ? view.h - tlH - 14 : mrest.top + mrest.height * 0.92;
    const nearNdc = 1 - (2 * nearPx) / view.h;
    layout.tracks.y = nearNdc * (CAM_Z - zNear) * Math.tan((FOV * Math.PI) / 360) + (th / 2) * Math.cos(tilt);
    layout.tracks.z = zc;
    trackU.uFadeL.value = wide ? 0.44 : 0;
  }

  // ----- Scene keyframes (indexed by scene coordinate) -----
  const KEYS = [
    { warm: 1.1, hue: 0.22, glow: [0.18, 0.02], lift: 1, split: 0, cam: 0, pAlpha: 1, line: 0.25 },
    { warm: 0.85, hue: 0.62, glow: [0.66, 0.48], lift: 0.9, split: 0, cam: 0.4, pAlpha: 0.55, line: 0.3 },
    { warm: 1, hue: 0.5, glow: [0.5, 0.45], lift: 0.8, split: 1, cam: 0, pAlpha: 0.9, line: 1 },
    { warm: 0.8, hue: 0.7, glow: [0.72, 0.62], lift: 0.85, split: 0, cam: -0.3, pAlpha: 0.7, line: 0.85 },
    { warm: 0.8, hue: 0.3, glow: [0.5, 0.5], lift: 0.7, split: 0, cam: 0.2, pAlpha: 1, line: 1 },
    { warm: 1.15, hue: 0.25, glow: [0.7, 0.05], lift: 1, split: 0, cam: 0, pAlpha: 1, line: 1 },
  ];
  const keyAt = (sc, f) => {
    const i = Math.floor(clamp(sc, 0, 5));
    const j = Math.min(5, i + 1);
    const t = smooth(0, 1, sc - i);
    const a = KEYS[i][f]; const b = KEYS[j][f];
    return Array.isArray(a) ? [lerp(a[0], b[0], t), lerp(a[1], b[1], t)] : lerp(a, b, t);
  };
  const SHAPES = [1, 2, 3, 4, 5, 6];

  // ----- Pointer -----
  const mouse = { x: 0, y: 0, tx: 0, ty: 0, sx: -9999, sy: -9999, strength: 0, last: 0 };
  addEventListener('pointermove', (e) => {
    mouse.tx = (e.clientX / view.w) * 2 - 1;
    mouse.ty = (e.clientY / view.h) * 2 - 1;
    mouse.sx = e.clientX; mouse.sy = e.clientY;
    mouse.last = performance.now();
    if (e.pointerType === 'mouse') updateCardHover();
  }, { passive: true });
  function cardScreenRect(card) {
    const half = card.u.uSize.value;
    const corners = [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]].map(([x, y]) => {
      const v = new THREE.Vector3(x * half.x, y * half.y, 0).applyMatrix4(card.mesh.matrixWorld).project(camera);
      return [(v.x * 0.5 + 0.5) * view.w, (0.5 - v.y * 0.5) * view.h];
    });
    const xs = corners.map((c) => c[0]); const ys = corners.map((c) => c[1]);
    const left = Math.min(...xs); const top = Math.min(...ys);
    return { left, top, width: Math.max(...xs) - left, height: Math.max(...ys) - top };
  }
  function hitActiveCard(x, y) {
    if (current.sc < 0.6 || current.sc > 1.4) return null;
    const card = cards[ringState.active];
    const r = cardScreenRect(card);
    return x >= r.left && x <= r.left + r.width && y >= r.top && y <= r.top + r.height ? card : null;
  }
  function updateCardHover() {
    const hit = hitActiveCard(mouse.sx, mouse.sy);
    ringState.hover = Boolean(hit);
    anchors.cards.style.cursor = hit ? 'pointer' : '';
  }
  anchors.cards.style.pointerEvents = 'auto';
  anchors.cards.addEventListener('click', (e) => {
    const hit = hitActiveCard(e.clientX, e.clientY);
    if (hit) player.open(hit.slug, reelItems[hit.i]);
  });

  // ----- Sizing -----
  let dpr = dprFor(quality);
  let bloomOn = quality >= 2 && !mobile;
  function resize() {
    view.w = canvas.clientWidth || state.vw;
    view.h = canvas.clientHeight || state.vh;
    camera.aspect = view.w / view.h;
    camera.updateProjectionMatrix();
    view.worldH = 2 * CAM_Z * Math.tan((FOV * Math.PI) / 360);
    view.worldW = view.worldH * camera.aspect;
    renderer.setPixelRatio(dpr);
    renderer.setSize(view.w, view.h, false);
    const bw = Math.round(view.w * dpr);
    const bh = Math.round(view.h * dpr);
    uRes.value.set(bw, bh);
    const nw = Math.max(160, Math.round(view.w * (mobile ? 0.3 : 0.28)));
    nebRT.setSize(nw, Math.round(nw * (view.h / view.w)));
    nebMat.uniforms.uAspect.value = view.w / view.h;
    sceneRT.setSize(bw, bh);
    halfRT.setSize(Math.round(bw / 2), Math.round(bh / 2));
    [blurA, blurB, blurC].forEach((t) => t.setSize(Math.round(bw / 4), Math.round(bh / 4)));
    pU.uPR.value = dpr;
    lU.uWidth.value = (mobile ? 16 : 18) * dpr;
    measureScenes();
    sampleName();
    computeLayout();
  }

  // ----- Adaptive quality -----
  const perf = { acc: 0, n: 0, slow: 0 };
  function adapt(dt) {
    if (forced !== null) return;
    perf.acc += dt; perf.n += 1;
    if (perf.n < 60) return;
    const avg = perf.acc / perf.n;
    perf.acc = 0; perf.n = 0;
    perf.slow = avg > 1000 / 48 ? perf.slow + 1 : 0;
    if (perf.slow >= 2 && quality > 0) {
      quality -= 1;
      perf.slow = 0;
      bloomOn = quality >= 2 && !mobile;
      dpr = dprFor(quality);
      if (quality === 0) pGeo.setDrawRange(0, Math.floor(COUNT * 0.5));
      resize();
    }
  }

  // ----- Frame -----
  const current = { sc: 0, p: [0, 0, 0, 0, 0, 0] };
  let smoothY = window.scrollY;
  let last = 0;
  let running = false;
  let paused = false;
  let rafId = 0;
  let nebFrame = 0;
  let introOn = true;
  const tmpM = new THREE.Matrix4();

  function setReelActive(i) {
    if (i === ringState.active && cards[i].u.uActive.value > 0.5) return;
    ringState.active = i;
    activateReel(i);
  }

  function update(dt) {
    const y = window.scrollY;
    smoothY += (y - smoothY) * (1 - Math.exp(-dt / 90));
    if (Math.abs(y - smoothY) < 0.2) smoothY = y;
    const sc = sceneCoord(smoothY);
    current.sc = sc;
    for (let i = 0; i < scenes.length; i += 1) current.p[i] = localProgress(i, smoothY);
    const [p0, p1, p2, p3, p4] = current.p;
    const t = uTime.value;
    const wide = wideMQ.matches;

    // pointer
    mouse.x += (mouse.tx - mouse.x) * (1 - Math.exp(-dt / 220));
    mouse.y += (mouse.ty - mouse.y) * (1 - Math.exp(-dt / 220));
    const idle = performance.now() - mouse.last > 1800;
    mouse.strength += ((idle || touch ? 0 : 1) - mouse.strength) * (1 - Math.exp(-dt / 300));
    const mw = toWorld(mouse.sx, mouse.sy);
    pU.uMouse.value.set(mw.x, mw.y, mouse.strength);

    // camera: damped dolly per scene, a short roll on each cut, a little parallax
    const between = Math.sin(Math.PI * (sc - Math.floor(sc)));
    const dolly = keyAt(sc, 'cam') - p0 * 1.2 * (sc < 1 ? 1 : 0) - between * 0.9;
    camera.position.set(mouse.x * 0.22, -mouse.y * 0.12, CAM_Z + dolly);
    camera.lookAt(mouse.x * 0.06, -mouse.y * 0.03, 0);
    camera.rotateZ(between * 0.035 * (Math.floor(sc) % 2 ? -1 : 1));
    camera.updateMatrixWorld();

    // nebula colour per scene
    const nu = nebMat.uniforms;
    nu.uWarm.value = keyAt(sc, 'warm');
    nu.uHue.value = keyAt(sc, 'hue');
    const g = keyAt(sc, 'glow');
    nu.uGlow.value.set(g[0], g[1]);
    nu.uLift.value = keyAt(sc, 'lift');
    nu.uSplitAmt.value = keyAt(sc, 'split');
    nu.uMouse.value.set(mouse.x * 0.5 + 0.5, 0.5 - mouse.y * 0.5);

    // compare split position on screen (scene 03)
    const cr = anchors.compare.getBoundingClientRect();
    const splitX = cr.left + (cr.width * compare.pos) / 100;
    nu.uSplit.value = clamp(splitX / view.w, 0, 1);
    const sw = toWorld(splitX, cr.top + cr.height / 2);
    layout.split = { x: sw.x, top: toWorld(0, cr.top - cr.height * 0.15).y, bot: toWorld(0, cr.bottom + cr.height * 0.15).y };

    // particles: shape morph between scenes
    if (!introOn) {
      const i = Math.floor(clamp(sc, 0, 5));
      const f = sc - i;
      pU.uFrom.value = SHAPES[i];
      pU.uTo.value = SHAPES[Math.min(5, i + 1)];
      pU.uMix.value = f;
      pU.uSweepOn.value = 0;
    }
    pU.uScatter.value = smooth(0.12, 1, p0) * 0.9;
    pU.uAlpha.value = keyAt(sc, 'pAlpha');
    pU.uWavePhase.value = p4 * 9 + t * 0.2;
    // slate: the crisp HTML name gives way to the particles as you scroll
    nameEl.style.opacity = sc < 1 ? (1 - smooth(0.04, 0.22, p0)).toFixed(3) : '0';

    // ----- 02 Selects: the reel -----
    const inSel = clamp(1 - Math.abs(sc - 1) * 1.15);
    const steps = REEL_SLUGS.length - 1;
    const raw = clamp((p1 - 0.06) / 0.88) * steps;
    const base = Math.floor(raw);
    const stepped = Math.min(steps, base + smooth(0.3, 0.7, raw - base));
    const activeIdx = Math.round(stepped);
    if (sc > 0.5 && sc < 1.5) setReelActive(activeIdx);
    const enter = smooth(0.25, 1, sc); // fly in during the cut from 01
    const leave = smooth(1, 1.75, sc);
    const rot = -stepped * ((Math.PI * 2) / REEL_SLUGS.length) - (1 - enter) * 1.4 + leave * 0.9;
    ring.visible = inSel > 0.001;
    ring.position.set(ringState.cx, ringState.cy + leave * 3.2 - (1 - enter) * 1.5, -ringState.R - (1 - enter) * 6 - leave * 2);
    ring.rotation.set(0.1 - leave * 0.3, rot, 0);
    ring.updateMatrixWorld();
    cards.forEach((cd, i) => {
      const ang = (i / REEL_SLUGS.length) * Math.PI * 2;
      cd.mesh.position.set(Math.sin(ang) * ringState.R, 0, Math.cos(ang) * ringState.R);
      cd.mesh.rotation.set(0, ang, 0);
      let d = Math.abs(((ang + rot + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
      d /= Math.PI;
      const act = i === activeIdx && sc > 0.6 && sc < 1.4 ? 1 : 0;
      cd.u.uActive.value += (act - cd.u.uActive.value) * (1 - Math.exp(-dt / 160));
      cd.u.uOpacity.value = inSel * (1 - smooth(0.25, 0.75, d) * 0.85);
      cd.u.uSweep.value = rot * 0.25 + i * 0.13;
      cd.u.uHover.value += ((act && ringState.hover ? 1 : 0) - cd.u.uHover.value) * 0.15;
      if (sc > 0.2 && sc < 1.8) loadPoster(cd);
      cardVideo(cd, act === 1 && inSel > 0.5 && !paused);
    });
    pU.uReel.value.set(ring.position.x + (wide ? ringState.cardW * 0.35 : 0), ring.position.y, ring.position.z - ringState.R * 0.9, ringState.cardH * 0.78);
    pU.uReelRot.value = rot * 0.6 + t * 0.05;
    pU.uReelTilt.value = wide ? -0.35 : -0.15;

    // ----- 03 Two looks: particles become the dividing light -----
    pU.uSplitP.value.set(layout.split.x, layout.split.top, layout.split.bot, wide ? 2.2 : 1.2);

    // ----- 04 Layers: timeline desk -----
    const inLay = clamp(1 - Math.abs(sc - 3) * 1.1);
    tracks.visible = inLay > 0.001;
    tracks.position.set(0, layout.tracks.y - (1 - smooth(2.3, 3, sc)) * 2 - smooth(3, 3.8, sc) * 2.5, layout.tracks.z);
    tracks.rotation.set(-layout.tracks.tilt, 0, 0);
    // the playhead sits under the program monitor: the frame under it is the frame on screen
    const mb = anchors.monitor.getBoundingClientRect();
    const mrx = toWorld(mb.left + mb.width / 2, 0).x;
    trackU.uPlay.value = clamp(0.5 + mrx / trackU.uSize.value.x, 0.08, 0.92);
    tracks.updateMatrixWorld();
    trackU.uOpacity.value = inLay;
    trackU.uScroll.value = p3 * 9 + t * 0.05;
    trackU.uActive.value += (Math.min(3, Math.floor(p3 * 4)) - trackU.uActive.value) * (1 - Math.exp(-dt / 200));
    pU.uTrack.value.set(trackU.uSize.value.x, trackU.uSize.value.y * 0.9, p3 * 9 + t * 0.05, 4);
    tmpM.copy(tracks.matrixWorld).multiply(new THREE.Matrix4().makeTranslation(0, -trackU.uSize.value.y * 0.05, 0));
    pU.uTrackMat.value.copy(tmpM);
    if (sc > 2.5 && sc < 3.5) {
      const li = Math.min(3, Math.floor(p3 * 4));
      activateLayer(li);
      layerTicks.forEach((tk, i) => tk.style.setProperty('--f', clamp(p3 * 4 - i).toFixed(3)));
    }

    // scroll-scrubbed slot (or its code stand-in) behind the desk
    const scrub = sc > 2.4 && sc < 3.6 ? slot('scrub') : null;
    const mr = anchors.monitor.getBoundingClientRect();
    if (scrub && scrub.ready && scrub.video.duration) {
      const target = p3 * scrub.video.duration;
      if (!scrub.video.seeking && Math.abs(scrub.video.currentTime - target) > 1 / 30) scrub.video.currentTime = target;
      backMat.uniforms.uSlot.value = scrub.tex;
      backMat.uniforms.uSlotSize.value.set(scrub.video.videoWidth || 16, scrub.video.videoHeight || 9);
      backMat.uniforms.uSlotAmt.value = inLay * 0.75;
      backMat.uniforms.uFilmAmt.value = 0;
    } else {
      backMat.uniforms.uFilmAmt.value = inLay * 0.85;
      backMat.uniforms.uScrub.value = -p3 * 7;
      const hw = (mr.width * 0.92) / view.h;
      backMat.uniforms.uFilm.value.set((mr.left + mr.width / 2) / view.w, hw, hw * 1.35, 0);
      // hero / export slots: loop behind scenes 01 and 06
      const hero = sc < 0.9 ? slot('hero') : null;
      const exp = sc > 4.2 ? slot('export') : null;
      const s = hero || exp;
      if (s && s.ready) {
        if (s.video.paused) s.video.play().catch(() => {});
        backMat.uniforms.uSlot.value = s.tex;
        backMat.uniforms.uSlotSize.value.set(s.video.videoWidth || 16, s.video.videoHeight || 9);
        backMat.uniforms.uSlotAmt.value = hero ? 1 - smooth(0.2, 0.9, sc) : smooth(4.2, 5, sc);
      } else {
        backMat.uniforms.uSlotAmt.value = 0;
      }
    }
    ['hero', 'export'].forEach((n) => {
      const s = slots[n];
      if (s && s.ready && !s.video.paused && ((n === 'hero' && sc > 0.95) || (n === 'export' && sc < 4.1) || paused)) s.video.pause();
    });

    // ----- 05 Rate card: oscilloscope -----
    const er = anchors.edl.getBoundingClientRect();
    const wy = toWorld(0, view.h * (wide ? 0.52 : 0.42)).y;
    if (wide) pU.uWave.value.set(toWorld(er.left + 12, 0).x, toWorld(er.right - 12, 0).x, wy, 0.85);
    else pU.uWave.value.set(-view.worldW * 0.47, view.worldW * 0.47, wy, 0.5);

    // ----- 06 Export: leader ring around the portrait -----
    const rr = anchors.ring.getBoundingClientRect();
    const rw = rectWorld(rr);
    pU.uRing.value.set(rw.x, rw.y, Math.max(rw.w, rw.h) * 0.62, (t * 1.8) % (Math.PI * 2));

    // ----- Glowing line -----
    const lineAlpha = keyAt(sc, 'line');
    const H = view.worldH;
    let x0; let y0a; let y0b;
    if (sc < 1) {
      x0 = lerp(nameBox.x + nameBox.w * 0.5 + 0.22, ringState.cx, smooth(0, 1, sc));
      y0a = lerp(nameBox.y - nameBox.h * 0.75, ringState.cy - ringState.cardH * 0.75, smooth(0, 1, sc));
      y0b = lerp(nameBox.y + nameBox.h * 0.75, ringState.cy + ringState.cardH * 0.75, smooth(0, 1, sc));
    } else if (sc < 2) {
      const k = smooth(1, 2, sc);
      x0 = lerp(ringState.cx, layout.split.x, k);
      y0a = lerp(ringState.cy - ringState.cardH * 0.75, layout.split.bot, k);
      y0b = lerp(ringState.cy + ringState.cardH * 0.75, layout.split.top, k);
    } else {
      x0 = layout.split.x; y0a = layout.split.bot; y0b = layout.split.top;
    }
    const p0v = new THREE.Vector3(x0, y0a, 0);
    const p1v = new THREE.Vector3(x0, y0b, 0);
    if (sc >= 2) {
      // along the desk at the playhead, rising to the monitor
      const k = smooth(2, 3, sc);
      const near = new THREE.Vector3((trackU.uPlay.value - 0.5) * trackU.uSize.value.x, -trackU.uSize.value.y * 0.5, 0.02).applyMatrix4(tracks.matrixWorld);
      const far = new THREE.Vector3((trackU.uPlay.value - 0.5) * trackU.uSize.value.x, trackU.uSize.value.y * 0.4, 0.02).applyMatrix4(tracks.matrixWorld);
      p0v.lerp(near, k);
      p1v.lerp(far, k);
    }
    if (introOn) {
      const sx = lerp(pU.uSweepRange.value.x - 0.4, pU.uSweepRange.value.y + 0.4, clamp(pU.uSweep.value));
      p0v.set(sx, nameBox.y - nameBox.h * 0.75, 0);
      p1v.set(sx, nameBox.y + nameBox.h * 0.75, 0);
    }
    lU.uP0.value.copy(p0v);
    lU.uP1.value.copy(p1v);
    if (sc < 3) { lU.uFrom.value = 0; lU.uTo.value = 0; lU.uMix.value = 0; } else if (sc < 4) { lU.uFrom.value = 0; lU.uTo.value = 1; lU.uMix.value = sc - 3; } else { lU.uFrom.value = 1; lU.uTo.value = 2; lU.uMix.value = sc - 4; }
    lU.uClosed.value = smooth(4.85, 5, sc);
    lU.uAlpha.value = introOn ? introLine.value : lineAlpha * (1 - smooth(0.25, 0.7, p0) * 0.6 * (sc < 1 ? 1 : 0));
    void H;

    // ----- HTML: scene panels fade on the cut, mobile headers make room -----
    scenes.forEach((s, i) => {
      if (!s.sticky) { if (s.pin) s.pin.style.opacity = ''; return; }
      const out = clamp((y - s.end) / (state.vh * 0.55));
      const inn = i === 0 ? 1 : clamp((y - (s.start - state.vh * 0.75)) / (state.vh * 0.75));
      s.pin.style.opacity = (Math.min(1 - out, inn)).toFixed(3);
    });
    if (!wide) {
      const fadeHead = (el, p) => {
        const o = 1 - smooth(0.005, 0.045, p);
        el.style.opacity = o.toFixed(3);
        el.style.transform = `translate3d(0,${(-(1 - o) * 24).toFixed(1)}px,0)`;
        el.style.pointerEvents = o < 0.2 ? 'none' : '';
      };
      fadeHead(ui.selHead, p1);
      fadeHead(ui.layHead, p3);
      const show = smooth(0.035, 0.07, p1).toFixed(3);
      ui.reels.style.opacity = show;
      ui.bin.style.opacity = show;
    } else if (ui.dirty) {
      [ui.selHead, ui.layHead, ui.reels, ui.bin].forEach((el) => { el.style.opacity = ''; el.style.pointerEvents = ''; el.style.transform = ''; });
    }
    ui.dirty = !wide;
    void p2;
    renderTimeline(y);
  }

  const introLine = { value: 0 };
  const ui = { selHead: $('.selects__head'), layHead: $('.layers__head'), reels: $('.reels'), bin: $('.reels__bin'), dirty: true };
  function render(dt) {
    // nebula is cheap at this size; on the lowest tier it updates every other frame
    nebFrame += 1;
    if (quality > 0 || nebFrame % 2 === 0) runPass(nebMat, nebRT);
    if (bloomOn) {
      renderer.setRenderTarget(sceneRT);
      renderer.clear();
      renderer.render(scene, camera);
      brightMat.uniforms.uTex.value = sceneRT.texture;
      runPass(brightMat, halfRT);
      const bw = blurA.width; const bh = blurA.height;
      blurMat.uniforms.uTex.value = halfRT.texture; blurMat.uniforms.uDir.value.set(1.4 / bw, 0); runPass(blurMat, blurA);
      blurMat.uniforms.uTex.value = blurA.texture; blurMat.uniforms.uDir.value.set(0, 1.4 / bh); runPass(blurMat, blurB);
      blurMat.uniforms.uTex.value = blurB.texture; blurMat.uniforms.uDir.value.set(3.2 / bw, 0); runPass(blurMat, blurA);
      blurMat.uniforms.uTex.value = blurA.texture; blurMat.uniforms.uDir.value.set(0, 3.2 / bh); runPass(blurMat, blurC);
      runPass(compMat, null);
    } else {
      renderer.setRenderTarget(null);
      renderer.clear();
      renderer.render(scene, camera);
    }
    adapt(dt);
  }

  function frame(now) {
    rafId = 0;
    if (!running || paused) return;
    const dt = last ? Math.min(now - last, 100) : 16;
    last = now;
    uTime.value += dt / 1000;
    update(dt);
    render(dt);
    rafId = requestAnimationFrame(frame);
  }
  function loop(on) {
    if (on && !rafId) { last = 0; rafId = requestAnimationFrame(frame); }
    if (!on && rafId) { cancelAnimationFrame(rafId); rafId = 0; }
  }
  let onScreen = true;
  const live = () => running && !paused && !document.hidden && onScreen;
  document.addEventListener('visibilitychange', () => loop(live()));
  // The canvas is fixed full-screen, but if it is ever off screen (print, hidden), stop drawing.
  new IntersectionObserver(([e]) => { onScreen = e.isIntersecting; loop(live()); }).observe(canvas);

  resize();

  return {
    intro: null,
    resize: () => { resize(); },
    start() { running = true; loop(live()); },
    pause(on) {
      paused = on;
      cards.forEach((cd) => { if (cd.video && on) cd.video.pause(); });
      loop(live());
    },
    async warmUp() {
      update(16);
      renderer.compile(scene, camera);
      [nebMat, brightMat, blurMat, compMat].forEach((m) => { fsMesh.material = m; renderer.compile(fsScene, fsCam); });
      render(16);
      cards.slice(0, 2).forEach(loadPoster);
    },
    assemble(duration) {
      // Particles fly in from the dust and land on the name as the playhead sweeps across it.
      introOn = true;
      pU.uFrom.value = 0; pU.uTo.value = 1; pU.uSweepOn.value = 1; pU.uSweep.value = -0.3;
      const t = gsap.timeline();
      t.to(introLine, { value: 1, duration: 0.4, ease: 'power1.out' }, 0)
        .to(pU.uSweep, { value: 1.3, duration, ease: 'power2.inOut' }, 0)
        .to(introLine, { value: KEYS[0].line, duration: 0.8, ease: 'power1.inOut' }, duration * 0.85)
        .add(() => { introOn = false; pU.uSweepOn.value = 0; });
      return t;
    },
    cardPose(slug) {
      const card = cards.find((c) => c.slug === slug);
      if (!card || current.sc < 0.6 || current.sc > 1.4 || card.i !== ringState.active) return null;
      const r = cardScreenRect(card);
      const inner = r.width * (1 - 0.09);
      return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, width: inner, angle: 0 };
    },
    dispose() {
      loop(false);
      running = false;
      renderer.dispose();
      canvas.remove();
      grain.remove();
    },
  };
}

boot();
