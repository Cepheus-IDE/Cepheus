fn main() {
    // Built-in NVIDIA key for the free tier: from $NVIDIA_API_KEY or the git-ignored
    // `nvidia.key` file next to Cargo.toml. It is compiled into the backend only, never the frontend.
    println!("cargo:rerun-if-changed=nvidia.key");
    println!("cargo:rerun-if-env-changed=NVIDIA_API_KEY");
    let key = std::env::var("NVIDIA_API_KEY")
        .ok()
        .or_else(|| std::fs::read_to_string("nvidia.key").ok())
        .map(|k| k.trim().to_string())
        .unwrap_or_default();
    println!("cargo:rustc-env=CEPHEUS_NVIDIA_KEY={key}");
    tauri_build::build()
}
