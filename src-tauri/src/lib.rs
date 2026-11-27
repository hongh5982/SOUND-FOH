mod audio;

use audio::{AudioCtl, DeviceList, Layout, TakeStatus};
use tauri::ipc::Response;
use tauri::{Manager, State};

// Commands that wait on the audio thread or the OS are async so they never hold up the window.
#[tauri::command]
async fn list_devices() -> Result<DeviceList, String> {
    audio::list_devices()
}

#[tauri::command]
async fn tone_start(ctl: State<'_, AudioCtl>, device: String, volume: f32, both: Option<bool>) -> Result<(), String> {
    ctl.tone_start(device, volume, !both.unwrap_or(false))
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

#[tauri::command]
async fn measure_start(ctl: State<'_, AudioCtl>, output: String, input: String, channel: usize, phases: Vec<String>, level: f32) -> Result<Layout, String> {
    ctl.measure_start(output, input, channel, phases, level)
}

#[tauri::command]
fn measure_status(ctl: State<AudioCtl>) -> TakeStatus {
    ctl.measure_status()
}

/// Raw recording as f32 little-endian bytes; arrives in JS as an ArrayBuffer.
#[tauri::command]
async fn measure_take(ctl: State<'_, AudioCtl>) -> Result<Response, String> {
    Ok(Response::new(ctl.measure_take()))
}

#[tauri::command]
fn measure_stop(ctl: State<AudioCtl>) {
    ctl.measure_stop()
}

/// Keeps a copy of each measurement's numbers, so a run can be looked at later.
#[tauri::command]
async fn save_measurement(app: tauri::AppHandle, json: String) -> Result<String, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("measurements");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let path = dir.join(format!("measure-{stamp}.json"));
    std::fs::write(&path, json).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AudioCtl::new())
        .setup(|app| {
            // The page shows the window itself once it is drawn; this is only a safety net.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(3));
                if let Some(w) = handle.get_webview_window("main") {
                    if !w.is_visible().unwrap_or(true) {
                        let _ = w.show();
                    }
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_devices,
            tone_start,
            tone_volume,
            tone_stop,
            meter_start,
            meter_level,
            meter_stop,
            measure_start,
            measure_status,
            measure_take,
            measure_stop,
            save_measurement
        ])
        .run(tauri::generate_context!())
        .expect("error while running Sound FOH");
}
