#[napi(object)]
pub struct PreloadedWindowsLibrary {
    pub token: u32,
    pub loaded_path: String,
}

#[cfg(windows)]
mod platform {
    use super::PreloadedWindowsLibrary;
    use napi::{Error, Result, Status};
    use std::collections::HashMap;
    use std::ffi::{OsStr, OsString};
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    use std::path::PathBuf;
    use std::sync::{Mutex, OnceLock};
    use windows_sys::Win32::Foundation::{FreeLibrary, HMODULE};
    use windows_sys::Win32::System::LibraryLoader::{
        GetModuleFileNameW, LoadLibraryExW, LOAD_LIBRARY_SEARCH_DEFAULT_DIRS,
        LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR,
    };

    #[derive(Default)]
    struct LibraryState {
        next_token: u32,
        handles: HashMap<u32, isize>,
    }

    static LIBRARIES: OnceLock<Mutex<LibraryState>> = OnceLock::new();

    fn state() -> &'static Mutex<LibraryState> {
        LIBRARIES.get_or_init(|| {
            Mutex::new(LibraryState {
                next_token: 1,
                handles: HashMap::new(),
            })
        })
    }

    fn generic_error(message: impl Into<String>) -> Error {
        Error::new(Status::GenericFailure, message.into())
    }

    fn to_wide_null(path: &OsStr) -> Vec<u16> {
        path.encode_wide().chain(std::iter::once(0)).collect()
    }

    fn canonical_absolute_path(absolute_path: String) -> Result<PathBuf> {
        let input = PathBuf::from(&absolute_path);
        if !input.is_absolute() {
            return Err(generic_error(
                "preloadWindowsLibrary requires an absolute path",
            ));
        }
        std::fs::canonicalize(&input).map_err(|error| {
            generic_error(format!(
                "preloadWindowsLibrary could not canonicalize library path: {error}"
            ))
        })
    }

    fn module_filename(handle: HMODULE) -> Result<String> {
        let mut buffer = vec![0u16; 32_768];
        let len = unsafe { GetModuleFileNameW(handle, buffer.as_mut_ptr(), buffer.len() as u32) };
        if len == 0 {
            return Err(generic_error(
                "GetModuleFileNameW failed for preloaded library",
            ));
        }
        Ok(OsString::from_wide(&buffer[..len as usize])
            .to_string_lossy()
            .into_owned())
    }

    fn insert_handle(handle: HMODULE) -> Result<u32> {
        let mut guard = state()
            .lock()
            .map_err(|_| generic_error("Windows library handle table is poisoned"))?;
        if guard.next_token == 0 {
            guard.next_token = 1;
        }
        let token = guard.next_token;
        guard.next_token = guard
            .next_token
            .checked_add(1)
            .ok_or_else(|| generic_error("Windows library handle token space exhausted"))?;
        guard.handles.insert(token, handle as isize);
        Ok(token)
    }

    pub fn preload_windows_library_impl(absolute_path: String) -> Result<PreloadedWindowsLibrary> {
        let canonical_path = canonical_absolute_path(absolute_path)?;
        let wide_path = to_wide_null(canonical_path.as_os_str());
        let flags = LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_DEFAULT_DIRS;
        let handle = unsafe { LoadLibraryExW(wide_path.as_ptr(), std::ptr::null_mut(), flags) };
        if handle == std::ptr::null_mut() {
            return Err(generic_error("LoadLibraryExW failed for requested library"));
        }

        let loaded_path = match module_filename(handle) {
            Ok(path) => path,
            Err(error) => {
                unsafe {
                    FreeLibrary(handle);
                }
                return Err(error);
            }
        };
        let token = match insert_handle(handle) {
            Ok(token) => token,
            Err(error) => {
                unsafe {
                    FreeLibrary(handle);
                }
                return Err(error);
            }
        };

        Ok(PreloadedWindowsLibrary { token, loaded_path })
    }

    pub fn release_windows_library_impl(token: u32) -> Result<()> {
        let handle = {
            let mut guard = state()
                .lock()
                .map_err(|_| generic_error("Windows library handle table is poisoned"))?;
            guard
                .handles
                .remove(&token)
                .ok_or_else(|| generic_error("unknown Windows library preload token"))?
        };

        let released = unsafe { FreeLibrary(handle as HMODULE) };
        if released == 0 {
            return Err(generic_error("FreeLibrary failed for preloaded library"));
        }
        Ok(())
    }
}

#[cfg(not(windows))]
mod platform {
    use super::PreloadedWindowsLibrary;
    use napi::{Error, Result, Status};

    fn unsupported() -> Error {
        Error::new(
            Status::GenericFailure,
            "Windows library preloading is only supported on Windows".to_string(),
        )
    }

    pub fn preload_windows_library_impl(_absolute_path: String) -> Result<PreloadedWindowsLibrary> {
        Err(unsupported())
    }

    pub fn release_windows_library_impl(_token: u32) -> Result<()> {
        Err(unsupported())
    }
}

/// Preload one absolute Windows DLL with dependency resolution scoped to its directory.
pub fn preload_windows_library(absolute_path: String) -> napi::Result<PreloadedWindowsLibrary> {
    platform::preload_windows_library_impl(absolute_path)
}

/// Release a library handle previously acquired by preloadWindowsLibrary.
pub fn release_windows_library(token: u32) -> napi::Result<()> {
    platform::release_windows_library_impl(token)
}

#[cfg(all(test, windows))]
mod tests {
    use super::platform::{preload_windows_library_impl, release_windows_library_impl};
    use std::ffi::{OsStr, OsString};
    use std::fs;
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use windows_sys::Win32::System::LibraryLoader::{GetModuleFileNameW, GetModuleHandleW};

    static NEXT_FIXTURE_ID: AtomicUsize = AtomicUsize::new(1);

    struct FixtureSet {
        root: PathBuf,
        crypto_name: String,
        ssl_name: String,
        consumer_name: String,
    }

    impl FixtureSet {
        fn dll_path(&self, name: &str) -> PathBuf {
            self.root.join(format!("{name}.dll"))
        }
    }

    impl Drop for FixtureSet {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    struct LoadedToken {
        token: u32,
    }

    impl LoadedToken {
        fn preload(path: &Path) -> Self {
            let loaded = preload_windows_library_impl(path.display().to_string())
                .expect("preload fixture DLL");
            Self {
                token: loaded.token,
            }
        }

        fn release(&mut self) {
            if self.token != 0 {
                let token = self.token;
                self.token = 0;
                release_windows_library_impl(token).expect("release fixture DLL");
            }
        }
    }

    impl Drop for LoadedToken {
        fn drop(&mut self) {
            if self.token != 0 {
                let _ = release_windows_library_impl(self.token);
            }
        }
    }

    fn unique_suffix() -> String {
        format!(
            "{}_{}",
            std::process::id(),
            NEXT_FIXTURE_ID.fetch_add(1, Ordering::Relaxed)
        )
    }

    fn build_fixture_set() -> FixtureSet {
        let suffix = unique_suffix();
        let root = std::env::temp_dir().join(format!("sdl-loader-fixture-{suffix}"));
        fs::create_dir_all(&root).expect("create fixture directory");

        let crypto_name = format!("sdl_loader_crypto_{suffix}");
        let ssl_name = format!("sdl_loader_ssl_{suffix}");
        let consumer_name = format!("sdl_loader_consumer_{suffix}");

        build_cdylib(
            &root,
            &crypto_name,
            "#[no_mangle]\npub extern \"C\" fn sdl_loader_crypto_value() -> i32 { 7 }\n"
                .to_string(),
        );
        copy_import_library(&root, &crypto_name);

        build_cdylib(
            &root,
            &ssl_name,
            format!(
                "#[link(name = \"{crypto_name}\")]\nunsafe extern \"C\" {{ fn sdl_loader_crypto_value() -> i32; }}\n#[no_mangle]\npub extern \"C\" fn sdl_loader_ssl_value() -> i32 {{ unsafe {{ sdl_loader_crypto_value() + 1 }} }}\n"
            ),
        );
        copy_import_library(&root, &ssl_name);

        build_cdylib(
            &root,
            &consumer_name,
            format!(
                "#[link(name = \"{ssl_name}\")]\nunsafe extern \"C\" {{ fn sdl_loader_ssl_value() -> i32; }}\n#[no_mangle]\npub extern \"C\" fn sdl_loader_consumer_value() -> i32 {{ unsafe {{ sdl_loader_ssl_value() + 1 }} }}\n"
            ),
        );

        FixtureSet {
            root,
            crypto_name,
            ssl_name,
            consumer_name,
        }
    }

    fn build_cdylib(root: &Path, crate_name: &str, source: String) {
        let source_path = root.join(format!("{crate_name}.rs"));
        fs::write(&source_path, source).expect("write fixture source");
        let output_path = root.join(format!("{crate_name}.dll"));
        let output = Command::new("rustc")
            .arg("--crate-name")
            .arg(crate_name)
            .arg("--crate-type")
            .arg("cdylib")
            .arg(&source_path)
            .arg("-L")
            .arg(format!("native={}", root.display()))
            .arg("-o")
            .arg(&output_path)
            .output()
            .expect("run rustc for fixture DLL");
        if !output.status.success() {
            panic!(
                "fixture DLL build failed for {crate_name}\nstdout:\n{}\nstderr:\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
        }
    }

    fn copy_import_library(root: &Path, crate_name: &str) {
        fs::copy(
            root.join(format!("{crate_name}.dll.lib")),
            root.join(format!("{crate_name}.lib")),
        )
        .expect("copy fixture import library");
    }

    fn to_wide_null(value: &str) -> Vec<u16> {
        OsStr::new(value)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    fn loaded_module_path(module_name: &str) -> Option<PathBuf> {
        let wide_name = to_wide_null(module_name);
        let handle = unsafe { GetModuleHandleW(wide_name.as_ptr()) };
        if handle == std::ptr::null_mut() {
            return None;
        }
        let mut buffer = vec![0u16; 32_768];
        let len = unsafe { GetModuleFileNameW(handle, buffer.as_mut_ptr(), buffer.len() as u32) };
        if len == 0 {
            return None;
        }
        Some(PathBuf::from(OsString::from_wide(&buffer[..len as usize])))
    }

    fn assert_loaded_from_fixture(module_name: &str, root: &Path) {
        let loaded_path = loaded_module_path(&format!("{module_name}.dll"))
            .expect("fixture module should be loaded");
        let canonical_root = fs::canonicalize(root).expect("canonicalize fixture root");
        assert!(
            loaded_path.starts_with(&canonical_root),
            "{} was loaded from {}, outside {}",
            module_name,
            loaded_path.display(),
            canonical_root.display()
        );
    }

    #[test]
    fn release_rejects_unknown_or_double_tokens() {
        let fixtures = build_fixture_set();
        let mut crypto = LoadedToken::preload(&fixtures.dll_path(&fixtures.crypto_name));
        let token = crypto.token;
        crypto.release();

        let err = release_windows_library_impl(token).expect_err("double release should fail");
        assert!(
            err.to_string()
                .contains("unknown Windows library preload token"),
            "unexpected double-release error: {err}"
        );
    }

    #[test]
    fn dependency_handles_survive_until_consumer_is_released() {
        let fixtures = build_fixture_set();
        let mut crypto = LoadedToken::preload(&fixtures.dll_path(&fixtures.crypto_name));
        let mut ssl = LoadedToken::preload(&fixtures.dll_path(&fixtures.ssl_name));
        let mut consumer = LoadedToken::preload(&fixtures.dll_path(&fixtures.consumer_name));

        assert_loaded_from_fixture(&fixtures.crypto_name, &fixtures.root);
        assert_loaded_from_fixture(&fixtures.ssl_name, &fixtures.root);
        assert_loaded_from_fixture(&fixtures.consumer_name, &fixtures.root);

        ssl.release();
        crypto.release();

        assert_loaded_from_fixture(&fixtures.crypto_name, &fixtures.root);
        assert_loaded_from_fixture(&fixtures.ssl_name, &fixtures.root);

        consumer.release();

        assert!(loaded_module_path(&format!("{}.dll", fixtures.consumer_name)).is_none());
        assert!(loaded_module_path(&format!("{}.dll", fixtures.ssl_name)).is_none());
        assert!(loaded_module_path(&format!("{}.dll", fixtures.crypto_name)).is_none());
    }
}
