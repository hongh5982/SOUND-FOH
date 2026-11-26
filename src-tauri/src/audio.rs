//! Audio devices, test tone and input meter (step 1).
//!
//! cpal streams are not `Send` on every platform, so they live on one audio
//! thread. The rest of the app talks to that thread through a channel and
//! reads the meter through an atomic.

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, SampleFormat, SizedSample};
use serde::Serialize;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use std::thread;

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
    let mut devs: Box<dyn Iterator<Item = cpal::Device>> = if output {
        Box::new(host.output_devices().map_err(|e| e.to_string())?)
    } else {
        Box::new(host.input_devices().map_err(|e| e.to_string())?)
    };
    let (idx, name) = id.split_once('|').ok_or("bad device id")?;
    let idx: usize = idx.parse().map_err(|_| "bad device id")?;
    // Prefer the same index and name; fall back to the first device with that name.
    let all: Vec<cpal::Device> = devs.by_ref().collect();
    if let Some(d) = all.get(idx).filter(|d| d.name().ok().as_deref() == Some(name)) {
        return Ok(d.clone());
    }
    all.into_iter()
        .find(|d| d.name().ok().as_deref() == Some(name))
        .ok_or_else(|| format!("장치를 찾을 수 없어요: {name}"))
}

enum Cmd {
    ToneStart(String, Sender<Result<(), String>>),
    ToneStop,
    MeterStart(String, usize, Sender<Result<(), String>>),
    MeterStop,
}

pub struct AudioCtl {
    tx: Mutex<Sender<Cmd>>,
    volume: Arc<AtomicU32>,
    peak: Arc<AtomicU32>,
}

impl AudioCtl {
    pub fn new() -> Self {
        let (tx, rx) = channel::<Cmd>();
        let volume = Arc::new(AtomicU32::new(0f32.to_bits()));
        let peak = Arc::new(AtomicU32::new(0f32.to_bits()));
        let (v, p) = (volume.clone(), peak.clone());
        thread::spawn(move || {
            // The streams play while they are held here; replacing or clearing one stops it.
            let mut tone: Option<cpal::Stream> = None;
            let mut meter: Option<cpal::Stream> = None;
            for cmd in rx {
                match cmd {
                    Cmd::ToneStart(id, done) => {
                        drop(tone.take());
                        let r = open_tone(&id, v.clone()).map(|s| tone = Some(s));
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
                }
            }
        });
        Self { tx: Mutex::new(tx), volume, peak }
    }

    fn send(&self, c: Cmd) {
        let _ = self.tx.lock().unwrap().send(c);
    }

    pub fn tone_start(&self, device: String, volume: f32) -> Result<(), String> {
        self.tone_volume(volume);
        let (tx, rx) = channel();
        self.send(Cmd::ToneStart(device, tx));
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
}

fn err_fn(e: cpal::StreamError) {
    eprintln!("audio stream error: {e}");
}

// ---------- test tone: pink noise, left then right, 1.2 s each ----------
fn open_tone(id: &str, volume: Arc<AtomicU32>) -> Result<cpal::Stream, String> {
    let dev = find(true, id)?;
    let cfg = dev.default_output_config().map_err(|e| e.to_string())?;
    let fmt = cfg.sample_format();
    let cfg: cpal::StreamConfig = cfg.into();
    let s = match fmt {
        SampleFormat::F32 => tone_stream::<f32>(&dev, &cfg, volume),
        SampleFormat::I16 => tone_stream::<i16>(&dev, &cfg, volume),
        SampleFormat::U16 => tone_stream::<u16>(&dev, &cfg, volume),
        SampleFormat::I32 => tone_stream::<i32>(&dev, &cfg, volume),
        f => return Err(format!("지원하지 않는 출력 형식: {f:?}")),
    }?;
    s.play().map_err(|e| e.to_string())?;
    Ok(s)
}

fn tone_stream<T: SizedSample + FromSample<f32>>(dev: &cpal::Device, cfg: &cpal::StreamConfig, volume: Arc<AtomicU32>) -> Result<cpal::Stream, String> {
    let chans = cfg.channels as usize;
    let half = (cfg.sample_rate.0 as f32 * 1.2) as u64;
    let mut n: u64 = 0;
    let mut pink = Pink::new();
    dev.build_output_stream(
        cfg,
        move |data: &mut [T], _| {
            let vol = f32::from_bits(volume.load(Ordering::Relaxed));
            // -20 dBFS at full volume; the slider is a 0..1 linear-in-dB-ish curve
            let gain = 0.1 * vol * vol;
            for frame in data.chunks_mut(chans) {
                let side = ((n / half) % 2) as usize; // 0 = left, 1 = right
                let v = pink.next() * gain;
                for (c, s) in frame.iter_mut().enumerate() {
                    let on = if chans >= 2 { c == side } else { true };
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
    let s = match fmt {
        SampleFormat::F32 => meter_stream::<f32>(&dev, &cfg, channel, peak),
        SampleFormat::I16 => meter_stream::<i16>(&dev, &cfg, channel, peak),
        SampleFormat::U16 => meter_stream::<u16>(&dev, &cfg, channel, peak),
        SampleFormat::I32 => meter_stream::<i32>(&dev, &cfg, channel, peak),
        f => return Err(format!("지원하지 않는 입력 형식: {f:?}")),
    }?;
    s.play().map_err(|e| e.to_string())?;
    Ok(s)
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
            let old = f32::from_bits(peak.load(Ordering::Relaxed));
            if m > old {
                peak.store(m.to_bits(), Ordering::Relaxed);
            }
        },
        err_fn,
        None,
    )
    .map_err(|e| e.to_string())
}
