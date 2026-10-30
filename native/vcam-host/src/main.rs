// SPDX-License-Identifier: GPL-3.0-or-later
// Adapted from NectarLink's desktop virtual camera code (GPL-3.0-or-later); see NOTICE.
//! `pocketdesk-vcam-host`: the "PocketDesk Webcam" every app can pick (Windows 11).
//!
//!   --register / --unregister   write or remove the camera's machine-wide registration (admin)
//!   --status                    prints "registered" or "unregistered"
//!   [--name <phone>]            runs the camera: frames come on stdin as
//!                               "PDVF" u32le width u32le height, then width*height*4 BGRX bytes;
//!                               the camera shows a placeholder card until the first one, and when
//!                               stdin closes the camera goes away with this process.

#[cfg(windows)]
mod win;

fn main() {
    #[cfg(windows)]
    std::process::exit(win::run(std::env::args().skip(1).collect()));
    #[cfg(not(windows))]
    {
        eprintln!("the PocketDesk Webcam needs Windows 11");
        std::process::exit(2);
    }
}
