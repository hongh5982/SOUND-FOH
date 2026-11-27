// ---- Sound FOH measurement core (sweep, deconvolution, response); checked by the synthetic-room self-test ----
const DSP = (() => {
  function fft(re, im, inv) { // in-place radix-2
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit;
      if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = 2 * Math.PI / len * (inv ? 1 : -1), wr = Math.cos(ang), wi = Math.sin(ang), h = len >> 1;
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < h; k++) {
          const a = i + k, b = a + h, xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
          re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
          const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
        }
      }
    }
    if (inv) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
  }
  const pow2 = (n) => { let p = 1; while (p < n) p <<= 1; return p; };
  // exponential sine sweep (Farina), with short fades
  function sweep(fs, T = 5, f1 = 20, f2 = 20000, amp = 0.5) {
    const n = Math.round(T * fs), L = T / Math.log(f2 / f1), x = new Float32Array(n);
    const fi = Math.round(0.03 * fs), fo = Math.round(0.005 * fs);
    for (let i = 0; i < n; i++) {
      const t = i / fs; let g = amp;
      if (i < fi) g *= 0.5 - 0.5 * Math.cos(Math.PI * i / fi);
      if (i > n - fo) g *= 0.5 - 0.5 * Math.cos(Math.PI * (n - i) / fo);
      x[i] = g * Math.sin(2 * Math.PI * f1 * L * (Math.exp(t / L) - 1));
    }
    return x;
  }
  // impulse response = recording ÷ sweep in the frequency domain (regularised outside the sweep band)
  function deconvolve(rec, sw, fs, f1 = 20, f2 = 20000) {
    const N = pow2(rec.length + sw.length);
    const yr = new Float64Array(N), yi = new Float64Array(N), xr = new Float64Array(N), xi = new Float64Array(N);
    yr.set(rec); xr.set(sw); fft(yr, yi); fft(xr, xi);
    let mx = 0; for (let k = 0; k < N; k++) mx = Math.max(mx, xr[k] * xr[k] + xi[k] * xi[k]);
    for (let k = 0; k < N; k++) {
      const f = Math.min(k, N - k) * fs / N, inBand = f >= f1 && f <= f2;
      const d = xr[k] * xr[k] + xi[k] * xi[k] + mx * (inBand ? 1e-8 : 1e-2);
      const r = (yr[k] * xr[k] + yi[k] * xi[k]) / d, i = (yi[k] * xr[k] - yr[k] * xi[k]) / d;
      yr[k] = r; yi[k] = i;
    }
    fft(yr, yi, true);
    return yr; // length N; causal part at the start
  }
  function peakIndex(ir, limit) { let m = 0, p = 0; for (let i = 0; i < limit; i++) { const a = Math.abs(ir[i]); if (a > m) { m = a; p = i; } } return p; }
  // windowed IR -> magnitude in dB at given frequencies, optional 1/n-octave smoothing
  function response(ir, fs, peak, freqs, { pre = 0.001, post = 0.5, smooth = 6 } = {}) {
    const a = Math.max(0, peak - Math.round(pre * fs)), b = Math.min(ir.length, peak + Math.round(post * fs)), len = b - a;
    const N = pow2(Math.max(len, fs)), re = new Float64Array(N), im = new Float64Array(N);
    const fadeIn = peak - a, fadeOut = Math.round(len * 0.3);
    for (let i = 0; i < len; i++) {
      let w = 1;
      if (i < fadeIn) w = 0.5 - 0.5 * Math.cos(Math.PI * i / Math.max(1, fadeIn));
      if (i > len - fadeOut) w = 0.5 - 0.5 * Math.cos(Math.PI * (len - i) / fadeOut);
      re[i] = ir[a + i] * w;
    }
    fft(re, im);
    const pw = (k) => re[k] * re[k] + im[k] * im[k];
    return freqs.map(f => {
      let lo = f, hi = f;
      if (smooth) { lo = f * Math.pow(2, -0.5 / smooth); hi = f * Math.pow(2, 0.5 / smooth); }
      let k0 = Math.floor(lo * N / fs), k1 = Math.max(k0, Math.ceil(hi * N / fs)), s = 0;
      if (!smooth) { const k = Math.round(f * N / fs); return 10 * Math.log10(pw(k) + 1e-30); }
      for (let k = k0; k <= k1; k++) s += pw(k);
      return 10 * Math.log10(s / (k1 - k0 + 1) + 1e-30);
    });
  }
  const logFreqs = (n = 240, f1 = 20, f2 = 20000) => Array.from({ length: n }, (_, i) => f1 * Math.pow(f2 / f1, i / (n - 1)));
  // peaking biquad (RBJ) for the fake room
  function peaking(fs, f0, g, q) {
    const A = Math.pow(10, g / 40), w0 = 2 * Math.PI * f0 / fs, al = Math.sin(w0) / (2 * q), c = Math.cos(w0), a0 = 1 + al / A;
    return { b: [(1 + al * A) / a0, -2 * c / a0, (1 - al * A) / a0], a: [1, -2 * c / a0, (1 - al / A) / a0] };
  }
  function filt(x, { b, a }) { const y = new Float64Array(x.length); let x1 = 0, x2 = 0, y1 = 0, y2 = 0; for (let i = 0; i < x.length; i++) { const v = b[0] * x[i] + b[1] * x1 + b[2] * x2 - a[1] * y1 - a[2] * y2; x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v; } return y; }
  function biquadDb({ b, a }, f, fs) {
    const w = 2 * Math.PI * f / fs, c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
    const nr = b[0] + b[1] * c1 + b[2] * c2, ni = -(b[1] * s1 + b[2] * s2), dr = a[0] + a[1] * c1 + a[2] * c2, di = -(a[1] * s1 + a[2] * s2);
    return 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di));
  }
  // simple seeded noise so the self-test is repeatable
  function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
  function gauss(r) { let u = 0, v = 0; while (u === 0) u = r(); v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
  const ROOM = [[60, 6, 4], [120, -9, 6], [4000, 4, 1.5]];
  function selfTest(fs = 48000, { noiseDb = -70, delay = 1234, gain = 0.5, win = {} } = {}) {
    const sw = sweep(fs), fl = ROOM.map(([f, g, q]) => peaking(fs, f, g, q));
    let y = Float64Array.from(sw); fl.forEach(c => { y = filt(y, c); });
    const rec = new Float32Array(delay + sw.length + fs), r = rng(7), nAmp = Math.pow(10, noiseDb / 20);
    for (let i = 0; i < rec.length; i++) rec[i] = gauss(r) * nAmp;
    for (let i = 0; i < y.length; i++) rec[delay + i] += gain * y[i];
    const ir = deconvolve(rec, sw, fs), pk = peakIndex(ir, rec.length);
    const freqs = logFreqs(200, 25, 16000);
    const meas = response(ir, fs, pk, freqs, { smooth: 0, ...win });
    const truth = freqs.map(f => 20 * Math.log10(gain) + fl.reduce((s, c) => s + biquadDb(c, f, fs), 0));
    const err = meas.map((m, i) => m - truth[i]);
    return { delayTrue: delay, delayFound: pk, freqs, meas, truth, maxErr: Math.max(...err.map(Math.abs)), meanErr: err.reduce((s, e) => s + Math.abs(e), 0) / err.length };
  }
  const rms = (x, a = 0, b = x.length) => { let s = 0; for (let i = a; i < b; i++) s += x[i] * x[i]; return Math.sqrt(s / Math.max(1, b - a)); };
  const peakAbs = (x) => { let m = 0; for (let i = 0; i < x.length; i++) m = Math.max(m, Math.abs(x[i])); return m; };
  const dbfs = (v) => 20 * Math.log10(v + 1e-12);
  return { fft, sweep, deconvolve, peakIndex, response, logFreqs, selfTest, rms, peakAbs, dbfs, ROOM, peaking, biquadDb, filt };
})();
if (typeof module !== 'undefined') module.exports = DSP;
