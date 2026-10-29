//! Streaming boundaries shared by the native PTY reader and the webview.

use std::sync::{Condvar, Mutex};

const HIGH_WATERMARK: usize = 100_000;
const LOW_WATERMARK: usize = 5_000;

/// Preserve a UTF-8 code point split across arbitrary PTY read boundaries.
#[derive(Default)]
pub(crate) struct Utf8Decoder {
    pending: Vec<u8>,
}

impl Utf8Decoder {
    pub(crate) fn decode(&mut self, bytes: &[u8], final_chunk: bool) -> String {
        self.pending.extend_from_slice(bytes);
        let mut result = String::new();
        let mut consumed = 0;
        while consumed < self.pending.len() {
            match std::str::from_utf8(&self.pending[consumed..]) {
                Ok(text) => {
                    result.push_str(text);
                    consumed = self.pending.len();
                }
                Err(error) => {
                    let end = consumed + error.valid_up_to();
                    // valid_up_to is a proven UTF-8 boundary, so no unsafe decode is needed.
                    if let Ok(valid) = std::str::from_utf8(&self.pending[consumed..end]) {
                        result.push_str(valid);
                    }
                    consumed = end;
                    if let Some(length) = error.error_len() {
                        result.push('\u{fffd}');
                        consumed += length;
                    } else if final_chunk {
                        result.push('\u{fffd}');
                        consumed = self.pending.len();
                    } else {
                        break;
                    }
                }
            }
        }
        self.pending.drain(..consumed);
        result
    }
}

#[derive(Default)]
struct FlowState {
    outstanding: usize,
    closed: bool,
}

/// VS Code acknowledges JavaScript string lengths (UTF-16 code units), not bytes.
#[derive(Default)]
pub(super) struct OutputFlow {
    state: Mutex<FlowState>,
    changed: Condvar,
}

impl OutputFlow {
    pub(super) fn before_send(&self, text: &str) -> bool {
        let Ok(mut state) = self.state.lock() else {
            return false;
        };
        if state.outstanding >= HIGH_WATERMARK {
            while state.outstanding > LOW_WATERMARK && !state.closed {
                let Ok(next) = self.changed.wait(state) else {
                    return false;
                };
                state = next;
            }
        }
        if state.closed {
            return false;
        }
        state.outstanding = state
            .outstanding
            .saturating_add(text.encode_utf16().count());
        true
    }

    pub(super) fn acknowledge(&self, chars: usize) {
        if let Ok(mut state) = self.state.lock() {
            state.outstanding = state.outstanding.saturating_sub(chars);
            if state.outstanding <= LOW_WATERMARK {
                self.changed.notify_all();
            }
        }
    }

    pub(super) fn close(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.closed = true;
            self.changed.notify_all();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{mpsc, Arc};
    use std::time::Duration;

    #[test]
    fn decodes_every_possible_split_of_multilingual_output() {
        let text = "prompt: Привет 中文 🦀 café\r\n\u{1b}[32mgreen\u{1b}[0m";
        for boundary in 0..=text.len() {
            let mut decoder = Utf8Decoder::default();
            let mut result = decoder.decode(&text.as_bytes()[..boundary], false);
            result.push_str(&decoder.decode(&text.as_bytes()[boundary..], true));
            assert_eq!(result, text, "split at {boundary}");
        }
    }

    #[test]
    fn invalid_sequences_and_truncated_eof_are_replaced_once() {
        let mut decoder = Utf8Decoder::default();
        assert_eq!(decoder.decode(&[b'a', 0xff, 0xe2], false), "a�");
        assert_eq!(decoder.decode(&[], true), "�");
        assert_eq!(decoder.decode(&[], true), "");
    }

    #[test]
    fn flow_control_uses_utf16_and_resumes_after_renderer_acknowledgement() {
        let flow = Arc::new(OutputFlow::default());
        assert!(flow.before_send(&"🦀".repeat(HIGH_WATERMARK / 2)));
        assert_eq!(flow.state.lock().unwrap().outstanding, HIGH_WATERMARK);
        let (tx, rx) = mpsc::channel();
        let producer = Arc::clone(&flow);
        let thread = std::thread::spawn(move || tx.send(producer.before_send("next")).unwrap());
        assert!(rx.recv_timeout(Duration::from_millis(30)).is_err());
        flow.acknowledge(HIGH_WATERMARK - LOW_WATERMARK);
        assert!(rx.recv_timeout(Duration::from_secs(1)).unwrap());
        thread.join().unwrap();
    }

    #[test]
    fn closing_a_terminal_unblocks_a_paused_reader() {
        let flow = Arc::new(OutputFlow::default());
        assert!(flow.before_send(&"x".repeat(HIGH_WATERMARK)));
        let (tx, rx) = mpsc::channel();
        let producer = Arc::clone(&flow);
        let thread = std::thread::spawn(move || tx.send(producer.before_send("next")).unwrap());
        flow.close();
        assert!(!rx.recv_timeout(Duration::from_secs(1)).unwrap());
        thread.join().unwrap();
    }
}
