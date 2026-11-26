// Connects the mockup screens to the real audio engine when running inside the S'FOH app.
// In a normal browser (no window.__TAURI__) nothing here runs, and the mockup keeps its sample data.
(() => {
  const T = window.__TAURI__;
  if (!T || !T.core) return;
  const invoke = T.core.invoke;
  const devId = {};          // screen id -> engine id
  const devCh = {};          // input screen id -> channel count
  let toneOn = false, meterOn = null, polling = false, lastErr = '';

  const showErr = (msg) => { lastErr = msg; console.error(msg); const st = document.getElementById('inLvlSt'); if (st) st.textContent = msg; };

  async function loadDevices() {
    try {
      const list = await invoke('list_devices');
      OUTPUTS.length = 0; INPUTS.length = 0;
      list.outputs.forEach((d, i) => {
        const id = 'o' + i; devId[id] = d.id;
        OUTPUTS.push({ id, name: d.name, sub: `${d.channels}채널 · ${d.sample_rate / 1000} kHz${d.is_default ? ' · 기본' : ''}` });
      });
      list.inputs.forEach((d, i) => {
        const id = 'i' + i; devId[id] = d.id; devCh[id] = d.channels;
        const ch = d.channels > 1 ? Array.from({ length: d.channels }, (_, k) => 'Input ' + (k + 1)) : ['Mono'];
        INPUTS.push({ id, name: d.name, sub: `입력 ${d.channels}개 · ${d.sample_rate / 1000} kHz${d.is_default ? ' · 기본' : ''}`, ch });
      });
      // a device that vanished since the last pick is cleared so the screen asks again
      if (S.out && !devId[S.out]) S.out = null;
      if (S.inp && !devId[S.inp]) { S.inp = null; S.ch = null; }
      render();
    } catch (e) { showErr('장치 목록을 불러오지 못했어요: ' + e); }
  }

  const vol = () => Math.max(0, Math.min(1, (S.outVol || 0) / 100));

  // keep the real audio in step with what the screen shows
  async function sync() {
    const wantTone = S.tone && key() === 'output' && devId[S.out];
    if (wantTone && !toneOn) {
      toneOn = true;
      try { await invoke('tone_start', { device: devId[S.out], volume: vol() }); }
      catch (e) { toneOn = false; S.tone = false; render(); alertBox('소리를 낼 수 없어요: ' + e); }
    } else if (!wantTone && toneOn) { toneOn = false; invoke('tone_stop'); }

    const chIdx = S.ch === 'Mono' ? 0 : S.ch ? Math.max(0, parseInt(S.ch.replace(/\D/g, ''), 10) - 1) : -1;
    const wantMeter = key() === 'input' && S.type !== 'phone' && devId[S.inp] && chIdx >= 0 ? `${S.inp}:${chIdx}` : null;
    if (wantMeter !== meterOn) {
      meterOn = wantMeter;
      if (!wantMeter) invoke('meter_stop');
      else {
        try { await invoke('meter_start', { device: devId[S.inp], channel: chIdx }); lastErr = ''; }
        catch (e) { meterOn = null; showErr('마이크를 열 수 없어요: ' + e); }
      }
    }
  }

  function alertBox(msg) {
    const n = document.querySelector('#main .now');
    if (!n) return;
    let p = n.querySelector('.engine-err');
    if (!p) { p = document.createElement('p'); p.className = 'engine-err'; p.style.cssText = 'color:#ff5a52;font-size:14px;margin:8px 0 0'; n.appendChild(p); }
    p.textContent = msg;
  }

  // the screen re-renders often; check the audio after each render
  const baseRender = render;
  render = function () { baseRender.apply(this, arguments); sync(); };

  // real input meter (replaces the simulated one)
  let shown = -120;
  startInMeter = function () {
    if (S.type === 'phone') return; // phone mic comes in a later step
    if (!S.ch) return;
    sync();
    loop(async () => {
      if (polling || !meterOn) return;
      polling = true;
      try {
        const peak = await invoke('meter_level');   // dBFS since the last poll
        const db = Math.min(0, peak + (S.gain || 0)); // the gain slider is a digital boost for now
        shown = Math.max(db, shown - 2.5);            // fast up, slow down
        const clip = peak >= -1;
        const txt = clip ? '너무 커요' : shown < -60 ? '소리가 거의 없어요' : `${Math.round(shown)} dB`;
        setLvl('inLvl', shown, clip ? 'clip' : '', txt);
      } catch (e) { showErr(String(e)); }
      polling = false;
    });
  };

  // volume slider changes the running tone right away
  document.addEventListener('input', (e) => {
    if (e.target && e.target.id === 'outVol' && toneOn) invoke('tone_volume', { volume: vol() });
  });

  // pick up devices plugged in while the app is open
  window.addEventListener('focus', () => { if (['output', 'input'].includes(key())) loadDevices(); });

  // in the app, the sample-data bar is only for screens that are not real yet
  const baseMock = renderMock;
  renderMock = function () {
    baseMock();
    const m = document.getElementById('mock');
    if (m) m.lastElementChild.textContent = '· 측정 이후 화면은 아직 견본이에요';
  };

  loadDevices();
})();
