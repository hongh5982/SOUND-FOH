// App window frame: our own black title bar and a soft start. Runs only inside the Sound FOH app.
(() => {
  const T = window.__TAURI__;
  if (!T || !T.window) return;
  const win = T.window.getCurrentWindow();
  const root = document.documentElement;
  root.classList.add('in-app', 'booting');

  const css = document.createElement('style');
  css.textContent = `
    html.in-app { --bar-h: 32px; }
    html.in-app body { padding-top: var(--bar-h); }
    html.in-app .splash { height: calc(100vh - var(--bar-h)); }
    html.in-app .room.expanded { top: var(--bar-h); }
    .titlebar { position: fixed; top: 0; left: 0; right: 0; height: var(--bar-h); z-index: 100; display: flex; align-items: center;
      background: #000; color: var(--sub); user-select: none; -webkit-user-select: none; }
    .titlebar .tb-name { flex: 1; height: 100%; display: flex; align-items: center; padding-left: 14px; font-size: 12px; letter-spacing: .02em; color: var(--faint);
      transition: color .2s ease; }
    .titlebar:hover .tb-name { color: var(--sub); }
    .titlebar .tb-btn { width: 46px; height: 100%; display: grid; place-items: center; border: 0; background: transparent; color: #cfcfcf; cursor: default;
      transition: background-color .15s ease, color .15s ease; }
    .titlebar .tb-btn:hover { background: #1c1c1c; color: #fff; }
    .titlebar .tb-btn:active { background: #262626; }
    .titlebar .tb-close:hover { background: #e5484d; color: #fff; }
    .titlebar .tb-close:active { background: #c4363b; }
    .titlebar svg { width: 10px; height: 10px; stroke: currentColor; stroke-width: 1; fill: none; shape-rendering: crispEdges; }
    .titlebar .tb-btn:focus-visible { outline: 1px solid #fff; outline-offset: -3px; }
    /* soft start: black first, then the logo rises in, then the button */
    html.in-app .splash-logo { transition: opacity .9s ease, transform 1.1s cubic-bezier(.2, .7, .2, 1); }
    html.in-app .splash-btn { transition: opacity .7s ease .55s, transform .7s ease .55s; }
    html.booting .splash-logo { opacity: 0; transform: translateY(10px) scale(.985); }
    html.booting .splash-btn { opacity: 0; transform: translateY(6px); }
    html.booting .titlebar .tb-name { opacity: 0; }
    .titlebar .tb-name { transition: opacity .6s ease .3s, color .2s ease; }
    @media (prefers-reduced-motion: reduce) { html.in-app .splash-logo, html.in-app .splash-btn { transition: none; } }
    /* quiet scrollbars instead of the default grey ones */
    html.in-app ::-webkit-scrollbar { width: 10px; height: 10px; }
    html.in-app ::-webkit-scrollbar-track { background: transparent; }
    html.in-app ::-webkit-scrollbar-thumb { background: #2a2a2a; border-radius: 10px; border: 3px solid #000; }
    html.in-app ::-webkit-scrollbar-thumb:hover { background: #3a3a3a; }
  `;
  document.head.appendChild(css);

  const icons = {
    min: '<svg viewBox="0 0 10 10"><path d="M0 5.5h10"/></svg>',
    max: '<svg viewBox="0 0 10 10"><rect x=".5" y=".5" width="9" height="9"/></svg>',
    restore: '<svg viewBox="0 0 10 10"><rect x=".5" y="2.5" width="7" height="7"/><path d="M2.5 2.5V.5h7v7h-2"/></svg>',
    close: '<svg viewBox="0 0 10 10"><path d="M0 0l10 10M10 0L0 10" style="shape-rendering:geometricPrecision"/></svg>',
  };
  const bar = document.createElement('div');
  bar.className = 'titlebar';
  bar.innerHTML = `
    <div class="tb-name" data-tauri-drag-region>Sound FOH</div>
    <button class="tb-btn" data-tb="min" aria-label="최소화" title="최소화">${icons.min}</button>
    <button class="tb-btn" data-tb="max" aria-label="최대화" title="최대화">${icons.max}</button>
    <button class="tb-btn tb-close" data-tb="close" aria-label="닫기" title="닫기">${icons.close}</button>`;
  document.body.prepend(bar);

  const maxBtn = bar.querySelector('[data-tb="max"]');
  async function syncMax() {
    const m = await win.isMaximized().catch(() => false);
    maxBtn.innerHTML = m ? icons.restore : icons.max;
    maxBtn.setAttribute('aria-label', m ? '이전 크기로' : '최대화');
    maxBtn.title = m ? '이전 크기로' : '최대화';
  }
  bar.addEventListener('click', (e) => {
    const b = e.target.closest('[data-tb]');
    if (!b) return;
    e.stopPropagation(); // keep the app's own click handler out of it
    if (b.dataset.tb === 'min') win.minimize();
    if (b.dataset.tb === 'max') win.toggleMaximize();
    if (b.dataset.tb === 'close') win.close();
  });
  win.onResized(() => syncMax());
  syncMax();

  // The window starts hidden (no white flash). Show it once the first screen is drawn, then let the logo rise in.
  // (timers, not animation frames: a hidden window may not draw frames at all)
  setTimeout(async () => {
    try { await win.show(); await win.setFocus(); } catch (e) { console.error(e); }
    setTimeout(() => root.classList.remove('booting'), 150);
  }, 40);
})();
