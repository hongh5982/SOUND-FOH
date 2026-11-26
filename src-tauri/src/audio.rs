//! Audio devices, test signals, input meter and measurement takes.
//!
//! cpal streams are not `Send` on every platform, so they live on one audio
//! thread. The rest of the app talks to that thread through a channel and
//! reads the meter and the measurement progress through atomics.

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, SampleFormat, SizedSample};
use serde::Serialize;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU32, AtomicU64, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use std::thread;

// ---------- level mapping shared by every signal ----------
/// Slider position 0..1 -> sweep amplitude. 100% gives a -6 dBFS peak sweep.
/// Pink noise is scaled to the same RMS so the level screen sounds like the measurement.
pub fn sweep_amp(level: f32) -> f32 {
    let v = level.clamp(0.0, 1.0);
    0.5 * v * v
}
const PINK_RMS: f32 = 0.352; // RMS of `Pink::next()`
fn pink_gain(level: f32) -> f32 {
    sweep_amp(level) / std::f32::consts::SQRT_2 / PINK_RMS
}

// ---------- devices ----------
#[derive(Serialize)]
pub struct Device {
    /// Stable within one run: "<index>|<name>" so two devices with the same name stay apart.
    pub id: String,
    pub name: String,
    pub channels: u16,
    pub sample_rate: u32,
    pub is_default: bool,
}

#[derive(Serialize)]
pub struct DeviceList {
    pub outputs: Vec<Device>,
    pub inputs: Vec<Device>,
}

fn describe(i: usize, d: &cpal::Device, cfg: Option<cpal::SupportedStreamConfig>, default_name: &Option<String>) -> Option<Device> {
    let name = d.name().ok()?;
    let cfg = cfg?;
    Some(Device {
        id: format!("{i}|{name}"),
        is_default: default_name.as_deref() == Some(name.as_str()),
        name,
        channels: cfg.channels(),
        sample_rate: cfg.sample_rate().0,
    })
}

pub fn list_devices() -> Result<DeviceList, String> {
    let host = cpal::default_host();
    let def_out = host.default_output_device().and_then(|d| d.name().ok());
    let def_in = host.default_input_device().and_then(|d| d.name().ok());
    let outputs = host
        .output_devices()
        .map_err(|e| e.to_string())?
        .enumerate()
        .filter_map(|(i, d)| describe(i, &d, d.default_output_config().ok(), &def_out))
        .collect();
    let inputs = host
        .input_devices()
        .map_err(|e| e.to_string())?
        .enumerate()
        .filter_map(|(i, d)| describe(i, &d, d.default_input_config().ok(), &def_in))
        .collect();
    Ok(DeviceList { outputs, inputs })
}

fn find(output: bool, id: &str) -> Result<cpal::Device, String> {
    let host = cpal::default_host();
    let all: Vec<cpal::Device> = if output {
        host.output_devices().map_err(|e| e.to_string())?.collect()
    } else {
        host.input_devices().map_err(|e| e.to_string())?.collect()
    };
    let (idx, name) = id.split_once('|').ok_or("bad device id")?;
    let idx: usize = idx.parse().map_err(|_| "bad device id")?;
    // Prefer the same index and name; fall back to the first device with that name.
    if let Some(d) = all.get(idx).filter(|d| d.name().ok().as_deref() == Some(name)) {
        return Ok(d.clone());
    }
    all.into_iter()
        .find(|d| d.name().ok().as_deref() == Some(name))
        .ok_or_else(|| format!("장치를 찾을 수 없어요: {name}"))
}

// ---------- measurement program ----------
pub const SWEEP_SECS: f64 = 5.0;
pub const SWEEP_F1: f64 = 20.0;
pub const SWEEP_F2: f64 = 20000.0;
const LEAD_SECS: f64 = 0.5;
const NOISE_SECS: f64 = 2.0;
const TAIL_SECS: f64 = 1.5;
/// Extra input recorded after the last output sample (output latency + room decay).
const REC_EXTRA_SECS: f64 = 0.6;

#[derive(Serialize, Clone)]
pub struct Seg {
    /// "lead", "noise", "sweep" or "tail"
    pub kind: &'static str,
    /// Phase name from the request ("noise", "L", "R", "LR"), empty for lead.
    pub phase: String,
    pub start: u64,
    pub len: u64,
}

#[derive(Serialize, Clone)]
pub struct Layout {
    pub out_rate: u32,
    pub in_rate: u32,
    pub total: u64,
    pub segs: Vec<Seg>,
    pub sweep_amp: f32,
}

/// Same exponential sweep as the verified `DSP.sweep` in the UI (30 ms fade in, 5 ms fade out).
fn sweep(fs: u32, amp: f32) -> Vec<f32> {
    let fs = fs as f64;
    let n = (SWEEP_SECS * fs).round() as usize;
    let l = SWEEP_SECS / (SWEEP_F2 / SWEEP_F1).ln();
    let fi = (0.03 * fs).round() as usize;
    let fo = (0.005 * fs).round() as usize;
    (0..n)
        .map(|i| {
            let t = i as f64 / fs;
            let mut g = amp as f64;
            if i < fi {
                g *= 0.5 - 0.5 * (std::f64::consts::PI * i as f64 / fi as f64).cos();
            }
            if i > n - fo {
                g *= 0.5 - 0.5 * (std::f64::consts::PI * (n - i) as f64 / fo as f64).cos();
            }
            (g * (2.0 * std::f64::consts::PI * SWEEP_F1 * l * ((t / l).exp() - 1.0)).sin()) as f32
        })
        .collect()
}

/// Builds one continuous stereo program (interleaved L,R) for the given phases.
/// Every sweep in one take shares the same clock, so L, R and L+R line up exactly.
fn build_program(phases: &[String], fs: u32, level: f32) -> (Vec<f32>, Vec<Seg>, f32) {
    let secs = |s: f64| (s * fs as f64).round() as u64;
    let amp = sweep_amp(level);
    let sw = sweep(fs, amp);
    let mut segs = vec![Seg { kind: "lead", phase: String::new(), start: 0, len: secs(LEAD_SECS) }];
    let mut pos = secs(LEAD_SECS);
    for p in phases {
        if p == "noise" {
            segs.push(Seg { kind: "noise", phase: p.clone(), start: pos, len: secs(NOISE_SECS) });
            pos += secs(NOISE_SECS);
        }
    }
    for p in phases.iter().filter(|p| *p != "noise") {
        segs.push(Seg { kind: "sweep", phase: p.clone(), start: pos, len: sw.len() as u64 });
        pos += sw.len() as u64;
        segs.push(Seg { kind: "tail", phase: p.clone(), start: pos, len: secs(TAIL_SECS) });
        pos += secs(TAIL_SECS);
    }
    let mut prog = vec![0f32; pos as usize * 2];
    for s in segs.iter().filter(|s| s.kind == "sweep") {
        let (l, r) = match s.phase.as_str() {
            "L" => (true, false),
            "R" => (false, true),
            _ => (true, true),
        };
        for (i, v) in sw.iter().enumerate() {
            let k = (s.start as usize + i) * 2;
            if l { prog[k] = *v; }
            if r { prog[k + 1] = *v; }
        }
    }
    (prog, segs, amp)
}

// ---------- shared state ----------
#[derive(Default)]
struct Take {
    /// Output frames handed to the device so far.
    played: AtomicU64,
    total: AtomicU64,
    /// Input frames recorded when the first output frame was handed over (-1 = not yet).
    offset: AtomicI64,
    in_frames: AtomicU64,
    done: AtomicBool,
    rec: Mutex<Vec<f32>>,
    error: Mutex<Option<String>>,
}

#[derive(Serialize)]
pub struct TakeStatus {
    pub played: u64,
    pub total: u64,
    pub done: bool,
    pub offset: i64,
    pub recorded: u64,
    pub error: Option<String>,
}

enum Cmd {
    ToneStart(String, bool, Sender<Result<(), String>>),
    ToneStop,
    MeterStart(String, usize, Sender<Result<(), String>>),
    MeterStop,
    MeasureStart(String, String, usize, Vec<String>, f32, Sender<Result<Layout, String>>),
    MeasureStop,
}

pub struct AudioCtl {
    tx: Mutex<Sender<Cmd>>,
    volume: Arc<AtomicU32>,
    peak: Arc<AtomicU32>,
    take: Arc<Take>,
}

impl AudioCtl {
    pub fn new() -> Self {
        let (tx, rx) = channel::<Cmd>();
        let volume = Arc::new(AtomicU32::new(0f32.to_bits()));
        let peak = Arc::new(AtomicU32::new(0f32.to_bits()));
        let take = Arc::new(Take::default());
        let (v, p, tk) = (volume.clone(), peak.clone(), take.clone());
        thread::spawn(move || {
            // The streams play while they are held here; clearing one stops it.
            let mut tone: Option<cpal::Stream> = None;
            let mut meter: Option<cpal::Stream> = None;
            let mut meas: Option<(cpal::Stream, cpal::Stream)> = None;
            for cmd in rx {
                match cmd {
                    Cmd::ToneStart(id, alt, done) => {
                        drop(tone.take());
                        let r = open_tone(&id, alt, v.clone()).map(|s| tone = Some(s));
                        let _ = done.send(r);
                    }
                    Cmd::ToneStop => drop(tone.take()),
                    Cmd::MeterStart(id, ch, done) => {
                        drop(meter.take());
                        p.store(0f32.to_bits(), Ordering::Relaxed);
                        let r = open_meter(&id, ch, p.clone()).map(|s| meter = Some(s));
                        let _ = done.send(r);
                    }
                    Cmd::MeterStop => drop(meter.take()),
                    Cmd::MeasureStart(out_id, in_id, ch, phases, level, done) => {
                        // a take needs the devices to itself
                        drop(tone.take());
                        drop(meter.take());
                        drop(meas.take());
                        let r = open_take(&out_id, &in_id, ch, &phases, level, &tk, &p).map(|(o, i, layout)| {
                            meas = Some((o, i));
                            layout
                        });
                        let _ = done.send(r);
                    }
                    Cmd::MeasureStop => drop(meas.take()),
                }
            }
        });
        Self { tx: Mutex::new(tx), volume, peak, take }
    }

    fn send(&self, c: Cmd) {
        let _ = self.tx.lock().unwrap().send(c);
    }

    /// `alternate`: true = left and right take turns (device check), false = both together (level setting).
    pub fn tone_start(&self, device: String, volume: f32, alternate: bool) -> Result<(), String> {
        self.tone_volume(volume);
        let (tx, rx) = channel();
        self.send(Cmd::ToneStart(device, alternate, tx));
        rx.recv().map_err(|e| e.to_string())?
    }
    pub fn tone_volume(&self, volume: f32) {
        self.volume.store(volume.clamp(0.0, 1.0).to_bits(), Ordering::Relaxed);
    }
    pub fn tone_stop(&self) {
        self.send(Cmd::ToneStop);
    }
    pub fn meter_start(&self, device: String, ch: usize) -> Result<(), String> {
        let (tx, rx) = channel();
        self.send(Cmd::MeterStart(device, ch, tx));
        rx.recv().map_err(|e| e.to_string())?
    }
    /// Peak since the last call, in dBFS (-120 when silent).
    pub fn meter_level(&self) -> f32 {
        let p = f32::from_bits(self.peak.swap(0f32.to_bits(), Ordering::Relaxed));
        if p <= 1e-6 { -120.0 } else { 20.0 * p.log10() }
    }
    pub fn meter_stop(&self) {
        self.send(Cmd::MeterStop);
    }

    pub fn measure_start(&self, output: String, input: String, ch: usize, phases: Vec<String>, level: f32) -> Result<Layout, String> {
        let (tx, rx) = channel();
        self.send(Cmd::MeasureStart(output, input, ch, phases, level, tx));
        rx.recv().map_err(|e| e.to_string())?
    }
    pub fn measure_status(&self) -> TakeStatus {
        let t = &self.take;
        TakeStatus {
            played: t.played.load(Ordering::Relaxed),
            total: t.total.load(Ordering::Relaxed),
            done: t.done.load(Ordering::Relaxed),
            offset: t.offset.load(Ordering::Relaxed),
            recorded: t.in_frames.load(Ordering::Relaxed),
            error: t.error.lock().unwrap().clone(),
        }
    }
    /// The recorded take as little-endian f32 bytes (input sample rate, one channel).
    pub fn measure_take(&self) -> Vec<u8> {
        let rec = self.take.rec.lock().unwrap();
        let mut out = Vec::with_capacity(rec.len() * 4);
        for v in rec.iter() {
            out.extend_from_slice(&v.to_le_bytes());
        }
        out
    }
    pub fn measure_stop(&self) {
        self.send(Cmd::MeasureStop);
    }
}

fn err_fn(e: cpal::StreamError) {
    eprintln!("audio stream error: {e}");
}

macro_rules! by_format {
    ($fmt:expr, $f:ident, $($arg:expr),*) => {
        match $fmt {
            SampleFormat::F32 => $f::<f32>($($arg),*),
            SampleFormat::I16 => $f::<i16>($($arg),*),
            SampleFormat::U16 => $f::<u16>($($arg),*),
            SampleFormat::I32 => $f::<i32>($($arg),*),
            f => Err(format!("지원하지 않는 오디오 형식: {f:?}")),
        }
    };
}

// ---------- test tone: pink noise ----------
fn open_tone(id: &str, alternate: bool, volume: Arc<AtomicU32>) -> Result<cpal::Stream, String> {
    let dev = find(true, id)?;
    let cfg = dev.default_output_config().map_err(|e| e.to_string())?;
    let fmt = cfg.sample_format();
    let cfg: cpal::StreamConfig = cfg.into();
    let s = by_format!(fmt, tone_stream, &dev, &cfg, alternate, volume)?;
    s.play().map_err(|e| e.to_string())?;
    Ok(s)
}

fn tone_stream<T: SizedSample + FromSample<f32>>(dev: &cpal::Device, cfg: &cpal::StreamConfig, alternate: bool, volume: Arc<AtomicU32>) -> Result<cpal::Stream, String> {
    let chans = cfg.channels as usize;
    let half = (cfg.sample_rate.0 as f32 * 1.2) as u64;
    let mut n: u64 = 0;
    let mut pink = Pink::new();
    dev.build_output_stream(
        cfg,
        move |data: &mut [T], _| {
            let gain = pink_gain(f32::from_bits(volume.load(Ordering::Relaxed)));
            for frame in data.chunks_mut(chans) {
                let side = ((n / half) % 2) as usize; // 0 = left, 1 = right
                let v = (pink.next() * gain).clamp(-1.0, 1.0);
                for (c, s) in frame.iter_mut().enumerate() {
                    let on = chans < 2 || (if alternate { c == side } else { c < 2 });
                    *s = T::from_sample(if on { v } else { 0.0 });
                }
                n += 1;
            }
        },
        err_fn,
        None,
    )
    .map_err(|e| e.to_string())
}

/// Paul Kellet's pink noise filter over a small xorshift generator.
struct Pink { s: u32, b: [f32; 7] }
impl Pink {
    fn new() -> Self { Self { s: 0x1234_5678, b: [0.0; 7] } }
    fn white(&mut self) -> f32 {
        self.s ^= self.s << 13; self.s ^= self.s >> 17; self.s ^= self.s << 5;
        (self.s as f32 / u32::MAX as f32) * 2.0 - 1.0
    }
    fn next(&mut self) -> f32 {
        let w = self.white();
        let b = &mut self.b;
        b[0] = 0.99886 * b[0] + w * 0.0555179;
        b[1] = 0.99332 * b[1] + w * 0.0750759;
        b[2] = 0.96900 * b[2] + w * 0.1538520;
        b[3] = 0.86650 * b[3] + w * 0.3104856;
        b[4] = 0.55000 * b[4] + w * 0.5329522;
        b[5] = -0.7616 * b[5] - w * 0.0168980;
        let out = b[0] + b[1] + b[2] + b[3] + b[4] + b[5] + b[6] + w * 0.5362;
        b[6] = w * 0.115926;
        out * 0.2
    }
}

// ---------- input meter ----------
fn open_meter(id: &str, channel: usize, peak: Arc<AtomicU32>) -> Result<cpal::Stream, String> {
    let dev = find(false, id)?;
    let cfg = dev.default_input_config().map_err(|e| e.to_string())?;
    let fmt = cfg.sample_format();
    let cfg: cpal::StreamConfig = cfg.into();
    let s = by_format!(fmt, meter_stream, &dev, &cfg, channel, peak)?;
    s.play().map_err(|e| e.to_string())?;
    Ok(s)
}

fn bump_peak(peak: &AtomicU32, m: f32) {
    let old = f32::from_bits(peak.load(Ordering::Relaxed));
    if m > old {
        peak.store(m.to_bits(), Ordering::Relaxed);
    }
}

fn meter_stream<T: SizedSample>(dev: &cpal::Device, cfg: &cpal::StreamConfig, channel: usize, peak: Arc<AtomicU32>) -> Result<cpal::Stream, String>
where
    f32: FromSample<T>,
{
    let chans = cfg.channels as usize;
    let ch = channel.min(chans.saturating_sub(1));
    dev.build_input_stream(
        cfg,
        move |data: &[T], _| {
            let mut m = 0f32;
            for frame in data.chunks(chans) {
                if let Some(s) = frame.get(ch) {
                    m = m.max(s.to_sample::<f32>().abs());
                }
            }
            bump_peak(&peak, m);
        },
        err_fn,
        None,
    )
    .map_err(|e| e.to_string())
}

// ---------- measurement take: play the program and record at the same time ----------
fn open_take(out_id: &str, in_id: &str, ch: usize, phases: &[String], level: f32, take: &Arc<Take>, peak: &Arc<AtomicU32>) -> Result<(cpal::Stream, cpal::Stream, Layout), String> {
    let odev = find(true, out_id)?;
    let idev = find(false, in_id)?;
    let ocfg = odev.default_output_config().map_err(|e| e.to_string())?;
    let icfg = idev.default_input_config().map_err(|e| e.to_string())?;
    let (ofmt, ifmt) = (ocfg.sample_format(), icfg.sample_format());
    let (ocfg, icfg): (cpal::StreamConfig, cpal::StreamConfig) = (ocfg.into(), icfg.into());
    let (out_rate, in_rate) = (ocfg.sample_rate.0, icfg.sample_rate.0);

    let (prog, segs, amp) = build_program(phases, out_rate, level);
    let total = (prog.len() / 2) as u64;
    let rec_need = (total as f64 * in_rate as f64 / out_rate as f64 + REC_EXTRA_SECS * in_rate as f64) as u64;
    let layout = Layout { out_rate, in_rate, total, segs, sweep_amp: amp };

    // reset shared state
    take.played.store(0, Ordering::Relaxed);
    take.total.store(total, Ordering::Relaxed);
    take.offset.store(-1, Ordering::Relaxed);
    take.in_frames.store(0, Ordering::Relaxed);
    take.done.store(false, Ordering::Relaxed);
    {
        let mut r = take.rec.lock().unwrap();
        r.clear();
        r.reserve(rec_need as usize + in_rate as usize * 2);
    }
    *take.error.lock().unwrap() = None;
    peak.store(0f32.to_bits(), Ordering::Relaxed);

    // input first, so the recording already runs when the first sweep leaves the speakers
    let istream = by_format!(ifmt, take_in_stream, &idev, &icfg, ch, take.clone(), peak.clone(), rec_need)?;
    istream.play().map_err(|e| e.to_string())?;
    let ostream = by_format!(ofmt, take_out_stream, &odev, &ocfg, Arc::new(prog), take.clone())?;
    ostream.play().map_err(|e| e.to_string())?;
    Ok((ostream, istream, layout))
}

fn take_out_stream<T: SizedSample + FromSample<f32>>(dev: &cpal::Device, cfg: &cpal::StreamConfig, prog: Arc<Vec<f32>>, take: Arc<Take>) -> Result<cpal::Stream, String> {
    let chans = cfg.channels as usize;
    let total = prog.len() / 2;
    let mut n = 0usize;
    dev.build_output_stream(
        cfg,
        move |data: &mut [T], _| {
            if n == 0 && take.offset.load(Ordering::Relaxed) < 0 {
                take.offset.store(take.in_frames.load(Ordering::Relaxed) as i64, Ordering::Relaxed);
            }
            for frame in data.chunks_mut(chans) {
                let (l, r) = if n < total { (prog[n * 2], prog[n * 2 + 1]) } else { (0.0, 0.0) };
                for (c, s) in frame.iter_mut().enumerate() {
                    let v = match (chans, c) {
                        (1, _) => 0.5 * (l + r),
                        (_, 0) => l,
                        (_, 1) => r,
                        _ => 0.0,
                    };
                    *s = T::from_sample(v);
                }
                n += 1;
            }
            take.played.store(n.min(total) as u64, Ordering::Relaxed);
        },
        move |e| err_fn(e),
        None,
    )
    .map_err(|e| e.to_string())
}

fn take_in_stream<T: SizedSample>(dev: &cpal::Device, cfg: &cpal::StreamConfig, channel: usize, take: Arc<Take>, peak: Arc<AtomicU32>, rec_need: u64) -> Result<cpal::Stream, String>
where
    f32: FromSample<T>,
{
    let chans = cfg.channels as usize;
    let ch = channel.min(chans.saturating_sub(1));
    let t2 = take.clone();
    dev.build_input_stream(
        cfg,
        move |data: &[T], _| {
            let frames = (data.len() / chans) as u64;
            let mut m = 0f32;
            // keep only what comes after the output started (plus everything before, for the offset)
            if let Ok(mut rec) = take.rec.lock() {
                let offset = take.offset.load(Ordering::Relaxed);
                let need = if offset < 0 { u64::MAX } else { offset as u64 + rec_need };
                for frame in data.chunks(chans) {
                    if let Some(s) = frame.get(ch) {
                        let v = s.to_sample::<f32>();
                        m = m.max(v.abs());
                        if (rec.len() as u64) < need {
                            rec.push(v);
                        }
                    }
                }
                if offset >= 0 && rec.len() as u64 >= need {
                    take.done.store(true, Ordering::Relaxed);
                }
            }
            take.in_frames.fetch_add(frames, Ordering::Relaxed);
            bump_peak(&peak, m);
        },
        move |e| {
            *t2.error.lock().unwrap() = Some(format!("녹음이 끊겼어요: {e}"));
        },
        None,
    )
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn program_layout() {
        let phases: Vec<String> = ["noise", "L", "R", "LR"].iter().map(|s| s.to_string()).collect();
        let (prog, segs, amp) = build_program(&phases, 48000, 1.0);
        assert_eq!(amp, 0.5);
        let kinds: Vec<_> = segs.iter().map(|s| s.kind).collect();
        assert_eq!(kinds, ["lead", "noise", "sweep", "tail", "sweep", "tail", "sweep", "tail"]);
        let total: u64 = segs.iter().map(|s| s.len).sum();
        assert_eq!(prog.len() as u64, total * 2);
        // L sweep only on the left, R only on the right
        let l = &segs[2];
        let mid = (l.start + l.len / 2) as usize;
        assert!(prog[mid * 2].abs() > 0.0 || prog[mid * 2 + 2].abs() > 0.0);
        assert_eq!(prog[mid * 2 + 1], 0.0);
        let r = &segs[4];
        let mid = (r.start + r.len / 2) as usize;
        assert_eq!(prog[mid * 2], 0.0);
        // peak stays at the sweep amplitude
        let pk = prog.iter().fold(0f32, |m, v| m.max(v.abs()));
        assert!((pk - 0.5).abs() < 1e-3, "{pk}");
    }

    #[test]
    fn sweep_matches_ui_formula() {
        let s = sweep(48000, 0.5);
        assert_eq!(s.len(), 240000);
        assert_eq!(s[0], 0.0);
    }
}
