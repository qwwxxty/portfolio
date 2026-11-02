(() => {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const easeInOut = (t) => (t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

  const root = document.documentElement;
  const reduceMQ = matchMedia('(prefers-reduced-motion: reduce)');
  const pinnedMQ = matchMedia('(min-width: 900px) and (min-height: 560px) and (prefers-reduced-motion: no-preference)');
  const fineMQ = matchMedia('(hover: hover) and (pointer: fine)');
  const wideMQ = matchMedia('(min-width: 900px)');
  const craftPinMQ = matchMedia('(max-width: 899.98px) and (prefers-reduced-motion: no-preference)');

  const store = (kind) => ({
    get(k) { try { return window[kind].getItem(k); } catch { return null; } },
    set(k, v) { try { window[kind].setItem(k, v); } catch { /* storage blocked */ } },
  });
  const local = store('localStorage');
  const session = store('sessionStorage');

  const RUNTIME = 403.98; // summed length of all nine reels, in seconds
  const FPS = 24;
  const pad = (n) => String(n).padStart(2, '0');
  const timecode = (sec) => {
    const s = Math.floor(sec);
    return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}:${pad(Math.floor((sec - s) * FPS))}`;
  };
  const clock = (sec) => `${Math.floor(sec / 60)}:${pad(Math.floor(sec % 60))}`;

  /* ---------- Silent preview playback ---------- */

  const wanted = new Set();
  let suspended = false; // true while the full player is open
  let motionOff = reduceMQ.matches || local.get('previews') === 'off';

  const previewVideos = $$('video[data-src]');

  function applyVideo(v) {
    if (wanted.has(v) && !suspended && !motionOff) {
      if (!v.getAttribute('src')) v.src = v.dataset.src;
      const p = v.play();
      if (p) p.catch(() => {});
    } else if (!v.paused) {
      v.pause();
    }
  }
  const setWanted = (v, on) => {
    if (on) wanted.add(v); else wanted.delete(v);
    applyVideo(v);
  };
  const applyAll = () => previewVideos.forEach(applyVideo);

  // A dropped connection shouldn't leave a card stuck on its poster, so retry twice.
  previewVideos.forEach((v) => {
    let retries = 0;
    v.addEventListener('playing', () => { retries = 0; v.classList.add('is-playing'); });
    v.addEventListener('error', () => {
      v.classList.remove('is-playing');
      if (retries >= 2) return;
      retries += 1;
      setTimeout(() => { v.load(); applyVideo(v); }, retries * 1000);
    });
  });

  const motionBtn = $('[data-motion]');
  function renderMotion() {
    motionBtn.textContent = motionOff ? 'Previews off' : 'Previews on';
    motionBtn.setAttribute('aria-pressed', String(!motionOff));
    root.classList.toggle('motion-off', motionOff);
  }
  motionBtn.addEventListener('click', () => {
    motionOff = !motionOff;
    local.set('previews', motionOff ? 'off' : 'on');
    renderMotion();
    applyAll();
  });
  renderMotion();

  /* ---------- Text splitting + reveals ---------- */

  function splitWords(el) {
    let i = 0;
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
            inner.style.setProperty('--i', i++);
            inner.textContent = part;
            w.append(inner);
            frag.append(w);
          });
          child.replaceWith(frag);
        } else if (child.nodeType === Node.ELEMENT_NODE && child.tagName !== 'BR') {
          walk(child);
        }
      });
    };
    walk(el);
  }
  $$('[data-split]').forEach(splitWords);

  // A fully clipped element never counts as intersecting, so clip reveals watch their parent.
  const revealTargets = new Map();
  const revealIO = new IntersectionObserver((entries) => {
    entries.forEach((e) => {
      if (!e.isIntersecting) return;
      (revealTargets.get(e.target) || []).forEach((el) => el.classList.add('is-in'));
      revealIO.unobserve(e.target);
    });
  }, { threshold: .12, rootMargin: '0px 0px -6% 0px' });

  const heroTitle = $('[data-hero-title]');
  $$('[data-split], [data-reveal]').forEach((el) => {
    if (el === heroTitle) return;
    const watched = el.dataset.reveal === 'clip' ? el.parentElement : el;
    revealTargets.set(watched, [...(revealTargets.get(watched) || []), el]);
    revealIO.observe(watched);
  });

  /* ---------- Intro ---------- */

  function ready() {
    root.classList.add('is-ready');
    heroTitle.classList.add('is-in');
    startHeroVideos();
  }

  function playIntro() {
    const intro = $('#intro');
    if (reduceMQ.matches || session.get('intro-seen')) {
      intro.remove();
      ready();
      return;
    }
    session.set('intro-seen', '1');
    const tc = $('[data-intro-tc]', intro);
    const bar = $('[data-intro-bar]', intro);
    const start = performance.now();
    const DURATION = 1350;
    const step = (t) => {
      const p = clamp((t - start) / DURATION);
      const eased = 1 - Math.pow(1 - p, 3);
      tc.textContent = timecode(eased * RUNTIME);
      bar.style.transform = `scaleX(${eased})`;
      if (p < 1) { requestAnimationFrame(step); return; }
      intro.classList.add('is-out');
      setTimeout(ready, 220);
      setTimeout(() => intro.remove(), 1200);
    };
    requestAnimationFrame(step);
  }

  /* ---------- Geometry cache ---------- */

  const geo = { vw: 0, vh: 0, docRange: 1 };
  const hero = {
    el: $('[data-hero]'),
    pin: $('.hero__pin'),
    foot: $('[data-hero-foot]'),
    cards: $$('.deck-card'),
    visible: [],
    range: 1,
    cardW: 0,
  };
  const work = {
    el: $('[data-work]'),
    track: $('[data-work-track]'),
    head: $('[data-work-head]'),
    ruler: $('[data-ruler]'),
    cards: $$('.card').map((el) => ({ el, media: $('[data-parallax]', el), center: 0 })),
    top: 0,
    range: 0,
    pinned: false,
  };
  const contact = { el: $('[data-contact]'), top: 0 };
  const craftMotion = { grid: $('[data-craft-grid]'), pin: $('[data-craft-pin]'), top: 0, range: 1, render: null };
  const bandEl = $('[data-band]');

  function measure() {
    geo.vw = root.clientWidth;
    geo.vh = window.innerHeight;

    hero.visible = hero.cards.filter((c) => getComputedStyle(c).display !== 'none');
    hero.visible.forEach((c, i) => {
      const k = i - (hero.visible.length - 1) / 2;
      c.style.zIndex = String(10 - Math.abs(k) * 2);
      const inner = c.firstElementChild;
      inner.style.setProperty('--k', k);
      inner.style.setProperty('--i', Math.abs(k));
    });
    hero.cardW = hero.visible[0] ? hero.visible[0].offsetWidth : 0;
    hero.range = Math.max(1, hero.el.offsetHeight - geo.vh);

    work.pinned = pinnedMQ.matches;
    if (work.pinned) {
      work.track.style.transform = 'none';
      const overflow = Math.max(0, work.track.scrollWidth - geo.vw);
      work.range = overflow;
      work.el.style.height = `${overflow + geo.vh}px`;
      work.top = work.el.getBoundingClientRect().top + window.scrollY;
      const trackLeft = work.track.getBoundingClientRect().left;
      work.cards.forEach((c) => {
        const r = c.el.getBoundingClientRect();
        c.center = r.left - trackLeft + r.width / 2;
        c.el.style.transform = '';
      });
    } else {
      work.el.style.height = '';
      work.track.style.transform = '';
      work.cards.forEach((c) => { c.el.style.transform = ''; c.media.style.transform = ''; });
    }

    craftMotion.top = craftMotion.grid.getBoundingClientRect().top + window.scrollY;
    craftMotion.range = Math.max(1, craftMotion.grid.offsetHeight - craftMotion.pin.offsetHeight);
    contact.top = contact.el.getBoundingClientRect().top + window.scrollY;
    geo.docRange = Math.max(1, root.scrollHeight - geo.vh);
  }

  /* ---------- Scroll-driven frame ---------- */

  let smoothY = window.scrollY;
  let lastT = 0;
  let running = false;
  const hudTc = $('[data-hud-tc]');
  const hudBar = $('[data-hud-bar]');
  let hudText = '';

  function renderHero(y) {
    const p = reduceMQ.matches ? 0 : clamp(y / hero.range);
    const e = easeInOut(p);
    const n = hero.visible.length;
    const narrow = !wideMQ.matches;
    const gap = narrow ? 10 : 18;
    const fit = (geo.vw - 56 + gap) / n;
    const endScale = narrow ? .82 : Math.min(1, (fit - gap) / hero.cardW);
    const spacing = narrow ? hero.cardW * .82 + gap : hero.cardW * endScale + gap;
    hero.visible.forEach((c, i) => {
      const k = i - (n - 1) / 2;
      const x = lerp(k * hero.cardW * .5, k * spacing, e);
      const yy = lerp(k * k * hero.cardW * .07, 0, e);
      const r = lerp(k * 6, 0, e);
      const s = lerp(1 - Math.abs(k) * .045, endScale, e);
      c.style.transform = `translate3d(${x.toFixed(2)}px,${yy.toFixed(2)}px,0) rotate(${r.toFixed(3)}deg) scale(${s.toFixed(4)})`;
      c.firstElementChild.style.setProperty('--shade', lerp(.56, 0, clamp(p * 1.7)).toFixed(3));
    });
    heroTitle.style.transform = `translate3d(0,${(-p * geo.vh * .24).toFixed(1)}px,0) scale(${(1 - p * .07).toFixed(4)})`;
    heroTitle.style.opacity = clamp(1 - p * 2.1).toFixed(3);
    hero.foot.style.opacity = clamp(1 - p * 3.4).toFixed(3);
  }

  function renderWork(y) {
    if (!work.pinned) return;
    const p = clamp((y - work.top) / Math.max(1, work.range));
    const x = -p * work.range;
    work.track.style.transform = `translate3d(${x.toFixed(2)}px,0,0)`;
    work.ruler.style.setProperty('--rx', `${x.toFixed(1)}px`);
    work.head.style.opacity = clamp(1 + x / (geo.vw * .55)).toFixed(3);
    work.cards.forEach((c) => {
      const d = (c.center + x - geo.vw / 2) / geo.vw;
      const ad = Math.abs(d);
      if (ad > 1.15) return;
      c.el.style.transform = `translate3d(0,${(ad * ad * 26).toFixed(2)}px,0) scale(${(1 - Math.min(ad, 1) * .055).toFixed(4)})`;
      c.media.style.transform = `translate3d(${(d * -4.5).toFixed(2)}%,0,0) scale(1.12)`;
    });
  }

  function renderHud(y) {
    const p = clamp(y / geo.docRange);
    const text = timecode(p * RUNTIME);
    if (text !== hudText) { hudTc.textContent = text; hudText = text; }
    hudBar.style.transform = `scaleX(${p.toFixed(4)})`;
  }

  function renderBand(velocity) {
    if (reduceMQ.matches) return;
    bandEl.style.transform = `skewX(${clamp(velocity * -.012, -9, 9).toFixed(2)}deg)`;
  }

  function renderCraft(y) {
    if (craftPinMQ.matches) craftMotion.render(clamp((y - craftMotion.top) / craftMotion.range));
  }

  function renderContact(y) {
    const rise = clamp((y + geo.vh - contact.top) / geo.vh);
    contact.el.style.setProperty('--rise', rise.toFixed(3));
  }

  function frame(t) {
    const dt = lastT ? Math.min(t - lastT, 64) : 16;
    lastT = t;
    const target = window.scrollY;
    const follow = reduceMQ.matches ? 1 : 1 - Math.exp(-dt / 75);
    const prev = smoothY;
    smoothY += (target - smoothY) * follow;
    if (Math.abs(target - smoothY) < .15) smoothY = target;
    const velocity = (smoothY - prev) / (dt / 16);

    renderHero(smoothY);
    renderWork(smoothY);
    renderHud(smoothY);
    renderBand(velocity);
    renderCraft(smoothY);
    renderContact(smoothY);

    if (smoothY !== target || Math.abs(velocity) > .01) {
      requestAnimationFrame(frame);
    } else {
      running = false;
      lastT = 0;
      renderBand(0);
    }
  }
  function kick() {
    if (running) return;
    running = true;
    requestAnimationFrame(frame);
  }
  addEventListener('scroll', kick, { passive: true });

  let resizeTimer = 0;
  const remeasure = () => { measure(); kick(); };
  addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(remeasure, 120);
  });
  [pinnedMQ, wideMQ, craftPinMQ].forEach((mq) => mq.addEventListener('change', remeasure));
  addEventListener('load', remeasure);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(remeasure);

  /* ---------- Hero video + pointer parallax ---------- */

  function startHeroVideos() {
    heroVideoIO.observe(hero.el);
  }
  const heroVideoIO = new IntersectionObserver(([e]) => {
    hero.visible.forEach((c) => setWanted($('video', c), e.isIntersecting));
  }, { threshold: 0 });

  if (fineMQ.matches && !reduceMQ.matches) {
    hero.pin.addEventListener('pointermove', (e) => {
      const nx = e.clientX / geo.vw - .5;
      const ny = e.clientY / geo.vh - .5;
      hero.visible.forEach((c, i) => {
        const k = i - (hero.visible.length - 1) / 2;
        const depth = 16 + (2 - Math.abs(k)) * 9;
        c.firstElementChild.style.setProperty('--mx', (nx * depth).toFixed(1));
        c.firstElementChild.style.setProperty('--my', (ny * depth * .6).toFixed(1));
      });
    }, { passive: true });
  }

  /* ---------- Work cards ---------- */

  work.cards.forEach(({ el }) => {
    const video = $('video', el);
    const link = $('a', el);
    if (fineMQ.matches) {
      link.addEventListener('pointerenter', () => setWanted(video, true));
      link.addEventListener('pointerleave', () => setWanted(video, false));
    }
    link.addEventListener('focus', () => setWanted(video, true));
    link.addEventListener('blur', () => setWanted(video, false));
  });

  // On touch screens the card centred in the swipe rail plays.
  if (!fineMQ.matches) {
    const railIO = new IntersectionObserver((entries) => {
      entries.forEach((e) => setWanted($('video', e.target), e.isIntersecting));
    }, { threshold: .65 });
    work.cards.forEach(({ el }) => railIO.observe(el));
  }

  // Keep a keyboard-focused card on screen inside the pinned rail.
  work.track.addEventListener('focusin', (e) => {
    const pin = $('[data-work-pin]');
    pin.scrollLeft = 0;
    if (!work.pinned) return;
    const card = work.cards.find((c) => c.el.contains(e.target));
    if (!card) return;
    const p = clamp((card.center - geo.vw / 2) / Math.max(1, work.range));
    window.scrollTo({ top: work.top + p * work.range });
  });

  if (fineMQ.matches && !reduceMQ.matches) {
    $$('[data-tilt]').forEach((link) => {
      const media = $('.card__media', link);
      link.addEventListener('pointermove', (e) => {
        const r = media.getBoundingClientRect();
        const px = clamp((e.clientX - r.left) / r.width);
        const py = clamp((e.clientY - r.top) / r.height);
        media.style.setProperty('--ry', `${((px - .5) * 7).toFixed(2)}deg`);
        media.style.setProperty('--rx', `${((.5 - py) * 7).toFixed(2)}deg`);
        media.style.setProperty('--gx', `${(px * 100).toFixed(1)}%`);
        media.style.setProperty('--gy', `${(py * 100).toFixed(1)}%`);
      }, { passive: true });
      link.addEventListener('pointerleave', () => {
        media.style.setProperty('--rx', '0deg');
        media.style.setProperty('--ry', '0deg');
      });
    });
  }

  /* ---------- Compare slider ---------- */

  (function compare() {
    const box = $('[data-compare]');
    const a = $('[data-compare-a]', box);
    const b = $('[data-compare-b]', box);
    const range = $('.compare__range', box);
    let touched = reduceMQ.matches;
    let visible = false;
    let dragging = false;
    let startedAt = 0;

    const setPos = (v) => {
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
    box.addEventListener('pointermove', (e) => {
      if (dragging) fromPointer(e);
    });
    const end = () => { dragging = false; box.classList.remove('is-dragging'); };
    box.addEventListener('pointerup', (e) => { if (dragging === 'touch') fromPointer(e); end(); });
    box.addEventListener('pointercancel', end);
    box.addEventListener('lostpointercapture', end);
    range.addEventListener('input', () => { touched = true; setPos(Number(range.value)); });

    // Notebook follows Noir Gold; both clips share one timeline.
    function restart() {
      a.currentTime = 0;
      b.currentTime = 0;
      applyVideo(a);
      applyVideo(b);
    }
    a.addEventListener('ended', restart);

    function loop(t) {
      if (!visible) return;
      if (!startedAt) startedAt = t;
      if (!touched) setPos(50 + Math.sin((t - startedAt) / 1500) * 30);
      if (!a.paused && !b.paused && a.readyState > 1 && b.readyState > 1) {
        const drift = a.currentTime - b.currentTime;
        if (Math.abs(drift) > .3) {
          b.currentTime = a.currentTime;
          b.playbackRate = 1;
        } else {
          b.playbackRate = 1 + clamp(drift * .8, -.08, .08);
        }
      }
      requestAnimationFrame(loop);
    }

    new IntersectionObserver(([e]) => {
      visible = e.isIntersecting;
      setWanted(a, visible);
      setWanted(b, visible);
      if (visible) { startedAt = 0; requestAnimationFrame(loop); }
    }, { threshold: .2 }).observe(box);
  })();

  /* ---------- Craft ---------- */

  (function craft() {
    const items = $$('[data-craft-item]');
    const clips = $$('[data-craft-clip]');
    const count = $('[data-craft-count]');
    const videos = clips.map((c) => $('video', c));
    let active = 0;
    let visible = false;

    const sync = () => videos.forEach((v, i) => setWanted(v, visible && i === active));
    const activate = (i) => {
      if (i === active) return;
      active = i;
      items.forEach((el, j) => el.classList.toggle('is-active', j === i));
      clips.forEach((el, j) => el.classList.toggle('is-active', j === i));
      count.textContent = pad(i + 1);
      sync();
    };
    const io = new IntersectionObserver((entries) => {
      if (craftPinMQ.matches) return;
      entries.forEach((e) => { if (e.isIntersecting) activate(items.indexOf(e.target)); });
    }, { rootMargin: wideMQ.matches ? '-50% 0px -50% 0px' : '-68% 0px -30% 0px' });
    items.forEach((el) => io.observe(el));

    const ticks = $$('.craft__ticks i');
    craftMotion.render = (p) => {
      activate(Math.min(items.length - 1, Math.floor(p * items.length)));
      ticks.forEach((t, i) => t.style.setProperty('--f', clamp(p * items.length - i).toFixed(3)));
    };

    new IntersectionObserver(([e]) => {
      visible = e.isIntersecting;
      sync();
    }).observe($('.craft__stage'));
  })();

  /* ---------- Nav state ---------- */

  const navLinks = new Map($$('[data-nav]').map((a) => [a.dataset.nav, a]));
  const navIO = new IntersectionObserver((entries) => {
    entries.forEach((e) => {
      const link = navLinks.get(e.target.id);
      if (link) link.classList.toggle('is-active', e.isIntersecting);
    });
  }, { rootMargin: '-50% 0px -50% 0px' });
  navLinks.forEach((_, id) => { const s = document.getElementById(id); if (s) navIO.observe(s); });

  /* ---------- Cursor + magnetic ---------- */

  if (fineMQ.matches && !reduceMQ.matches) {
    root.classList.add('has-cursor');
    const cursor = $('.cursor');
    const dot = $('.cursor__dot');
    const pill = $('.cursor__pill');
    const text = $('.cursor__text');
    const icon = $('.cursor use');
    let tx = 0, ty = 0, cx = 0, cy = 0, moving = false;
    const placePill = () => { pill.style.transform = `translate3d(${cx.toFixed(1)}px,${cy.toFixed(1)}px,0)`; };
    const move = () => {
      cx = lerp(cx, tx, .3);
      cy = lerp(cy, ty, .3);
      placePill();
      if (Math.abs(tx - cx) + Math.abs(ty - cy) > .2) requestAnimationFrame(move);
      else moving = false;
    };
    addEventListener('pointermove', (e) => {
      tx = e.clientX; ty = e.clientY;
      dot.style.transform = `translate3d(${tx}px,${ty}px,0)`;
      const host = e.target.closest ? e.target.closest('[data-cursor]') : null;
      if (host) {
        if (!cursor.classList.contains('is-on')) { cx = tx; cy = ty; placePill(); }
        text.textContent = host.dataset.cursor;
        icon.setAttribute('href', host.dataset.cursor === 'Drag' ? '#i-drag' : '#i-play');
        cursor.classList.toggle('is-flip', tx > geo.vw - 110);
      }
      cursor.classList.toggle('is-on', Boolean(host));
      if (!moving) { moving = true; requestAnimationFrame(move); }
    }, { passive: true });
    document.addEventListener('pointerleave', () => cursor.classList.remove('is-on'));

    $$('[data-magnetic]').forEach((el) => {
      el.style.transition = 'transform .7s var(--ease)';
      el.addEventListener('pointermove', (e) => {
        const r = el.getBoundingClientRect();
        el.style.transform = `translate(${((e.clientX - r.left - r.width / 2) * .22).toFixed(1)}px,${((e.clientY - r.top - r.height / 2) * .3).toFixed(1)}px)`;
      }, { passive: true });
      el.addEventListener('pointerleave', () => { el.style.transform = ''; });
    });
  }

  /* ---------- Copy email ---------- */

  const copyBtn = $('[data-copy]');
  const copyStatus = $('[data-copy-status]');
  copyBtn.addEventListener('click', async () => {
    const text = copyBtn.dataset.copy;
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      window.prompt('Copy this email:', text);
    }
    if (!ok) return;
    copyBtn.textContent = 'Copied';
    copyStatus.textContent = 'Email copied';
    setTimeout(() => { copyBtn.textContent = 'Copy email'; copyStatus.textContent = ''; }, 2000);
  });

  /* ---------- Player ---------- */

  (function player() {
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
    const nudge = (s) => { if (video.duration) video.currentTime = clamp(video.currentTime + s, 0, video.duration - .05); };

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
    function timeLoop() {
      renderTime();
      rafId = requestAnimationFrame(timeLoop);
    }

    // Where the frame sits over a card, including the rotation of the hero fan.
    function cardPose(el) {
      const r = el.getBoundingClientRect();
      const fan = el.closest('.deck-card');
      const m = fan ? new DOMMatrixReadOnly(getComputedStyle(fan).transform) : null;
      return {
        cx: r.left + r.width / 2,
        cy: r.top + r.height / 2,
        width: m ? el.offsetWidth * Math.hypot(m.a, m.b) : r.width,
        angle: m ? Math.atan2(m.b, m.a) * (180 / Math.PI) : 0,
      };
    }
    // The video always fills the frame's width, so matching widths also works on phones,
    // where the frame is taller than the video.
    function poseTransform(pose) {
      const to = frameEl.getBoundingClientRect();
      const dx = pose.cx - (to.left + to.width / 2);
      const dy = pose.cy - (to.top + to.height / 2);
      return `translate(${dx}px,${dy}px) rotate(${pose.angle}deg) scale(${pose.width / to.width})`;
    }

    function flipFromOrigin() {
      if (reduceMQ.matches || !origin || !origin.isConnected) return;
      const pose = cardPose(origin);
      if (!pose.width) return;
      frameEl.animate(
        [{ transform: poseTransform(pose) }, { transform: 'none' }],
        { duration: 800, easing: 'cubic-bezier(.16,1,.3,1)' },
      );
    }

    function open(slug, trigger) {
      const i = reels.findIndex((r) => r.slug === slug);
      if (i < 0) return;
      origin = trigger ? ($('[data-media]', trigger) || trigger) : null;
      suspended = true;
      applyAll();
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
      if (reduceMQ.matches) { dlg.close(); return; }

      // Finish any opening animation first so the frame is measured at rest.
      frameEl.getAnimations().forEach((a) => a.cancel());
      dlg.classList.remove('is-open');
      dlg.classList.add('is-closing');
      suspended = false;
      applyAll();

      // After switching reels the original card shows something else, so just fade away.
      const pose = index === openedIndex && origin && origin.isConnected ? cardPose(origin) : null;
      const onScreen = pose && pose.width && pose.cy > 0 && pose.cy < geo.vh && pose.cx > 0 && pose.cx < geo.vw;
      const move = frameEl.animate(
        [{ transform: 'none' }, { transform: onScreen ? poseTransform(pose) : 'scale(.94)' }],
        { duration: onScreen ? 620 : 360, easing: 'cubic-bezier(.65,0,.2,1)', fill: 'forwards' },
      );
      // The picture dissolves into the live card as it lands, so nothing pops at the end.
      const fade = frameEl.animate(
        [{ opacity: 1 }, { opacity: 0 }],
        { duration: onScreen ? 280 : 300, delay: onScreen ? 340 : 60, easing: 'linear', fill: 'forwards' },
      );
      Promise.all([move.finished, fade.finished]).catch(() => {}).then(() => { if (dlg.open) dlg.close(); });
    }

    dlg.addEventListener('close', () => {
      closing = false;
      dlg.classList.remove('is-open', 'is-closing');
      frameEl.getAnimations().forEach((a) => a.cancel());
      cancelAnimationFrame(rafId);
      video.pause();
      video.removeAttribute('src');
      video.load();
      root.classList.remove('is-locked');
      suspended = false;
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
  })();

  /* ---------- Start ---------- */

  measure();
  renderHero(smoothY);
  renderWork(smoothY);
  renderHud(smoothY);
  renderCraft(smoothY);
  renderContact(smoothY);
  playIntro();
})();
