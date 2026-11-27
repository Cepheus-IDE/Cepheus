//! Helpers for spawning child processes without flashing console windows on Windows.

pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub fn std_cmd(program: &str) -> std::process::Command {
    #[allow(unused_mut)]
    let mut c = std::process::Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(CREATE_NO_WINDOW);
    }
    c
}

pub fn tokio_cmd(program: &str) -> tokio::process::Command {
    #[allow(unused_mut)]
    let mut c = tokio::process::Command::new(program);
    #[cfg(windows)]
    {
        c.creation_flags(CREATE_NO_WINDOW);
    }
    c
}

pub fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}
