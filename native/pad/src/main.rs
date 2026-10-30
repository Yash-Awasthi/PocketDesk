// SPDX-License-Identifier: GPL-3.0-or-later
//! `pocketdesk-pad`: up to four Xbox 360 controllers on this PC, driven from stdin.
//!
//! Each line on stdin is one controller's whole state:
//!   `<pad 0-3> <buttons> <lt 0-255> <rt 0-255> <lx> <ly> <rx> <ry>`
//! with XInput's button bits and sticks from -32768 to 32767. `<pad> off` unplugs one.
//! Prints `ready` once the ViGEmBus driver answers, or an error and exits 1 without it.

#[cfg(windows)]
fn main() {
    use std::collections::HashMap;
    use std::io::BufRead;
    use vigem_client::{Client, TargetId, XButtons, XGamepad, Xbox360Wired};

    let client = match Client::connect() {
        Ok(c) => std::rc::Rc::new(c),
        Err(e) => {
            eprintln!("ViGEmBus driver not found ({e:?}): install it to use the phone as a controller");
            std::process::exit(1);
        }
    };
    println!("ready");
    let mut pads: HashMap<u8, Xbox360Wired<std::rc::Rc<Client>>> = HashMap::new();
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        let f: Vec<&str> = line.split_whitespace().collect();
        let Some(pad) = f.first().and_then(|p| p.parse::<u8>().ok()).filter(|p| *p < 4) else { continue };
        if f.get(1) == Some(&"off") {
            if let Some(mut t) = pads.remove(&pad) {
                let _ = t.unplug();
            }
            continue;
        }
        let n = |i: usize| f.get(i).and_then(|v| v.parse::<i64>().ok()).unwrap_or(0);
        let state = XGamepad {
            buttons: XButtons { raw: n(1).clamp(0, 0xFFFF) as u16 },
            left_trigger: n(2).clamp(0, 255) as u8,
            right_trigger: n(3).clamp(0, 255) as u8,
            thumb_lx: n(4).clamp(-32768, 32767) as i16,
            thumb_ly: n(5).clamp(-32768, 32767) as i16,
            thumb_rx: n(6).clamp(-32768, 32767) as i16,
            thumb_ry: n(7).clamp(-32768, 32767) as i16,
        };
        let target = pads.entry(pad).or_insert_with(|| {
            let mut t = Xbox360Wired::new(client.clone(), TargetId::XBOX360_WIRED);
            let _ = t.plugin();
            let _ = t.wait_ready();
            t
        });
        // A controller plugged in a moment ago can refuse its first report while Windows sets it up.
        if target.update(&state).is_err() {
            std::thread::sleep(std::time::Duration::from_millis(150));
            if let Err(e) = target.update(&state) {
                eprintln!("pad {pad}: {e:?}");
            }
        }
    }
    for (_, mut t) in pads {
        let _ = t.unplug();
    }
}

#[cfg(not(windows))]
fn main() {
    eprintln!("the phone as a controller needs Windows and the ViGEmBus driver");
    std::process::exit(2);
}
