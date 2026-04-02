use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use dashmap::DashMap;
use once_cell::sync::Lazy;

static CANCELS: Lazy<DashMap<String, Arc<AtomicBool>>> = Lazy::new(DashMap::new);

pub fn register_cancel(request_id: &str) -> Arc<AtomicBool> {
    let flag = Arc::new(AtomicBool::new(false));
    CANCELS.insert(request_id.to_string(), flag.clone());
    flag
}

pub fn unregister_cancel(request_id: &str) {
    CANCELS.remove(request_id);
}

pub fn cancel_request(request_id: &str) -> bool {
    if let Some(f) = CANCELS.get(request_id) {
        f.store(true, Ordering::SeqCst);
        true
    } else {
        false
    }
}
