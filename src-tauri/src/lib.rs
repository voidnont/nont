mod github_images;
#[cfg(target_os = "windows")]
mod windows;
#[cfg(target_os = "android")]
mod android;

#[cfg(target_os = "windows")]
pub use windows::run;
#[cfg(target_os = "android")]
pub use android::run;

#[cfg(not(any(target_os = "windows", target_os = "android")))]
pub fn run() {
    panic!("NontHub currently supports Windows and Android.");
}
