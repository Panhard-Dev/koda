#![windows_subsystem = "windows"]

use std::env;
use std::fs;
use std::path::PathBuf;
use std::process::Command;

const INSTALLER: &[u8] = include_bytes!(env!("KODA_INNER_INSTALLER"));
const WRAPPER_MARKER: &str = "KODA_TEMP_OVERRIDE_WRAPPER_V1";

#[link(name = "user32")]
unsafe extern "system" {
    fn MessageBoxW(hwnd: *mut core::ffi::c_void, text: *const u16, title: *const u16, kind: u32) -> i32;
}

fn message(text: &str) {
    let text: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
    let title: Vec<u16> = "Instalador do Koda".encode_utf16().chain(std::iter::once(0)).collect();
    unsafe {
        MessageBoxW(std::ptr::null_mut(), text.as_ptr(), title.as_ptr(), 0x10);
    }
}

fn executar() -> Result<(), String> {
    let local = env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .ok_or_else(|| "O Windows não informou a pasta local do usuário.".to_string())?;
    let instante = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let nome_pasta = format!("Koda-setup-{}-{instante}", std::process::id());
    let mut bases = vec![local.join("Temp"), local.clone()];
    if let Some(perfil) = env::var_os("USERPROFILE").map(PathBuf::from) {
        bases.push(perfil.join("Temp"));
        bases.push(perfil.join("AppData").join("Local").join("Temp"));
    }
    // Não confie em TEMP/TMP nem assuma que LOCALAPPDATA\Temp exista ou esteja
    // gravável. Tente pastas do perfil até conseguir criar uma pasta isolada.
    let mut ultimo_erro = None;
    let pasta = bases
        .into_iter()
        .map(|base| base.join(&nome_pasta))
        .find(|candidata| match fs::create_dir_all(candidata) {
            Ok(()) => true,
            Err(erro) => {
                ultimo_erro = Some(erro);
                false
            }
        })
        .ok_or_else(|| {
            format!(
                "Não consegui preparar uma pasta temporária gravável no perfil do Windows: {}",
                ultimo_erro
                    .map(|erro| erro.to_string())
                    .unwrap_or_else(|| "nenhum caminho temporário disponível".to_string())
            )
        })?;

    let setup = pasta.join("Koda-setup.exe");
    fs::write(&setup, INSTALLER)
        .map_err(|erro| format!("Não consegui extrair o instalador para {}: {erro}", setup.display()))?;

    let resultado = Command::new(&setup)
        .current_dir(&pasta)
        // O NSIS passa a usar esta pasta gravável, mesmo quando o TEMP/TMP original do
        // Windows aponta para um local ausente, somente leitura ou de baixa integridade.
        .env("TEMP", &pasta)
        .env("TMP", &pasta)
        .status()
        .map_err(|erro| format!("Não consegui iniciar o instalador do Koda: {erro}"));

    let _ = fs::remove_file(&setup);
    let _ = fs::remove_dir(&pasta);
    resultado.map(|_| ())
}

fn main() {
    if let Err(erro) = executar() {
        message(&format!("{erro} [{WRAPPER_MARKER}]"));
    }
}
