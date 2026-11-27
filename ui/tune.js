// ---- Sound FOH auto tuning: turns a measurement into an Equalizer APO correction, then refines it ----
// Pure functions on top of DSP (dsp.js) and the result of ANALYSIS.run (analysis.js).
// Each speaker (L, R) gets its own filters. Bulges are cut; only wide, shallow gaps are lifted,
// and never the room's cancellation dips. Level and arrival time between L and R are matched too.
const TUNER = (() => {
  const LIM = {
    cutMax: 12,         // deepest cut, dB
    cutMaxHigh: 6,      // deepest cut above 5 kHz (the treble moves a lot with the mic position)
    boostMax: 3,        // highest lift, dB
    maxFilters: 6,      // per speaker
    startDb: 1.5,       // a bulge smaller than this is left alone
    doneDb: 2,          // finished when no bulge is bigger than this,
    balanceDb: 0.5,     // the speakers are this close in level,
    arrivalMs: 0.1,     // and this close in time
    fHi: 12000, boostLo: 250, boostHi: 8000,   // below 250 Hz a gap is almost always the room, so it is never lifted
  };
  const FS = 48000;
  const mean = (a) => a.reduce((s, v) => s + v, 0) / Math.max(1, a.length);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const oct = (a, b) => Math.abs(Math.log2(a / b));

  const filterDb = (fl, f) => DSP.biquadDb(DSP.peaking(FS, fl.f, fl.g, fl.q), f, FS);
  const sumDb = (filters, freqs) => freqs.map(f => filters.reduce((s, fl) => s + filterDb(fl, f), 0));
  const level = (freqs, db) => mean(db.filter((_, i) => freqs[i] >= 200 && freqs[i] <= 2000));
  // moving average over about +-width octaves on the log grid
  function smooth(freqs, db, width) {
    const per = (freqs.length - 1) / Math.log2(freqs[freqs.length - 1] / freqs[0]), h = Math.max(1, Math.round(width * per));
    return db.map((_, i) => mean(db.slice(Math.max(0, i - h), i + h + 1)));
  }
  // lowest frequency the speaker still plays: below it the response falls away, and lifting it would only strain the speaker
  function lowEnd(freqs, db) {
    const s = smooth(freqs, db, 0.5), ref = level(freqs, db);
    let lo = 30;
    for (let i = freqs.length - 1; i >= 0; i--) {
      if (freqs[i] > 200) continue;
      if (s[i] < ref - 8) { lo = freqs[i] * 1.25; break; }
    }
    return Math.max(30, lo);
  }

  // the problem dips (room cancellations) from the analysis: never lift these
  const dipsOf = (ana) => (ana.issues || []).filter(it => it.kind === 'phys' && it.f).map(it => it.f);

  // adds cuts on the biggest bulges of err (+ the filters already there) until nothing big is left
  function addCuts(freqs, err, filters, lo, hi, slots) {
    const added = [];
    for (let guard = 0; guard < 20 && added.length < slots; guard++) {
      const tot = sumDb([...filters, ...added], freqs).map((v, i) => err[i] + v);
      let bi = -1;
      for (let i = 0; i < freqs.length; i++) if (freqs[i] >= lo && freqs[i] <= hi && (bi < 0 || tot[i] > tot[bi])) bi = i;
      if (bi < 0 || tot[bi] < LIM.startDb) break;
      const f0 = freqs[bi], v = tot[bi];
      let a = bi, b = bi;
      while (a > 0 && tot[a - 1] > v / 2) a--;
      while (b < freqs.length - 1 && tot[b + 1] > v / 2) b++;
      const bw = clamp(Math.log2(freqs[b] / freqs[a]), 1 / 8, 2), r = Math.pow(2, bw);
      const q = clamp(Math.sqrt(r) / (r - 1), 0.7, f0 > 2000 ? 3 : 6);
      const deep = f0 > 5000 ? LIM.cutMaxHigh : LIM.cutMax;
      const near = [...filters, ...added].find(fl => fl.g <= 0 && oct(fl.f, f0) < 1 / 6);
      if (near) {
        if (near.g <= -deep + 0.05) break;                 // already as deep as allowed
        near.g = clamp(near.g - v, -deep, 0);
      } else added.push({ f: f0, g: -Math.min(v, deep), q, kind: 'cut' });
    }
    return added;
  }
  // a few passes that settle each filter's depth against what is left at its own frequency
  function settle(freqs, err, filters, passes = 3) {
    for (let p = 0; p < passes; p++) filters.forEach(fl => {
      const tot = sumDb(filters, [fl.f])[0] + interp(freqs, err, fl.f);
      fl.g = fl.kind === 'lift' ? clamp(fl.g - 0.7 * tot, 0, LIM.boostMax) : clamp(fl.g - 0.7 * tot, -(fl.f > 5000 ? LIM.cutMaxHigh : LIM.cutMax), 0);
    });
    return filters.filter(fl => Math.abs(fl.g) >= 0.3);
  }
  function interp(freqs, arr, f) {
    const n = freqs.length, x = Math.log(f / freqs[0]) / Math.log(freqs[n - 1] / freqs[0]) * (n - 1);
    const i = clamp(Math.floor(x), 0, n - 2), t = clamp(x - i, 0, 1);
    return arr[i] * (1 - t) + arr[i + 1] * t;
  }
  // one wide, shallow lift where the speaker is broadly quiet (not a narrow room dip)
  function addLift(freqs, err, filters, lo, dips) {
    if (filters.length >= LIM.maxFilters) return null;
    const tot = smooth(freqs, sumDb(filters, freqs).map((v, i) => err[i] + v), 0.5);
    let bi = -1;
    for (let i = 0; i < freqs.length; i++) {
      const f = freqs[i];
      if (f < Math.max(LIM.boostLo, lo * 1.5) || f > LIM.boostHi || dips.some(d => oct(d, f) < 0.5)) continue;
      if (bi < 0 || tot[i] < tot[bi]) bi = i;
    }
    if (bi < 0 || tot[bi] > -2.5) return null;
    // only a broad gap: the raw curve stays low for at least two thirds of an octave around it
    const raw = sumDb(filters, freqs).map((v, i) => err[i] + v);
    const wide = freqs.filter((f, i) => oct(f, freqs[bi]) <= 1 / 3).every((f, i, arr) => raw[freqs.indexOf(f)] < -1.5);
    if (!wide) return null;
    return { f: freqs[bi], g: Math.min(LIM.boostMax, -tot[bi]), q: 0.9, kind: 'lift' };
  }

  function errOf(freqs, db) { const ref = level(freqs, db); return db.map(v => v - ref); }

  /** First correction from the measurement before tuning. */
  function first(ana) {
    const freqs = ana.freqs, dips = dipsOf(ana), plan = { ch: {}, preamp: 0 };
    ['L', 'R'].forEach(c => {
      if (!ana.fr[c]) return;
      const err = errOf(freqs, ana.fr[c]), lo = lowEnd(freqs, ana.fr[c]);
      let filters = addCuts(freqs, err, [], lo, LIM.fHi, LIM.maxFilters);
      filters = settle(freqs, err, filters);
      const lift = addLift(freqs, err, filters, lo, dips);
      if (lift) { filters.push(lift); filters = settle(freqs, err, filters); }
      plan.ch[c] = { filters, gain: 0, delay: 0, lo };
    });
    match(plan, ana);
    return finish(plan, freqs);
  }

  /** Next correction from a check measurement made with the current one switched on. */
  function refine(prev, ana) {
    const freqs = ana.freqs, dips = dipsOf(ana), plan = JSON.parse(JSON.stringify(prev));
    ['L', 'R'].forEach(c => {
      const ch = plan.ch[c]; if (!ch || !ana.fr[c]) return;
      const res = errOf(freqs, ana.fr[c]);                  // what is still off, with the correction on
      const rs = smooth(freqs, res, 1 / 6);
      // each filter moves by most of what is left at its frequency
      ch.filters.forEach(fl => {
        const r = interp(freqs, rs, fl.f);
        fl.g = fl.kind === 'lift' ? clamp(fl.g - 0.8 * r, 0, LIM.boostMax) : clamp(fl.g - 0.8 * r, -(fl.f > 5000 ? LIM.cutMaxHigh : LIM.cutMax), 0);
      });
      ch.filters = ch.filters.filter(fl => Math.abs(fl.g) >= 0.3);
      // bulges that are still there get a filter of their own, while there is room
      const free = LIM.maxFilters - ch.filters.length;
      if (free > 0) {
        const extra = addCuts(freqs, res, [], ch.lo, LIM.fHi, free).filter(n => ch.filters.every(fl => oct(fl.f, n.f) >= 1 / 6));
        ch.filters.push(...settle(freqs, res, extra));
      }
      void dips;
    });
    match(plan, ana);
    return finish(plan, freqs);
  }

  // level and arrival time between the speakers, from what was just measured
  function match(plan, ana) {
    const L = plan.ch.L, R = plan.ch.R;
    if (!L || !R) return;
    const d = level(ana.freqs, ana.fr.L) - level(ana.freqs, ana.fr.R);
    L.gain -= d / 2; R.gain += d / 2;
    const top = Math.max(L.gain, R.gain); L.gain -= top; R.gain -= top;   // only ever turn down
    const a = ana.arrival || {};
    if (a.L != null && a.R != null) {
      const dt = a.R - a.L;                                                 // > 0: R arrives later, so hold L back
      if (Math.abs(dt) >= 0.05) { L.delay += dt; }
      const low = Math.min(L.delay, R.delay); L.delay = Math.max(0, L.delay - low); R.delay = Math.max(0, R.delay - low);
    }
  }

  // headroom: lifts must not push the signal into clipping
  function finish(plan, freqs) {
    let top = 0;
    Object.values(plan.ch).forEach(ch => {
      const s = sumDb(ch.filters, freqs);
      top = Math.max(top, Math.max(...s) + ch.gain);
    });
    plan.preamp = -Math.max(0, top);
    return plan;
  }

  /** Is this check measurement good enough to stop? */
  function good(ana, plan) {
    const freqs = ana.freqs;
    for (const c of ['L', 'R']) {
      if (!ana.fr[c]) continue;
      const res = errOf(freqs, ana.fr[c]), lo = plan && plan.ch[c] ? plan.ch[c].lo : 30;
      const worst = Math.max(...res.filter((_, i) => freqs[i] >= lo && freqs[i] <= LIM.fHi));
      if (worst > LIM.doneDb) return false;
    }
    if (ana.fr.L && ana.fr.R && Math.abs(level(freqs, ana.fr.L) - level(freqs, ana.fr.R)) > LIM.balanceDb) return false;
    const a = ana.arrival || {};
    if (a.L != null && a.R != null && Math.abs(a.R - a.L) > LIM.arrivalMs) return false;
    return true;
  }

  /** Equalizer APO text for a plan. */
  function text(plan, name) {
    const n1 = (v) => v.toFixed(1), n2 = (v) => v.toFixed(2);
    const out = [`# Sound FOH auto tune${name ? ' - ' + String(name).replace(/[^\x20-\x7e]/g, '').trim() : ''}`, '# Written by Sound FOH. Changes here are replaced on the next tuning.'];
    ['L', 'R'].forEach(c => {
      const ch = plan.ch[c]; if (!ch) return;
      out.push(`Channel: ${c}`);
      if (Math.abs(ch.gain) >= 0.05) out.push(`Preamp: ${n1(ch.gain)} dB`);
      if (ch.delay >= 0.01) out.push(`Delay: ${n2(ch.delay)} ms`);
      ch.filters.slice().sort((a, b) => a.f - b.f).forEach(fl => out.push(`Filter: ON PK Fc ${Math.round(fl.f)} Hz Gain ${n1(fl.g)} dB Q ${n2(fl.q)}`));
    });
    out.push('Channel: all');
    if (plan.preamp <= -0.05) out.push(`Preamp: ${n1(plan.preamp)} dB`);
    return out.join('\r\n') + '\r\n';
  }

  /** Predicted response of each speaker with the plan on (for drawing). */
  function predict(ana, plan) {
    const out = {};
    ['L', 'R'].forEach(c => { if (ana.fr[c] && plan.ch[c]) { const s = sumDb(plan.ch[c].filters, ana.freqs); out[c] = ana.fr[c].map((v, i) => v + s[i] + plan.ch[c].gain); } });
    return out;
  }

  /** Which of the tuning problems from before are gone in the check measurement. */
  function fixed(before, after) {
    const still = (it) => (after.issues || []).some(a => a.kind === 'tune' && (
      (it.f && a.f && oct(it.f, a.f) < 1 / 3) || (!it.f && a.t.slice(0, 4) === it.t.slice(0, 4))));
    return before.map((it, i) => [it, i]).filter(([it]) => it.kind === 'tune' && !still(it)).map(([, i]) => i);
  }

  return { first, refine, good, text, predict, fixed, filterDb, sumDb, LIM };
})();
if (typeof module !== 'undefined') module.exports = TUNER;
