#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        // Keep external pages out of the privileged application WebView.
        // Explicit user-clicked links go through the scoped opener plugin.
        .setup(|app| {
            tauri::WebviewWindowBuilder::from_config(app, &app.config().app.windows[0])?
                .on_navigation(is_local_navigation)
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Unable to start the offline armor solver");
}

fn is_local_navigation(url: &tauri::Url) -> bool {
    let local = matches!(
        (url.scheme(), url.host_str()),
        ("tauri", Some("localhost")) | ("http" | "https", Some("tauri.localhost"))
    );
    local
        || (cfg!(debug_assertions)
            && url.scheme() == "http"
            && url.host_str() == Some("127.0.0.1")
            && url.port() == Some(5178))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn navigation_stays_inside_the_app() {
        assert!(is_local_navigation(
            &"http://tauri.localhost/".parse().unwrap()
        ));
        for url in [
            "https://example.com/",
            "https://tauri.localhost.evil.com/",
            "file:///C:/Windows/win.ini",
            "javascript:alert(1)",
        ] {
            assert!(!is_local_navigation(&url.parse().unwrap()));
        }
    }
}
