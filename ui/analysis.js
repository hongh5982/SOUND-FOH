// ---- Sound FOH analysis: turns the three measured impulse responses into graphs and a list of problems ----
// Pure functions on top of DSP (dsp.js). The thresholds below are starting values to be tuned with real rooms.
const ANALYSIS = (() => {
  const LIMITS = {
    peakDb: 4,          // a band this much above its surroundings can be cut with EQ
    dipDb: 6,           // a bass dip this deep is a room cancellation EQ can't fill
    dipMaxHz: 300,
    balanceDb: 1,       // left/right level difference
    arrivalMs: 0.2,     // left/right arrival difference (about 7 cm)
    bassDecayS: 0.6,    // bass ringing longer than this, and
    bassDecayRatio: 1.5, // this many times the mid-band decay
    maxPeaks: 3, maxDips: 2,
  };
  const C = 343; // speed of sound, m/s

  const logFreqs = (n, f1, f2) => Array.from({ length: n }, (_, i) => f1 * Math.pow(f2 / f1, i / (n - 1)));
  const FREQS = logFreqs(240, 20, 20000);
  const mean = (a) => a.reduce((s, v) => s + v, 0) / Math.max(1, a.length);
  const median = (a) => { const b = [...a].sort((x, y) => x - y); return b.length ? b[b.length >> 1] : NaN; };
  const between = (freqs, vals, f1, f2) => vals.filter((_, i) => freqs[i] >= f1 && freqs[i] <= f2);

  // complex spectrum of a windowed piece of the impulse response, read at the given frequencies with 1/n-octave averaging
  function spectrum(ir, fs, start, len, freqs, smooth) {
    const N = DSP_pow2(Math.max(len, fs)), re = new Float64Array(N), im = new Float64Array(N);
    const fadeIn = Math.min(len, Math.round(0.001 * fs)), fadeOut = Math.round(len * 0.3);
    for (let i = 0; i < len; i++) {
      let w = 1;
      if (i < fadeIn) w = 0.5 - 0.5 * Math.cos(Math.PI * i / Math.max(1, fadeIn));
      if (i > len - fadeOut) w = 0.5 - 0.5 * Math.cos(Math.PI * (len - i) / fadeOut);
      re[i] = (ir[start + i] || 0) * w;
    }
    DSP.fft(re, im);
    return freqs.map(f => {
      const k0 = Math.max(1, Math.floor(f * Math.pow(2, -0.5 / smooth) * N / fs)), k1 = Math.max(k0, Math.ceil(f * Math.pow(2, 0.5 / smooth) * N / fs));
      let r = 0, m = 0;
      for (let k = k0; k <= k1; k++) { r += re[k]; m += im[k]; }
      return [r / (k1 - k0 + 1), m / (k1 - k0 + 1)];
    });
  }
  function DSP_pow2(n) { let p = 1; while (p < n) p <<= 1; return p; }

  // level of each point compared with the band around it (half an octave to an octave and a half away)
  function deviation(freqs, db) {
    return freqs.map((f, i) => {
      const near = [];
      freqs.forEach((g, j) => { const o = Math.abs(Math.log2(g / f)); if (o >= 0.5 && o <= 1.5) near.push(db[j]); });
      return db[i] - mean(near);
    });
  }
  // local extremes of a deviation curve, strongest first, at least 1/3 octave apart
  function extremes(freqs, dev, sign, limit, f1, f2) {
    const out = [];
    for (let i = 1; i < freqs.length - 1; i++) {
      const f = freqs[i], v = dev[i] * sign;
      if (f < f1 || f > f2 || v < limit) continue;
      if (v >= dev[i - 1] * sign && v >= dev[i + 1] * sign) out.push({ f, dev: dev[i] });
    }
    out.sort((a, b) => Math.abs(b.dev) - Math.abs(a.dev));
    const kept = [];
    out.forEach(p => { if (kept.every(k => Math.abs(Math.log2(k.f / p.f)) > 1 / 3)) kept.push(p); });
    return kept;
  }

  // decay time per octave from the Schroeder backward integral (T20 fit, scaled to 60 dB), with the noise floor taken out
  const OCTAVES = [63, 125, 250, 500, 1000, 2000, 4000, 8000];
  function decayTimes(ir, fs, peak) {
    const start = Math.max(0, peak - Math.round(0.001 * fs)), len = Math.min(ir.length - start, Math.round(1.0 * fs));
    const N = DSP_pow2(len);
    return OCTAVES.map(fc => {
      const re = new Float64Array(N), im = new Float64Array(N);
      for (let i = 0; i < len; i++) re[i] = ir[start + i] || 0;
      DSP.fft(re, im);
      const lo = fc / Math.SQRT2, hi = fc * Math.SQRT2;
      for (let k = 0; k < N; k++) { const f = Math.min(k, N - k) * fs / N; if (f < lo || f > hi) { re[k] = 0; im[k] = 0; } }
      DSP.fft(re, im, true);
      // noise-aware Schroeder integral: estimate the noise floor at the end, stop integrating where the decay reaches it
      const h2 = Float64Array.from(re.subarray(0, len), v => v * v);
      const tail = Math.round(len * 0.2); let noise = 0;
      for (let i = len - tail; i < len; i++) noise += h2[i];
      noise /= tail;
      const win = Math.max(1, Math.round(0.01 * fs)); let run = 0, envMax = 0, tc = len;
      for (let i = 0; i < len; i++) {
        run += h2[i] - (i >= win ? h2[i - win] : 0);
        const env = run / Math.min(i + 1, win);
        if (env > envMax) envMax = env;
        if (i > win && tc === len && env <= noise * 2 && envMax > 0) tc = i;
      }
      // not enough clean decay above the noise to read 25 dB of it
      if (!(envMax > noise * 1000)) return { f: fc, t: null };
      const e = new Float64Array(tc); let acc = 0;
      for (let i = tc - 1; i >= 0; i--) { acc += Math.max(0, h2[i] - noise); e[i] = acc; }
      const e0 = e[0] || 1e-30, dB = (i) => 10 * Math.log10(e[i] / e0 + 1e-30);
      let i5 = -1, i25 = -1;
      for (let i = 0; i < tc; i++) { const d = dB(i); if (i5 < 0 && d <= -5) i5 = i; if (d <= -25) { i25 = i; break; } }
      if (i5 < 0 || i25 < 0) return { f: fc, t: null };
      return { f: fc, t: +(3 * (i25 - i5) / fs).toFixed(2) };
    });
  }

  const fmtF = (f) => f >= 1000 ? `${+(f / 1000).toFixed(f >= 10000 ? 0 : 1)} kHz` : `${f < 200 ? Math.round(f) : Math.round(f / 10) * 10} Hz`;
  const r1 = (v) => Math.abs(v).toFixed(1);
  function peakText(f) {
    if (f < 250) return [`${fmtF(f)} 근처 저음이 부풀어요`, '방 크기나 스피커 위치 때문에 생기는 저음 울림이 이 대역을 키워요.'];
    if (f < 2000) return [`${fmtF(f)} 근처 소리가 튀어요`, '스피커 특성이나 가까운 벽·책상에서 돌아온 소리가 이 대역을 키워요.'];
    if (f < 6000) return [`${fmtF(f)} 근처 소리가 날카로워요`, '스피커의 고음 특성 때문일 수 있어요.'];
    return [`${fmtF(f)} 근처 고음이 강해요`, '스피커의 고음 특성이나 마이크 방향 때문일 수 있어요.'];
  }

  /**
   * takes: { L: { ir, peak, arrivalMs }, R: {...}, LR: {...} } (any may be missing), fs
   * returns everything the result and detail screens draw.
   */
  function run(takes, fs) {
    const chs = ['L', 'R', 'LR'].filter(k => takes[k]);
    const fr = {}, ph = {}, irv = {};
    chs.forEach(k => { const t = takes[k]; fr[k] = DSP.response(t.ir, fs, t.peak, FREQS, { smooth: 6 }); });

    // put the two single speakers around 0 dB (200 Hz–2 kHz)
    const refs = ['L', 'R'].filter(k => fr[k]).map(k => mean(between(FREQS, fr[k], 200, 2000)));
    const ref = refs.length ? mean(refs) : mean(between(FREQS, fr[chs[0]], 200, 2000));
    chs.forEach(k => { fr[k] = fr[k].map(v => v - ref); });

    // phase and impulse are drawn against the first sound to arrive
    const first = Math.min(...chs.map(k => takes[k].arrivalMs));
    chs.forEach(k => {
      const t = takes[k], lagMs = t.arrivalMs - first, pre = Math.round(0.001 * fs);
      const start = Math.max(0, t.peak - pre - Math.round(lagMs / 1000 * fs));
      const sp = spectrum(t.ir, fs, start, Math.round(0.05 * fs), FREQS, 6);
      ph[k] = sp.map(([r, m]) => Math.atan2(m, r) * 180 / Math.PI);
      // 10 ms of impulse from 2 ms before the first arrival
      const s0 = t.peak - Math.round((lagMs + 2) / 1000 * fs), n = Math.round(0.010 * fs);
      irv[k] = Array.from({ length: n }, (_, i) => t.ir[s0 + i] || 0);
    });
    const irMax = Math.max(1e-12, ...chs.flatMap(k => irv[k].map(Math.abs)));
    chs.forEach(k => { irv[k] = irv[k].map(v => v / irMax); });

    const decay = decayTimes((takes.LR || takes.L || takes.R).ir, fs, (takes.LR || takes.L || takes.R).peak);
    const arrival = {}; chs.forEach(k => { arrival[k] = +(takes[k].arrivalMs - first).toFixed(3); });

    // ---------- problems ----------
    const issues = [];
    // peaks and dips on what both speakers do (power average of L and R, or L+R when singles are missing)
    const both = fr.L && fr.R ? FREQS.map((_, i) => 10 * Math.log10((Math.pow(10, fr.L[i] / 10) + Math.pow(10, fr.R[i] / 10)) / 2)) : fr.LR;
    const dev = deviation(FREQS, both);
    extremes(FREQS, dev, 1, LIMITS.peakDb, 30, 12000).slice(0, LIMITS.maxPeaks).forEach(p => {
      const [t, why] = peakText(p.f);
      issues.push({ kind: 'tune', t, target: ['L', 'R'], why,
        ev: `L, R 측정에서 ${fmtF(p.f)} 부근이 주변보다 약 ${r1(p.dev)} dB 높아요.`, fix: '자동 튜닝이 이 대역을 낮춰서 맞춰요.',
        mark: { tab: 'fr', f: p.f, band: [p.f / Math.pow(2, 1 / 6), p.f * Math.pow(2, 1 / 6)] }, f: p.f, db: p.dev });
    });
    if (fr.L && fr.R) {
      const d = mean(between(FREQS, fr.L, 200, 2000)) - mean(between(FREQS, fr.R, 200, 2000));
      if (Math.abs(d) > LIMITS.balanceDb) {
        const loud = d > 0 ? 'L' : 'R';
        issues.push({ kind: 'tune', t: d > 0 ? '왼쪽이 오른쪽보다 커요' : '오른쪽이 왼쪽보다 커요', target: [loud],
          why: '스피커 볼륨이나 거리 차이 때문일 수 있어요.', ev: `${loud}이 ${loud === 'L' ? 'R' : 'L'}보다 평균 ${r1(d)} dB 커요.`,
          fix: `자동 튜닝이 ${loud}을 ${r1(d)} dB 낮춰 맞춰요.`, mark: { tab: 'fr', f: 700, ch: loud }, db: d });
      }
    }
    if (takes.L && takes.R) {
      const dt = takes.R.arrivalMs - takes.L.arrivalMs;
      if (Math.abs(dt) > LIMITS.arrivalMs) {
        const late = dt > 0 ? 'R' : 'L', early = late === 'R' ? 'L' : 'R', cm = Math.round(Math.abs(dt) / 1000 * C * 100);
        issues.push({ kind: 'tune', t: `${early === 'L' ? '왼쪽' : '오른쪽'} 소리가 먼저 도착해요`, target: [early],
          why: '듣는 자리가 한쪽 스피커에 더 가까워요.', ev: `${late} 소리가 ${early}보다 ${Math.abs(dt).toFixed(2)} ms(약 ${cm} cm) 늦게 도착해요.`,
          fix: `자동 튜닝이 ${early}을 ${Math.abs(dt).toFixed(2)} ms 늦춰 맞춰요. 의자를 가운데로 옮겨도 좋아요.`,
          mark: { tab: 'ir', ch: late }, ms: dt });
      }
    }
    // bass dips: in the single speakers (room) or only when both play (the two speakers cancel each other there)
    const dips = extremes(FREQS, dev, -1, LIMITS.dipDb, 30, LIMITS.dipMaxHz).map(p => ({ ...p, src: 'L, R' }));
    if (fr.LR && fr.L && fr.R) extremes(FREQS, deviation(FREQS, fr.LR), -1, LIMITS.dipDb, 30, LIMITS.dipMaxHz)
      .forEach(p => { if (dips.every(d => Math.abs(Math.log2(d.f / p.f)) > 1 / 3)) dips.push({ ...p, src: 'L+R' }); });
    dips.sort((a, b) => a.dev - b.dev);
    dips.slice(0, LIMITS.maxDips).forEach(p => {
      issues.push({ kind: 'phys', t: `${fmtF(p.f)} 근처 소리가 비어요`, target: ['seat'],
        why: p.src === 'L+R' ? '두 스피커 소리가 듣는 자리에서 겹쳐 서로 지워질 때 생겨요.' : '보통 벽이나 바닥에서 돌아온 소리와 겹쳐 서로 지워질 때 생겨요.',
        ev: `${p.src} 측정에서 ${fmtF(p.f)} 부근이 주변보다 약 ${r1(p.dev)} dB 낮아요.`,
        fix: 'EQ로 올려도 잘 채워지지 않아요. 스피커를 벽에서 20~30 cm 옮기거나 앉는 자리를 조금 바꿔 보세요.',
        mark: { tab: 'fr', f: p.f, band: [p.f / Math.pow(2, 1 / 6), p.f * Math.pow(2, 1 / 6)] }, f: p.f, db: p.dev });
    });
    const mid = median(decay.filter(d => d.f >= 500 && d.f <= 2000 && d.t != null).map(d => d.t));
    const bass = decay.filter(d => d.f <= 125 && d.t != null).sort((a, b) => b.t - a.t)[0];
    if (bass && bass.t > LIMITS.bassDecayS && (!(mid > 0) || bass.t > mid * LIMITS.bassDecayRatio)) {
      issues.push({ kind: 'phys', t: '저음 울림이 길게 남아요', target: ['seat'],
        why: '방이 저음을 오래 붙잡고 있어요. 물건이 적거나 벽이 딱딱한 방에서 흔해요.',
        ev: `${fmtF(bass.f)} 대역 소리가 사라지는 데 약 ${bass.t.toFixed(2)}초 걸려요${mid > 0 ? `. 중음은 ${mid.toFixed(2)}초예요` : ''}.`,
        fix: 'EQ로는 줄어들지 않아요. 러그, 커튼, 소파 같은 부드러운 물건을 두거나 스피커를 방 모서리에서 떼어 보세요.',
        mark: { tab: 'dc', f: bass.f }, t60: bass.t });
    }
    // tune problems first, then physical ones (numbers on the graphs follow this order)
    issues.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'tune' ? -1 : 1));
    return { freqs: FREQS, fr, ph, irv, irMs: 10, decay, arrival, issues, ref };
  }

  return { run, LIMITS, FREQS, deviation, extremes, decayTimes };
})();
if (typeof module !== 'undefined') module.exports = ANALYSIS;
