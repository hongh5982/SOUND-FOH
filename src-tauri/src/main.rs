// Hide the console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // A second, elevated copy of the app switches Equalizer APO on for a speaker, then exits.
    if let Some(code) = sfoh_lib::helper_main() {
        std::process::exit(code);
    }
    sfoh_lib::run()
}
