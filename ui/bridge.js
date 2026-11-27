// Connects the mockup screens to the real audio engine when running inside the Sound FOH app.
// In a normal browser (no window.__TAURI__) nothing here runs, and the mockup keeps its sample data.
(() => {
  const T = window.__TAURI__;
  if (!T || !T.core) return;
  const invoke = T.core.invoke;
  const devId = {};          // screen id -> engine id
  let tone = null;           // running test signal: 'alt' | 'both' | null
  let meterOn = null, polling = false;
  const TAKE = { on: false, layout: null, played: 0, done: false, err: null, meter: -120, t0: 0, busy: false, finishing: false };

  const LOOPBACK = /stereo ?mix|스테레오 ?믹스|what ?u ?hear|loopback|wave ?out|루프백/i;
  const real = () => S.type !== 'phone'; // the phone mic needs the phone app (later step)
  const chIndex = () => S.ch === 'Mono' ? 0 : S.ch ? Math.max(0, parseInt(S.ch.replace(/\D/g, ''), 10) - 1) : -1;

  function note(msg) {
    const body = document.querySelector('#main .body') || document.querySelector('#main');
    if (!body) return;
    let p = body.querySelector('.engine-err');
    if (!p) { p = document.createElement('p'); p.className = 'engine-err'; p.style.cssText = 'color:#ff5a52;font-size:14px;margin:12px 0 0;line-height:1.5'; body.appendChild(p); }
    p.textContent = msg;
  }

  // ---------- devices ----------
  async function loadDevices() {
    try {
      const list = await invoke('list_devices');
      OUTPUTS.length = 0; INPUTS.length = 0;
      list.outputs.forEach((d, i) => {
        const id = 'o' + i; devId[id] = d.id;
        OUTPUTS.push({ id, name: d.name, sub: `${d.channels}채널 · ${d.sample_rate / 1000} kHz${d.is_default ? ' · 기본' : ''}` });
      });
      // loopback inputs ("스테레오 믹스") hear the speakers directly, not the room, so they can't measure anything
      list.inputs.filter(d => !LOOPBACK.test(d.name)).forEach((d, i) => {
        const id = 'i' + i; devId[id] = d.id;
        const ch = d.channels > 1 ? Array.from({ length: d.channels }, (_, k) => 'Input ' + (k + 1)) : ['Mono'];
        INPUTS.push({ id, name: d.name, sub: `입력 ${d.channels}개 · ${d.sample_rate / 1000} kHz${d.is_default ? ' · 기본' : ''}`, ch });
      });
      // a device that vanished since the last pick is cleared so the screen asks again
      if (S.out && !devId[S.out]) S.out = null;
      if (S.inp && !devId[S.inp]) { S.inp = null; S.ch = null; }
      render();
    } catch (e) { note('장치 목록을 불러오지 못했어요: ' + e); }
  }

  // ---------- keep test signal and meter in step with the screen ----------
  const toneVol = () => Math.max(0, Math.min(1, ((tone === 'both' ? S.outLvl : S.outVol) || 0) / 100));

  async function sync() {
    const k = key();
    const want = !devId[S.out] ? null : k === 'output' && S.tone ? 'alt' : k === 'level' && S.lvlOn ? 'both' : null;
    if (want !== tone) {
      tone = want;
      if (!want) invoke('tone_stop');
      else {
        try { await invoke('tone_start', { device: devId[S.out], volume: toneVol(), both: want === 'both' }); }
        catch (e) { tone = null; S.tone = false; S.lvlOn = false; render(); note('소리를 낼 수 없어요: ' + e); }
      }
    }

    const ch = chIndex();
    const wantMeter = ['input', 'level'].includes(k) && real() && devId[S.inp] && ch >= 0 ? `${S.inp}:${ch}` : null;
    if (wantMeter !== meterOn) {
      meterOn = wantMeter;
      if (!wantMeter) invoke('meter_stop');
      else {
        try { await invoke('meter_start', { device: devId[S.inp], channel: ch }); }
        catch (e) { meterOn = null; note('마이크를 열 수 없어요: ' + e); }
      }
    }

    // leaving the run screen or pressing stop ends the take
    if (TAKE.on && !active() && RUN.sub !== 'done') { TAKE.on = false; invoke('measure_stop'); }
  }

  // the screen re-renders often; check the audio after each render
  const baseRender = render;
  render = function () { baseRender.apply(this, arguments); sync(); };

  // ---------- meters ----------
  function meterLoop(id, label) {
    let shown = -120;
    loop(async () => {
      if (polling || !meterOn) return;
      polling = true;
      try {
        const peak = await invoke('meter_level');   // dBFS since the last poll
        const db = Math.min(0, peak + (id === 'inLvl' ? S.gain || 0 : 0));
        shown = Math.max(db, shown - 2.5);          // fast up, slow down
        setLvl(id, shown, ...label(shown, peak));
      } catch (e) { note(String(e)); }
      polling = false;
    });
  }
  const baseInMeter = startInMeter;
  startInMeter = function () {
    if (!real()) return baseInMeter();
    if (!S.ch) return;
    sync();
    meterLoop('inLvl', (db, peak) => peak >= -1 ? ['clip', '너무 커요'] : db < -60 ? ['', '소리가 거의 없어요'] : ['', `${Math.round(db)} dB`]);
  };
  const baseLvMeter = startLvMeter;
  startLvMeter = function () {
    if (!real()) return baseLvMeter();
    sync();
    meterLoop('lvLvl', (db, peak) => peak >= -1 ? ['clip', '너무 커요, 줄여 주세요'] : S.outLvl <= 0 ? ['', '천천히 올려 보세요'] : db < -45 ? ['', '마이크에 소리가 작게 들어와요'] : ['', `${Math.round(db)} dB`]);
  };

  // sliders change the running signal right away
  document.addEventListener('input', (e) => {
    const id = e.target && e.target.id;
    if ((id === 'outVol' && tone === 'alt') || (id === 'outLvl' && tone === 'both')) invoke('tone_volume', { volume: toneVol() });
  });

  // ---------- measurement ----------
  // One take plays room noise, then each sweep with a quiet tail, while recording the mic.

  function fail(msg) {
    TAKE.on = false; invoke('measure_stop');
    RUN.sub = 'stopped'; stopLoop(); render(); note(msg);
  }

  async function startTake(list) {
    if (!devId[S.out] || !devId[S.inp] || chIndex() < 0) return fail('출력 장치와 마이크를 먼저 골라 주세요.');
    Object.assign(TAKE, { on: true, layout: null, played: 0, done: false, err: null, meter: -120, t0: performance.now(), busy: false, finishing: false, noisePeak: -120 });
    try {
      TAKE.layout = await invoke('measure_start', {
        output: devId[S.out], input: devId[S.inp], channel: chIndex(), phases: list, level: Math.max(0, Math.min(1, S.outLvl / 100)),
      });
      TAKE.t0 = performance.now();
      if (key() === 'run' && active()) loop(runTick);
    } catch (e) { fail('측정을 시작할 수 없어요: ' + e); }
  }

  const baseStartRun = startRun;
  startRun = function (list, retry) {
    if (!real()) return baseStartRun(list, retry);
    if (retry) RUN.round++; else { resetRun(); Object.keys(TAKES).forEach(k => delete TAKES[k]); }
    RUN.queue = list; RUN.qi = 0; RUN.accepted = false;
    list.forEach(k => Object.assign(RUN.res[k], { state: 'wait', peak: -99, clip: false, event: false, db: null, snr: null, fr: null }));
    S.step = STEPS.indexOf('run'); S.reached = Math.max(S.reached, S.step);
    RUN.sub = 'gap'; RUN.prog = 0;
    TAKE.layout = null;
    render();
    startTake(list);
  };
  // "이어서 측정" starts a new take from the step that was stopped (room noise is checked again)
  const baseBeginPhase = beginPhase;
  beginPhase = function () {
    if (!real()) return baseBeginPhase();
    // a stopped take is never analysed, so every sweep without a result is measured again
    const rest = SWEEPS.filter(k => RUN.queue.includes(k) && !RUN.res[k].fr);
    startRun(['noise', ...rest], true);
  };

  function poll() {
    if (TAKE.busy) return;
    TAKE.busy = true;
    Promise.all([invoke('measure_status'), invoke('meter_level')]).then(([st, m]) => {
      TAKE.played = st.played; TAKE.done = st.done; TAKE.err = st.error; TAKE.offset = st.offset;
      TAKE.meter = m;
    }).catch(e => { TAKE.err = String(e); }).finally(() => { TAKE.busy = false; });
  }

  const baseRunTick = runTick;
  runTick = function () {
    if (!real()) return baseRunTick();
    if (!active() || !TAKE.on || !TAKE.layout || TAKE.finishing) return;
    poll();
    const L = TAKE.layout, el = performance.now() - TAKE.t0;
    if (TAKE.err) return fail(TAKE.err);
    if (TAKE.played === 0 && el > 4000) return fail('스피커로 소리를 보낼 수 없어요. 출력 장치를 확인해 주세요.');
    if (TAKE.played >= L.total && !TAKE.done && el > L.total / L.out_rate * 1000 + 4000) return fail('마이크 소리가 들어오지 않아요. 입력 장치를 확인해 주세요.');
    if (TAKE.done) return finish();

    // where in the program are we?
    const pos = TAKE.played, seg = L.segs.find(s => pos < s.start + s.len) || L.segs[L.segs.length - 1];
    const qi = seg.kind === 'lead' ? 0 : Math.max(0, RUN.queue.indexOf(seg.phase));
    const sub = seg.kind === 'noise' ? 'noise' : seg.kind === 'sweep' ? 'sweep' : 'gap';
    const prog = Math.min(1, Math.max(0, (pos - seg.start) / seg.len));
    const changed = qi !== RUN.qi || sub !== RUN.sub;
    RUN.qi = qi; RUN.sub = sub; RUN.prog = sub === 'gap' ? 0 : prog;
    RUN.queue.forEach((k, i) => {
      const r = RUN.res[k];
      r.state = i < qi || (i === qi && seg.kind === 'tail') ? 'done' : i === qi && sub !== 'gap' ? 'run' : 'wait';
    });
    if (sub === 'sweep') RUN.f = 20 * Math.pow(1000, prog);
    if (changed) return render();

    // live readouts
    const pg = $('#pg'); if (pg) pg.style.width = RUN.prog * 100 + '%';
    if (sub === 'sweep') {
      const fq = $('#fq'); if (fq) fq.innerHTML = fmtHz(RUN.f);
      const mk = $('#bdMk'); if (mk) mk.style.left = prog * 100 + '%';
      const bf = $('#bdFill'); if (bf) bf.style.width = prog * 100 + '%';
    }
    const db = Math.min(0, TAKE.meter);
    if (sub === 'noise') TAKE.noisePeak = Math.max(TAKE.noisePeak, db);
    // "잘 들어와요" only when the sweep clearly stands above the room noise heard a moment ago
    const floor = TAKE.noisePeak > -120 ? TAKE.noisePeak : -60;
    const txt = db >= -1 ? '찌그러졌어요' : sub === 'noise' ? (db > -45 ? '조금 시끄러워요' : '조용해요')
      : sub === 'sweep' ? (db < -45 || db < floor + 10 ? '소리가 작아요' : '잘 들어와요') : '쉬는 중';
    setLvl('lvl', db, db >= -1 ? 'clip' : sub === 'noise' && db > -45 ? 'high' : '', txt);
  };

  async function finish() {
    TAKE.finishing = true;
    RUN.queue.forEach(k => { RUN.res[k].state = 'done'; });
    RUN.sub = 'done'; stopLoop(); render();
    try {
      const buf = await invoke('measure_take');
      const st = await invoke('measure_status');
      analyse(new Float32Array(buf), st.offset);
    } catch (e) {
      return fail('측정 결과를 계산하지 못했어요: ' + e);
    } finally {
      TAKE.on = false; invoke('measure_stop');
    }
    if (key() === 'run' && RUN.sub === 'done') go(STEPS.indexOf('check'));
  }

  // linear resampling when the mic runs at another sample rate than the speakers
  function resample(x, from, to) {
    const n = Math.floor(x.length * to / from), y = new Float32Array(n), k = from / to;
    for (let i = 0; i < n; i++) { const p = i * k, j = Math.floor(p), f = p - j; y[i] = (x[j] || 0) * (1 - f) + (x[j + 1] || 0) * f; }
    return y;
  }

  function analyse(rec, offset) {
    const L = TAKE.layout, fs = L.out_rate;
    if (L.in_rate !== fs) { rec = resample(rec, L.in_rate, fs); offset = Math.round(offset * fs / L.in_rate); }
    const at = (s) => offset + s;   // program sample -> recording sample (same clock offset for the whole take)
    const sw = DSP.sweep(fs, 5, 20, 20000, L.sweep_amp);
    const freqs = DSP.logFreqs(240, 20, 20000), margin = Math.round(0.05 * fs);
    const out = { when: new Date().toISOString(), outRate: L.out_rate, inRate: L.in_rate, level: S.outLvl, offset, runs: {} };

    const nz = L.segs.find(s => s.kind === 'noise');
    let noiseDb = null;
    if (nz) {
      const a = Math.max(0, at(nz.start + Math.round(0.25 * fs))), b = Math.min(rec.length, at(nz.start + nz.len));
      noiseDb = DSP.dbfs(DSP.rms(rec, a, b));
      RUN.res.noise.db = noiseDb; RUN.res.noise.state = 'done';
      out.noiseDb = +noiseDb.toFixed(1);
    }
    const nDb = noiseDb ?? RUN.res.noise.db ?? -90;
    const takes = {};
    L.segs.filter(s => s.kind === 'sweep').forEach(s => {
      const tail = L.segs.find(t => t.kind === 'tail' && t.phase === s.phase);
      const a = Math.max(0, at(s.start) - margin), b = Math.min(rec.length, at(s.start + s.len + (tail ? tail.len : 0)));
      const chunk = rec.subarray(a, b);
      let pk = 0, hard = 0;
      for (let i = 0; i < chunk.length; i++) { const v = Math.abs(chunk[i]); if (v > pk) pk = v; if (v >= 0.99) hard++; }
      const sigDb = DSP.dbfs(DSP.rms(rec, Math.max(0, at(s.start)), Math.min(rec.length, at(s.start + s.len))));
      const ir = DSP.deconvolve(chunk, sw, fs), p = DSP.peakIndex(ir, chunk.length);
      const db = DSP.response(ir, fs, p, freqs, { smooth: 6 });
      const r = RUN.res[s.phase];
      Object.assign(r, {
        state: 'done', peak: DSP.dbfs(pk), clip: hard >= 3, event: false,
        snr: sigDb - nDb, delayMs: (p - (at(s.start) - a)) / fs * 1000, fr: { freqs, db },
      });
      takes[s.phase] = { ir, peak: p, arrivalMs: r.delayMs };
      out.runs[s.phase] = { peakDb: +r.peak.toFixed(1), clip: r.clip, snr: +r.snr.toFixed(1), delayMs: +r.delayMs.toFixed(2), db: db.map(v => +v.toFixed(2)) };
    });
    out.freqs = freqs.map(f => +f.toFixed(1));
    // a re-measure only redoes some speakers: keep the last good take of the others
    Object.keys(takes).forEach(k => { TAKES[k] = takes[k]; });
    showAnalysis(fs);
    out.issues = ISSUES.map(it => ({ kind: it.kind, t: it.t, ev: it.ev }));
    out.decay = ANA.decay; out.arrival = ANA.arrival;
    invoke('save_measurement', { json: JSON.stringify(out) }).catch(() => {});
    console.log('measurement', out);
  }

  // ---------- results: problems and graphs from the real takes ----------
  const TAKES = {};
  function showAnalysis(fs) {
    ANA = ANALYSIS.run(TAKES, fs);
    ISSUES.length = 0;
    ANA.issues.forEach(it => ISSUES.push(it));
    S.openIssue = null; S.dIssue = null;
    const a = ANA.arrival, tab = TABS.find(t => t[0] === 'ir');
    if (tab && a.L != null && a.R != null) {
      const d = a.R - a.L;
      tab[2] = Math.abs(d) < 0.05 ? '소리가 마이크에 도착한 순간이에요. L과 R이 거의 동시에 도착해요.'
        : `소리가 마이크에 도착한 순간이에요. ${d > 0 ? 'L이 R' : 'R이 L'}보다 ${Math.abs(d).toFixed(2)} ms 먼저 도착해요.`;
    }
  }

  // ---------- small things ----------
  // pick up devices plugged in while the app is open
  window.addEventListener('focus', () => { if (['output', 'input'].includes(key())) loadDevices(); });

  // in the app, the sample-data bar is only for screens that are not real yet
  const baseMock = renderMock;
  renderMock = function () {
    baseMock();
    const m = document.getElementById('mock');
    if (m) m.lastElementChild.textContent = '· 튜닝부터는 아직 견본이에요';
  };

  loadDevices();
})();
