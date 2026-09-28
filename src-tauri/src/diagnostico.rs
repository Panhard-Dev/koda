//! Diagnóstico do serviço local, para a tela de Ajustes.
//!
//! Nasceu de um caso concreto: o Koda foi instalado em outro PC e a conversa respondeu
//! *"Não consegui falar com o backend (/api/chat respondeu 422)"*. Ninguém tinha como
//! saber, daquela janela, se o problema era o Python empacotado que não subiu, a porta
//! ocupada por outra coisa, ou o pedido que o serviço recusou — não havia onde olhar.
//!
//! Aqui o app responde sozinho o que dá para responder sem depender de quem está na frente
//! da máquina: o interpretador empacotado existe, ele importa `uvicorn`/`fastapi`, o host e
//! o backend respondem nas portas deles, onde ficam o banco e os dois arquivos de log, e
//! quais foram as últimas linhas que o backend escreveu (é o que aparece quando ele não
//! sobe: o `stderr` dele, que antes ia para o vazio — ver `iniciar_backend` em `main.rs`).
//!
//! A checagem roda o Python empacotado duas vezes, o que custa algumas centenas de
//! milissegundos: é uma tela que a pessoa pede, não algo do caminho da conversa.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;

use crate::servicos::Papel;
use crate::{achar_backend, log, log_do_backend, pasta_de_dados, porta_no_ar};

/// Quantas linhas do log do backend a tela mostra.
const CAUDA: usize = 60;

/// O retrato do serviço local na hora em que a pessoa pediu.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostico {
    /// Versão do app (a mesma do instalador).
    versao: String,
    /// O backend é o do instalador (`true`) ou o `backend/.venv` do projeto (`false`)?
    empacotado: bool,
    host_porta: u16,
    host_no_ar: bool,
    backend_porta: u16,
    backend_no_ar: bool,
    /// Caminho do `python.exe` que sobe a API, quando algum foi encontrado.
    python: Option<String>,
    python_existe: bool,
    /// Saída de `python -V` (`Python 3.13.14`).
    python_versao: Option<String>,
    /// Vazio quando o interpretador importa `uvicorn` e `fastapi`; senão, o erro dele.
    python_modulos: Option<String>,
    /// Pasta do banco do app instalado.
    banco: Option<String>,
    log_desktop: String,
    log_backend: String,
    /// Últimas linhas do log do backend (o que ele escreveu ao subir, ou ao morrer).
    backend_ultimas: Vec<String>,
}

impl Diagnostico {
    /// Usado quando nem a checagem foi possível.
    fn vazio(versao: String) -> Self {
        Diagnostico {
            versao,
            empacotado: false,
            host_porta: Papel::Host.porta(),
            host_no_ar: false,
            backend_porta: Papel::Backend.porta(),
            backend_no_ar: false,
            python: None,
            python_existe: false,
            python_versao: None,
            python_modulos: Some("não consegui rodar a checagem".to_string()),
            banco: None,
            log_desktop: caminho_do_log("koda-desktop.log").display().to_string(),
            log_backend: caminho_do_log("koda-backend.log").display().to_string(),
            backend_ultimas: Vec::new(),
        }
    }
}

/// Caminho de um arquivo de diagnóstico (`%TEMP%\koda-*.log`).
pub fn caminho_do_log(nome: &str) -> PathBuf {
    std::env::temp_dir().join(nome)
}

/// Últimas linhas de um arquivo, sem estourar quando ele não existe ou é enorme.
fn cauda(caminho: &Path, quantas: usize) -> Vec<String> {
    let Ok(texto) = std::fs::read_to_string(caminho) else {
        return Vec::new();
    };
    let linhas: Vec<&str> = texto.lines().collect();
    linhas[linhas.len().saturating_sub(quantas)..]
        .iter()
        .map(|linha| linha.trim_end().to_string())
        .collect()
}

/// Roda o interpretador empacotado e devolve a saída (stdout e stderr juntos).
fn rodar(python: &Path, argumentos: &[&str]) -> Option<String> {
    let saida = Command::new(python).args(argumentos).output().ok()?;
    let mut texto = String::from_utf8_lossy(&saida.stdout).trim().to_string();
    let erro = String::from_utf8_lossy(&saida.stderr).trim().to_string();
    if !erro.is_empty() {
        if !texto.is_empty() {
            texto.push('\n');
        }
        texto.push_str(&erro);
    }
    Some(texto)
}

/// O que este app consegue ver do serviço local agora.
pub fn coletar(versao: String, app: &tauri::AppHandle) -> Diagnostico {
    let backend = achar_backend(app);
    let caminho_python = backend.as_ref().map(|backend| backend.python.clone());

    let (python_versao, python_modulos) = match caminho_python.as_deref() {
        Some(python) if python.is_file() => {
            let versao = rodar(python, &["-V"]);
            let modulos = rodar(python, &["-c", "import uvicorn, fastapi"]);
            (versao, modulos)
        }
        _ => (None, None),
    };

    let mut diagnostico = Diagnostico {
        versao,
        empacotado: backend.as_ref().is_some_and(|backend| backend.empacotado),
        host_porta: Papel::Host.porta(),
        host_no_ar: porta_no_ar(Papel::Host.porta()),
        backend_porta: Papel::Backend.porta(),
        backend_no_ar: porta_no_ar(Papel::Backend.porta()),
        python: caminho_python.map(|caminho| caminho.display().to_string()),
        python_existe: false,
        python_versao,
        python_modulos,
        banco: pasta_de_dados(app).map(|pasta| pasta.join("koda.db").display().to_string()),
        log_desktop: caminho_do_log("koda-desktop.log").display().to_string(),
        log_backend: log_do_backend().display().to_string(),
        backend_ultimas: Vec::new(),
    };
    diagnostico.python_existe = diagnostico
        .python
        .as_deref()
        .is_some_and(|caminho| Path::new(caminho).is_file());
    diagnostico.backend_ultimas = cauda(&log_do_backend(), CAUDA);
    // `python_modulos` vazio significa "importa tudo" — fica vazio, e não "None": a tela
    // distingue "sem erro" de "não deu para checar".
    diagnostico
}

/// Diagnóstico do serviço local para a tela de Ajustes.
#[tauri::command]
pub async fn diagnostico(app: tauri::AppHandle) -> Diagnostico {
    let versao = app.package_info().version.to_string();
    let handle = app.clone();
    let resultado =
        tauri::async_runtime::spawn_blocking(move || coletar(versao.clone(), &handle)).await;
    match resultado {
        Ok(diagnostico) => {
            log(&format!(
                "diagnóstico: backend={} python={:?} modulos={:?}",
                diagnostico.backend_no_ar, diagnostico.python_versao, diagnostico.python_modulos
            ));
            diagnostico
        }
        Err(erro) => {
            log(&format!("diagnóstico falhou: {erro}"));
            Diagnostico::vazio(app.package_info().version.to_string())
        }
    }
}
