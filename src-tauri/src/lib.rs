mod audio;

use audio::{AudioCtl, DeviceList};
use tauri::State;

// Commands that wait on the audio thread or the OS are async so they never hold up the window.
#[tauri::command]
async fn list_devices() -> Result<DeviceList, String> {
    audio::list_devices()
}

#[tauri::command]
async fn tone_start(ctl: State<'_, AudioCtl>, device: String, volume: f32) -> Result<(), String> {
    ctl.tone_start(device, volume)
}

#[tauri::command]
fn tone_volume(ctl: State<AudioCtl>, volume: f32) {
    ctl.tone_volume(volume)
}

#[tauri::command]
fn tone_stop(ctl: State<AudioCtl>) {
    ctl.tone_stop()
}

#[tauri::command]
async fn meter_start(ctl: State<'_, AudioCtl>, device: String, channel: usize) -> Result<(), String> {
    ctl.meter_start(device, channel)
}

#[tauri::command]
fn meter_level(ctl: State<AudioCtl>) -> f32 {
    ctl.meter_level()
}

#[tauri::command]
fn meter_stop(ctl: State<AudioCtl>) {
    ctl.meter_stop()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AudioCtl::new())
        .invoke_handler(tauri::generate_handler![
            list_devices,
            tone_start,
            tone_volume,
            tone_stop,
            meter_start,
            meter_level,
            meter_stop
        ])
        .run(tauri::generate_context!())
        .expect("error while running S'FOH");
}
