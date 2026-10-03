#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Shell desktop do Koda (Tauri 2).
//!
//! A interface é a mesma do navegador (Vite → `dist`). Ao abrir, o app sobe as duas
//! peças que a conversa precisa, nesta ordem:
//!
//! 1. **host** (`host/c-host.exe`) — o serviço de modelos oficial (Liz);
//! 2. **backend** (`backend/python/python.exe`) — a API FastAPI que a interface fala.
//!
//! As **duas** portas são escolhidas na abertura e vivem em `acesso`: efêmeras no app
//! instalado, as fixas de sempre (21128 e 8787) em dev. O **token** da execução vai junto
//! e os três são entregues à interface por `invoke`.
//!
//! Nada é reutilizado às cegas: se a porta estiver ocupada, o dono dela é identificado
//! (ver `portas`) e só **outra janela do Koda** é reutilizada — sobra de execução morta sai
//! da frente, e um programa estranho não é tocado nem consultado. O host é a razão de isso
//! estar escrito: com a 21128 fixa, um estranho ouvindo lá era tratado como "host já no ar"
//! e o backend mandava a sessão da conta para ele. Sem host ou sem backend, a interface cai
//! no modo offline dela — nada quebra, só responde menos.
//!
//! E os dois **nascem e morrem com o app** (ver `servicos`): o encerramento explícito na
//! saída, mais a job object do Windows, que derruba os serviços até quando o Koda morre sem
//! passar por aqui. Enquanto a janela estiver aberta, um vigia confere as portas e reergue
//! o que o próprio app subiu — a conversa não pode ficar sem serviço no meio do uso.
//!
//! As portas podem ser fixadas por `KODA_HOST_PORT`/`KODA_API_PORT`, e o endereço do host
//! por `KODA_HOST_URL` — os ganchos de teste e de quem sobe um serviço à mão. O app
//! instalado não define nenhum deles.
//!
//! Os dois serviços vão **dentro do instalador** e o app os encontra ao lado do exe; no dev
//! são os do projeto (`host/c-host.exe` e `backend/.venv`). O backend empacotado leva o
//! próprio interpretador Python, porque na máquina do cliente não existe projeto nem `uv` —
//! e o banco vai para a pasta de dados do app, que é gravável mesmo com o programa
//! instalado.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use tauri::{AppHandle, LogicalSize, Manager, RunEvent};

mod acesso;
mod diagnostico;
mod portas;
mod servicos;

use acesso::Acesso;
use portas::Ocupante;
use servicos::{Papel, Servicos};

/// Endereço do painel (Koda Cloud) que o host consulta para saber se quem está falando
/// pode — e com qual conta.
///
/// O `c-host.exe` **não carrega endereço nenhum dentro dele**: lê daqui. Sem esta variável
/// ele recusa tudo com 503 (fail-closed), então o app precisa passá-la ao subir o host.
/// Não é segredo: o mesmo domínio já aparece no CSP e no padrão de `KODA_CLOUD_URL`. O que
/// nunca entra no binário é a **chave** — quem a apresenta é a sessão da conta, guardada
/// só na memória do backend.
const URL_DO_PAINEL: &str = "https://koda-cloud-api.studiosluxgames.workers.dev";

/// Diagnóstico em arquivo: no modo `windows_subsystem`, o stdout não existe.
/// O log fica em `%TEMP%\koda-desktop.log` — apagar à vontade.
pub(crate) fn log(mensagem: &str) {
    use std::io::Write;
    let caminho = diagnostico::caminho_do_log("koda-desktop.log");
    if let Ok(mut arquivo) = std::fs::OpenOptions::new().create(true).append(true).open(&caminho) {
        let _ = writeln!(arquivo, "{mensagem}");
    }
}

/// Onde o backend escreve o que ele tem a dizer: `%TEMP%\koda-backend.log`.
///
/// O backend do instalador subia com `stdout`/`stderr` no vazio (`Stdio::null()`), então
/// uma máquina em que ele não subia não deixava rastro nenhum: nem o `ImportError` do
/// Python empacotado, nem a porta ocupada, nem o `Traceback` da subida. Agora a saída dele
/// vai para este arquivo — o vigia reergue o serviço várias vezes por execução, então o
/// arquivo é reaberto a cada subida e vale a última.
pub(crate) fn log_do_backend() -> PathBuf {
    std::env::temp_dir().join("koda-backend.log")
}

pub(crate) fn porta_no_ar(porta: u16) -> bool {
    let endereco: SocketAddr = format!("127.0.0.1:{porta}").parse().expect("endereço fixo");
    TcpStream::connect_timeout(&endereco, Duration::from_millis(300)).is_ok()
}

/// A porta em que um serviço está atendendo **nesta execução**.
///
/// As duas vêm do estado `Acesso`, e não de uma constante: no app instalado elas são
/// sorteadas na abertura (efêmeras), porque uma porta fixa na máquina de outra pessoa é uma
/// aposta — e a 21128 em particular já perdeu essa aposta em campo mais de uma vez.
fn porta_de(papel: Papel, acesso: &Acesso) -> u16 {
    match papel {
        Papel::Host => acesso.porta_host(),
        Papel::Backend => acesso.porta(),
    }
}

/// O serviço **responde**, e não só aceita conexão.
///
/// `porta_no_ar` abre um TCP e fecha: serviço pendurado (aceita conexão e não responde nada)
/// passa como "no ar" e o vigia fica quieto. Era o pior cenário possível — a janela aberta, a
/// conversa falhando em "não consegui falar com o provedor" e o vigia sem fazer nada, porque
/// para ele o serviço estava vivo. Aqui vai um `GET` de verdade, com prazo curto: qualquer
/// resposta HTTP serve (até 401, que é o backend recusando sem token — o que interessa é que
/// alguém do outro lado está processando pedido).
fn servico_responde(papel: Papel, acesso: &Acesso) -> bool {
    let porta = porta_de(papel, acesso);
    let caminho = match papel {
        Papel::Host => "/v1/models",
        Papel::Backend => "/api/health",
    };
    let endereco: SocketAddr = format!("127.0.0.1:{porta}").parse().expect("endereço fixo");
    let Ok(mut fluxo) = TcpStream::connect_timeout(&endereco, Duration::from_millis(500)) else {
        return false;
    };
    let _ = fluxo.set_read_timeout(Some(Duration::from_secs(3)));
    let _ = fluxo.set_write_timeout(Some(Duration::from_secs(3)));
    let pedido = format!(
        "GET {caminho} HTTP/1.1\r\nHost: 127.0.0.1:{porta}\r\nConnection: close\r\n\r\n"
    );
    if fluxo.write_all(pedido.as_bytes()).is_err() {
        return false;
    }
    let mut resposta = [0u8; 32];
    match fluxo.read(&mut resposta) {
        Ok(0) => false,                       // fechou sem dizer nada
        Ok(_) => resposta.starts_with(b"HTTP/"), // respondeu HTTP: está processando
        Err(_) => false,                      // pendurado: nem o cabeçalho veio
    }
}

/// Espera a porta abrir (até `segundos`), conferindo de meio em meio segundo.
fn esperar_porta(porta: u16, segundos: u64) -> bool {
    let prazo = Instant::now() + Duration::from_secs(segundos);
    while Instant::now() < prazo {
        if porta_no_ar(porta) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    porta_no_ar(porta)
}

/// Procura `relativo` subindo a árvore de pastas a partir de `a_partir`.
///
/// No dev o app roda de dentro de `src-tauri`; instalado, do diretório do exe —
/// subir até a raiz do projeto cobre os dois.
fn achar_subindo(a_partir: &Path, relativo: &str) -> Option<PathBuf> {
    let mut pasta = Some(a_partir.to_path_buf());
    while let Some(atual) = pasta {
        let candidato = atual.join(relativo);
        if candidato.is_file() {
            return Some(candidato);
        }
        pasta = atual.parent().map(Path::to_path_buf);
    }
    None
}

/// Spawna sem janela de console piscando (só importa no Windows).
fn spawn_oculto(comando: &mut Command) -> std::io::Result<Child> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        comando.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    comando.spawn()
}

// ----------------------------------------------------------------- portas

/// O estado de uma porta depois de tentarmos liberá-la.
///
/// Antes isto era um `bool` — "deu para subir?" — e o `false` misturava duas coisas muito
/// diferentes: *outra janela do Koda está viva e os serviços são dela* (reutilizar é o
/// certo) e *tem um programa estranho aqui* (reutilizar é o defeito). O host tratava as
/// duas como reutilização, e era assim que a sessão da conta acabava enviada a quem
/// estivesse ouvindo na 21128. Com o motivo separado, cada caso recebe a resposta certa.
enum Porta {
    /// Livre: pode subir o nosso serviço (já estava livre, ou a sobra saiu da frente).
    Livre,
    /// Outra janela do Koda está viva: os serviços são dela, e reutilizá-los é o certo.
    OutraJanela,
    /// Ocupada por quem **não** é nosso. Não se fala com ele e não se mata: o motivo vai
    /// para o log e quem chamou decide (sortear outra porta, ou desistir).
    Estranha(String),
}

/// Tenta deixar a porta livre para subirmos o nosso serviço.
fn liberar_porta(porta: u16, imagem: &str, assinatura: Option<&str>) -> Porta {
    match portas::dono_da_sobra(porta, imagem, assinatura) {
        Ocupante::Ninguem => Porta::Livre,
        Ocupante::OutraJanela => {
            log(&format!("porta {porta} é de outra janela do Koda — reutilizando"));
            Porta::OutraJanela
        }
        Ocupante::Alheio(motivo) => {
            log(&format!("porta {porta} ocupada por {motivo} — deixando quieto"));
            Porta::Estranha(motivo)
        }
        Ocupante::Sobra(pid) => {
            log(&format!(
                "porta {porta}: sobra de execução anterior (pid {pid}) — encerrando para subir o nosso"
            ));
            if !portas::encerrar(pid) {
                log(&format!("não consegui encerrar o pid {pid} — mantendo o que está no ar"));
                return Porta::Estranha(format!("sobra nossa que não sai (pid {pid})"));
            }
            if portas::esperar_fechar(porta, 5) {
                Porta::Livre
            } else {
                log(&format!("a porta {porta} continuou ocupada depois de encerrar o pid {pid}"));
                Porta::Estranha(format!("sobra nossa que não soltou a porta (pid {pid})"))
            }
        }
    }
}

// ----------------------------------------------------------------- host (Liz)

fn achar_host(app: &AppHandle) -> Option<PathBuf> {
    let mut candidatos: Vec<PathBuf> = Vec::new();

    // No NSIS, Tauri instala os recursos ao lado do executável (o backend é encontrado
    // nesse mesmo diretório). Em alguns layouts de atualização os recursos ficam sob
    // `resources/`; aceitar os dois evita deixar o app sem modelos só por um nível de
    // diferença no diretório-base.
    if let Ok(recursos) = app.path().resource_dir() {
        candidatos.push(recursos.join("host").join("c-host.exe"));
        candidatos.push(recursos.join("resources").join("host").join("c-host.exe"));
        // Compatibilidade com builds que mapearam `host/*` diretamente na raiz.
        candidatos.push(recursos.join("c-host.exe"));
    }
    if let Ok(cwd) = std::env::current_dir() {
        candidatos.push(achar_subindo(&cwd, "host/c-host.exe").unwrap_or_default());
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(pasta) = exe.parent() {
            candidatos.push(pasta.join("host").join("c-host.exe"));
            candidatos.push(pasta.join("resources").join("host").join("c-host.exe"));
            candidatos.push(achar_subindo(pasta, "host/c-host.exe").unwrap_or_default());
        }
    }

    // Elimina caminhos repetidos e registra o que foi procurado: em instalações
    // distribuídas, isto diferencia erro de layout de arquivo removido/quarentenado.
    candidatos.sort();
    candidatos.dedup();
    if let Some(host) = candidatos.iter().find(|caminho| caminho.is_file()) {
        log(&format!("host encontrado: {}", host.display()));
        return Some(host.clone());
    }
    log(&format!(
        "c-host.exe ausente; caminhos verificados: {}",
        candidatos
            .iter()
            .filter(|caminho| !caminho.as_os_str().is_empty())
            .map(|caminho| caminho.display().to_string())
            .collect::<Vec<_>>()
            .join(" | ")
    ));
    None
}

/// O erro de subida foi o **antivírus** bloqueando o arquivo?
///
/// `225` é `ERROR_VIRUS_INFECTED` e `1260` é "bloqueado por política": nos dois casos o
/// Windows recusou executar o binário — e, no caso do 225, costuma removê-lo logo depois (o
/// log seguinte passa a dizer "c-host.exe ausente", e aí não há o que reerguer).
///
/// Não é falha do app, da porta nem do backend: é o `c-host.exe` sendo tratado como ameaça.
/// O caminho de saída é excluir a pasta de instalação da verificação em tempo real. Dito por
/// extenso porque a mensagem crua do Windows ("Não foi possível concluir a operação com
/// êxito…") não diz a ninguém o que fazer.
fn antivirus_bloqueou(erro: &std::io::Error) -> bool {
    matches!(erro.raw_os_error(), Some(225) | Some(1260))
}

/// A linha do log para quando o antivírus barra o host.
fn aviso_de_antivirus(caminho: &Path) -> String {
    format!(
        "o ANTIVÍRUS bloqueou o host: o Windows recusou executar {} e costuma removê-lo em \
         seguida (ERROR_VIRUS_INFECTED). Não é falha do Koda: exclua a pasta do Koda da \
         verificação em tempo real (Segurança do Windows → Proteção contra vírus e ameaças \
         → Exclusões → pasta) e reabra o app.",
        caminho.display()
    )
}

/// Sobe o host. `false` = a porta não respondeu (o vigia tenta de novo).
fn iniciar_host(servicos: &Servicos, app: &AppHandle) -> bool {
    let acesso = app.state::<Acesso>();
    let mut porta = acesso.porta_host();

    // Quem está nesta porta?
    //
    // No dev é a 21128 de sempre: pode ser o host do desenvolvedor (aí reutilizamos), uma
    // sobra de execução que morreu (sai da frente) ou um programa qualquer (não subimos).
    // No instalado a porta acabou de ser sorteada, então não deveria ter ninguém: se tiver,
    // é corrida — e o certo é sortear outra.
    //
    // O que **não** se faz, em nenhum dos casos, é conversar com quem não prova ser nosso
    // host. Era exatamente isso que o ramo antigo fazia: um estranho na 21128 virava "host
    // já está no ar — reutilizando", e o backend mandava o `Authorization: Bearer <sessão
    // da conta>` para ele a cada conversa.
    match liberar_porta(porta, "c-host.exe", None) {
        Porta::Livre => {}
        Porta::OutraJanela => {
            log(&format!("host já está no ar em 127.0.0.1:{porta} — reutilizando"));
            servicos.cuidar_de(Papel::Host);
            return true;
        }
        Porta::Estranha(motivo) => {
            if !acesso.empacotado() {
                // No dev quem manda na 21128 é o desenvolvedor. Subir por cima do que está
                // lá seria brigar pela porta de alguém; falhar e dizer é o honesto.
                log(&format!(
                    "a porta {porta} está ocupada por {motivo} — não vou subir o host por cima \
                     dela (use KODA_HOST_PORT para escolher outra)"
                ));
                return false;
            }
            let Some(nova) = acesso::porta_livre(&[acesso.porta(), porta]) else {
                log("não consegui sortear outra porta para o host — seguindo sem ele");
                return false;
            };
            log(&format!(
                "porta {porta} estava com {motivo} — subindo o host em 127.0.0.1:{nova}"
            ));
            acesso.fixar_porta_host(nova);
            porta = nova;
        }
    }

    // Daqui para baixo vamos subir o nosso: se ele morrer, o vigia sobe de novo.
    servicos.cuidar_de(Papel::Host);

    let Some(host) = achar_host(app) else {
        // A ausência do arquivo é, quase sempre, o **depois** do bloqueio acima: o antivírus
        // recusou a execução e removeu o binário. Sem dizer isso, "não encontrado" parece
        // instalação quebrada — e a pessoa reinstala para o antivírus comer de novo.
        log(
            "host (c-host.exe) não encontrado no disco — na maioria das vezes é o antivírus \
             que o removeu. Exclua a pasta do Koda da verificação em tempo real (Segurança do \
             Windows → Proteção contra vírus e ameaças → Exclusões) e repare/reinstale o Koda.",
        );
        return false;
    };
    log(&format!("iniciando host: {}", host.display()));

    let mut comando = Command::new(&host);
    // A porta vai **sempre** explícita. O host aceita `-port` desde sempre (o default dele é
    // que era o problema): no dev o valor é a 21128 de sempre, e no instalado é a sorteada.
    comando.args(["-port", &porta.to_string()]);
    // Onde o host pergunta se a chave de quem está falando vale. `KODA_CLOUD_URL` permite
    // apontar para outro painel (útil em teste) sem recompilar.
    let painel = std::env::var("KODA_CLOUD_URL").unwrap_or_else(|_| URL_DO_PAINEL.to_string());
    log(&format!("host vai autorizar contra {painel}"));
    comando.env("SERVE_LIZ_AUTH_URL", painel);
    comando.stdout(Stdio::null()).stderr(Stdio::null());

    match spawn_oculto(&mut comando) {
        Ok(child) => {
            let pid = child.id();
            servicos.guardar(Papel::Host, child);
            if esperar_porta(porta, 15) {
                log(&format!("host no ar em 127.0.0.1:{porta} (pid {pid})"));
                true
            } else {
                log("host não respondeu a tempo — os modelos oficiais ficam de fora");
                false
            }
        }
        Err(erro) => {
            if antivirus_bloqueou(&erro) {
                log(&aviso_de_antivirus(&host));
            } else {
                log(&format!("falha ao iniciar o host: {erro}"));
            }
            false
        }
    }
}

// ----------------------------------------------------------------- backend (API)

/// Onde o backend está e como chamá-lo.
pub(crate) struct Backend {
    /// `python.exe` usado para validar o runtime. O servidor prefere o `pythonw.exe`
    /// irmão para não abrir uma janela de console no Windows.
    pub(crate) python: PathBuf,
    /// Pasta de trabalho — é de onde o `app.main` é importado, então o `app/` tem que
    /// estar aqui dentro.
    pub(crate) pasta: PathBuf,
    /// Veio do instalador? Então o banco vai para a pasta de dados do app, que é
    /// gravável mesmo com o programa instalado. No dev fica como sempre foi.
    pub(crate) empacotado: bool,
}

/// O backend instalado ao lado do exe (recurso `backend/`), ou o `.venv` do projeto no dev.
///
/// O empacotado vem primeiro: instalado não existe projeto nenhum para procurar, e o
/// layout do recurso é a resposta certa quando o app foi instalado.
pub(crate) fn achar_backend(app: &AppHandle) -> Option<Backend> {
    if let Ok(recursos) = app.path().resource_dir() {
        let pasta = recursos.join("backend");
        let python = pasta.join("python").join("python.exe");
        if python.is_file() {
            return Some(Backend { python, pasta, empacotado: true });
        }
    }

    // Dev: `backend/.venv/Scripts/python.exe` subindo a partir de onde o app está.
    let venv = std::env::current_dir()
        .ok()
        .and_then(|pasta| achar_subindo(&pasta, "backend/.venv/Scripts/python.exe"))
        .or_else(|| {
            std::env::current_exe()
                .ok()
                .and_then(|exe| achar_subindo(exe.parent()?, "backend/.venv/Scripts/python.exe"))
        })?;
    // `backend/.venv/Scripts/python.exe` → `.venv/Scripts` → `.venv` → `backend`
    let pasta = venv
        .parent()
        .and_then(Path::parent)
        .and_then(Path::parent)?
        .to_path_buf();
    Some(Backend { python: venv, pasta, empacotado: false })
}

/// Pasta de dados do app (`%APPDATA%\app.koda.desktop`), criada se ainda não existir.
///
/// O banco não pode morar na pasta de instalação: o SQLite escreve ao lado do arquivo
/// (modo WAL) e uma pasta de programa pode ser só de leitura.
pub(crate) fn pasta_de_dados(app: &AppHandle) -> Option<PathBuf> {
    let pasta = app.path().app_data_dir().ok()?.join("data");
    match std::fs::create_dir_all(&pasta) {
        Ok(()) => Some(pasta),
        Err(erro) => {
            log(&format!("não consegui criar {}: {erro}", pasta.display()));
            None
        }
    }
}

/// Trecho da linha de comando que identifica o backend do Koda. `python.exe` é genérico
/// demais para valer pelo nome: sem isto, um Python qualquer escutando na porta seria
/// encerrado em nome de um serviço que não é nosso.
const ASSINATURA_DO_BACKEND: &str = "app.main:app";

/// Sobe o backend. `false` = a porta não respondeu (o vigia tenta de novo, no app instalado).
fn iniciar_backend(servicos: &Servicos, app: &AppHandle) -> bool {
    let acesso = app.state::<Acesso>();
    let porta = acesso.porta();
    let token = acesso.token().to_string();
    let backend = achar_backend(app);

    // Alguém já está nesta porta. A pergunta não é "é o Koda?", é "você conhece o token que
    // eu acabei de sortear?" — e só o backend desta execução conhece.
    if porta_no_ar(porta) {
        if acesso::confere_handshake(porta, &token) {
            log(&format!("backend desta execução já está no ar em 127.0.0.1:{porta} — reutilizando"));
            servicos.cuidar_de(Papel::Backend);
            return true;
        }
        // Não provou. Sendo sobra de uma execução que morreu — o app fechado no tapa deixa
        // os filhos vivos, com o token velho na memória —, ele sai da frente. Era o defeito
        // que o handshake fecha: antes, o app novo adotava esse resto e a tela abria com a
        // memória do app anterior (provedor escolhido, cache da nuvem) achando que estava tudo bem.
        //
        // `Porta::Livre` é a única resposta que permite seguir: outra janela do Koda tem
        // serviços com **outro** token (não são nossos), e um estranho não é nosso de jeito
        // nenhum.
        if !matches!(
            liberar_porta(porta, "python.exe", Some(ASSINATURA_DO_BACKEND)),
            Porta::Livre
        ) {
            log(&format!(
                "a porta {porta} está com quem não prova ser o backend desta execução — deixando quieto"
            ));
            return false;
        }
    }

    let Some(backend) = backend else {
        log("backend não encontrado (nem o do instalador nem backend/.venv) — interface em modo offline");
        return false;
    };
    let executavel = executavel_backend(&backend.python);
    log(&format!(
        "iniciando backend{}: {}",
        if backend.empacotado { " empacotado" } else { " do projeto" },
        executavel.display()
    ));

    // Antes de subir, o interpretador se apresenta: existe, roda e importa o que a API
    // precisa. Se ele não passar aqui, o problema é o runtime empacotado — e não a porta,
    // nem a rede, nem a conta — e isso precisa estar escrito no log, com o erro dele.
    conferir_python(&backend.python);

    let mut comando = Command::new(&executavel);
    comando
        .args(["-m", "uvicorn", "app.main:app", "--port", &porta.to_string()])
        .current_dir(&backend.pasta)
        // O token vai pelo **stdin**, e não pelo ambiente: o ambiente dos processos filhos
        // é montado a partir de uma allowlist (ver `_ambiente_do_comando`) justamente para
        // o código do agente não ler segredo nenhum. Aqui o canal é aberto só para isto, e
        // o backend o lê antes de atender a primeira rota.
        .stdin(Stdio::piped())
        // Define so o padrao: KODA_PROVIDER explicito no ambiente ou .env prevalece.
        .env("KODA_BACKEND_PACKAGED", if backend.empacotado { "1" } else { "0" });

    // Onde o host está **nesta execução**. O backend tem um literal compilado
    // (`127.0.0.1:21128/v1` em `config.py`) e, sem isto, falaria com a 21128 de sempre —
    // que no instalado pode ser de outro programa, ou simplesmente não existir. Com o host
    // numa porta sorteada, esta variável é o que amarra os dois lados: sem ela, o app
    // subiria o host numa porta e conversaria com outra.
    //
    // Um `KODA_HOST_URL` já no ambiente manda: é assim que se aponta o backend para um host
    // remoto (ou para a 21128 de um host que o desenvolvedor subiu à mão) sem recompilar.
    if std::env::var("KODA_HOST_URL").is_err() {
        comando.env(
            "KODA_HOST_URL",
            format!("http://127.0.0.1:{}/v1", acesso.porta_host()),
        );
    }

    // A saída do backend vai para o arquivo (ver `log_do_backend`): é por onde se descobre,
    // na máquina de quem instalou, por que ele não subiu.
    match std::fs::File::create(log_do_backend()) {
        Ok(arquivo) => {
            let copia = arquivo.try_clone();
            comando.stdout(Stdio::from(arquivo));
            match copia {
                Ok(segundo) => {
                    comando.stderr(Stdio::from(segundo));
                }
                Err(_) => {
                    comando.stderr(Stdio::null());
                }
            }
            log(&format!("saída do backend em {}", log_do_backend().display()));
        }
        Err(erro) => {
            log(&format!("não consegui abrir o log do backend: {erro}"));
            comando.stdout(Stdio::null()).stderr(Stdio::null());
        }
    }

    if backend.empacotado {
        if let Some(pasta) = pasta_de_dados(app) {
            let banco = pasta.join("koda.db");
            log(&format!("banco do app instalado: {}", banco.display()));
            comando.env("KODA_DATABASE_PATH", banco);
        }
        // Sem isto o Python do pacote pode reclamar de bytecode/paths em pastas de
        // programa; nada disso é nosso e nada disso precisa aparecer na tela.
        comando.env("PYTHONDONTWRITEBYTECODE", "1");
    }

    let empacotado = backend.empacotado;
    match spawn_oculto(&mut comando) {
        Ok(mut child) => {
            let pid = child.id();
            // O token, antes de qualquer coisa: o backend só sobe o serviço depois de lê-lo.
            acesso::entregar_token(&mut child, &token);
            servicos.guardar(Papel::Backend, child);
            // Só o backend do instalador entra no vigia: no dev quem manda nele é o
            // desenvolvedor, e ressuscitar um por cima do dele seria brigar pela porta.
            if empacotado {
                servicos.cuidar_de(Papel::Backend);
            }
            // O instalado é Python completo subindo a frio; 20s já foi apertado.
            if esperar_porta(porta, 40) {
                log(&format!("backend no ar em 127.0.0.1:{porta} (pid {pid})"));
                true
            } else {
                log("backend não respondeu a tempo — interface em modo offline");
                false
            }
        }
        Err(erro) => {
            log(&format!("falha ao iniciar o backend: {erro}"));
            false
        }
    }
}

/// Usa o subsistema Windows sem console quando o runtime fornece `pythonw.exe`.
///
/// `stdin`, `stdout` e `stderr` continuam explicitamente ligados a pipes/arquivo no
/// chamador, então o token e os logs do backend seguem funcionando normalmente.
fn executavel_backend(python: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        let sem_console = python.with_file_name("pythonw.exe");
        if sem_console.is_file() {
            return sem_console;
        }
    }
    python.to_path_buf()
}

/// Confere o interpretador antes de contar com ele e escreve o resultado no log.
///
/// `true` = ele roda e importa `uvicorn`/`fastapi`. A checagem custa o tempo de duas
/// subidas do Python (algumas centenas de milissegundos) e roda uma vez por tentativa de
/// subida — barato perto de uma janela que abre sem serviço e sem dizer por quê.
fn conferir_python(python: &Path) -> bool {
    if !python.is_file() {
        log(&format!("python do backend não existe: {}", python.display()));
        return false;
    }
    let executavel = executavel_backend(python);

    let versao = Command::new(&executavel).arg("-V").output();
    match versao {
        Ok(saida) => {
            let texto = if saida.stdout.is_empty() {
                String::from_utf8_lossy(&saida.stderr)
            } else {
                String::from_utf8_lossy(&saida.stdout)
            };
            log(&format!("python do backend: {}", texto.trim()));
        }
        Err(erro) => {
            log(&format!("não consegui rodar {}: {erro}", executavel.display()));
            return false;
        }
    }

    // O import é o teste que importa: interpretador que roda mas não acha `uvicorn`
    // (runtime montado pela metade, pasta movida, antivírus comendo arquivo) sobe, morre
    // em silêncio e deixa a interface sem serviço.
    match Command::new(&executavel)
        .args(["-c", "import uvicorn, fastapi"])
        .output()
    {
        Ok(saida) if saida.status.success() => {
            log("python do backend importa uvicorn e fastapi");
            true
        }
        Ok(saida) => {
            let erro = String::from_utf8_lossy(&saida.stderr);
            let resumo: String = erro.trim().lines().take(6).collect::<Vec<_>>().join(" | ");
            log(&format!(
                "python do backend NÃO importa uvicorn/fastapi (código {:?}): {resumo}",
                saida.status.code()
            ));
            false
        }
        Err(erro) => {
            log(&format!("não consegui testar os módulos do python: {erro}"));
            false
        }
    }
}

// ----------------------------------------------------------------- vigia

/// Sobe um serviço e diz se a porta dele respondeu.
fn subir(servicos: &Servicos, app: &AppHandle, papel: Papel) -> bool {
    match papel {
        Papel::Host => iniciar_host(servicos, app),
        Papel::Backend => iniciar_backend(servicos, app),
    }
}

/// A abertura do app **e** a vigilância, no mesmo laço.
///
/// A primeira volta é a abertura: cada serviço decide sozinho o que fazer com a porta
/// (sobra de execução morta sai da frente, o resto é reutilizado, como sempre foi). Depois
/// disso o laço só cuida do que **este app** subiu: porta fora do ar vira nova tentativa,
/// com espera crescente e limite (`pode_subir`). É isto que evita o pior cenário do
/// cliente: a janela aberta, a conversa andando e um dos serviços morto sem ninguém notar.
fn vigiar(app: &AppHandle, servicos: &Servicos) {
    let acesso = app.state::<Acesso>();
    let mut primeira = true;
    loop {
        for papel in Papel::todas() {
            if servicos.parando() {
                log("vigia encerrado com o app");
                return;
            }
            if primeira {
                subir(servicos, app, papel);
                continue;
            }
            if servico_responde(papel, &acesso) {
                servicos.anotar_ok(papel);
                continue;
            }
            // Não é nosso ou já insistimos demais: ficar quieto é a resposta certa.
            if !servicos.cuidado(papel) || !servicos.pode_subir(papel) {
                continue;
            }
            log(&format!(
                "{} (porta {}) não responde — {} nosso(s) vivo(s); subindo de novo",
                papel.nome(),
                porta_de(papel, &acesso),
                servicos.quantos_vivos(papel)
            ));
            subir(servicos, app, papel);
        }
        primeira = false;
        std::thread::sleep(Duration::from_secs(2));
    }
}

// ----------------------------------------------------------------- janela

/// Tamanho preferido da janela — o mesmo do `tauri.conf.json`.
const JANELA_LARGURA: f64 = 1280.0;
const JANELA_ALTURA: f64 = 820.0;

/// Piso de segurança: em tela minúscula a janela ainda precisa caber.
const JANELA_MINIMA_LARGURA: f64 = 640.0;
const JANELA_MINIMA_ALTURA: f64 = 480.0;

/// Folga entre a janela e a borda da área útil, para a sombra não encostar.
const FOLGA: f64 = 24.0;

/// O tamanho que a janela deve ter numa área útil de `largura`×`altura` (em pixels
/// lógicos): o preferido, **limitado** pelo que cabe na tela.
///
/// Função pura de propósito — é a regra que decidia o "abre bugada" e é ela que os testes
/// de baixo cobrem, sem precisar abrir janela nenhuma.
fn tamanho_da_janela(largura_tela: f64, altura_tela: f64) -> (f64, f64) {
    let largura = (largura_tela - FOLGA).min(JANELA_LARGURA).max(JANELA_MINIMA_LARGURA);
    let altura = (altura_tela - FOLGA).min(JANELA_ALTURA).max(JANELA_MINIMA_ALTURA);
    (largura, altura)
}

/// Encaixa a janela na tela antes de mostrá-la.
///
/// O tamanho do config **não cabe** em monitor menor (1280×820 não entra num 1366×768, e
/// com escala de 125% piora), e janela maior que a área útil abre cortada — era o "abre
/// bugada em qualquer resolução". Aqui o tamanho passa a ser o pedido **limitado** pela
/// área útil do monitor, e a janela nasce centralizada.
///
/// A folga de 24px é para a sombra não encostar na borda. O `visible: false` do config
/// existe para isto: a janela só aparece depois de já estar do tamanho certo.
fn encaixar_na_tela(app: &tauri::App) {
    let Some(janela) = app.get_webview_window("main") else {
        return;
    };
    let Ok(Some(monitor)) = janela.primary_monitor() else {
        let _ = janela.show();
        return;
    };
    let escala = monitor.scale_factor();
    // `work_area` já desconta a barra de tarefas; o resto do sistema informa a tela toda.
    let area = monitor.work_area();
    let largura_tela = area.size.width as f64 / escala;
    let altura_tela = area.size.height as f64 / escala;
    let (largura, altura) = tamanho_da_janela(largura_tela, altura_tela);

    if let Err(erro) = janela.set_size(LogicalSize::new(largura, altura)) {
        log(&format!("não consegui ajustar a janela: {erro}"));
    }
    if let Err(erro) = janela.center() {
        log(&format!("não consegui centralizar a janela: {erro}"));
    }
    let _ = janela.show();
    log(&format!(
        "janela: {largura:.0}x{altura:.0} (tela útil {largura_tela:.0}x{altura_tela:.0} @ {escala}x)"
    ));
}

// ----------------------------------------------------------------- app

fn main() {
    tauri::Builder::default()
        .manage(Servicos::novo())
        // As credenciais desta execução nascem antes da janela: a interface pergunta por
        // elas por `invoke` assim que carrega, e no app instalado a porta não é a 8787.
        .manage(Acesso::novo())
        .invoke_handler(tauri::generate_handler![diagnostico::diagnostico, acesso::acesso])
        .setup(|app| {
            // As duas portas são decididas antes de tudo: efêmeras no instalado, as fixas
            // (8787 e 21128) no dev. A partir daqui não mudam — quem já pediu as credenciais
            // continua certo, e o host já foi subido sabendo onde escutar.
            let empacotado = achar_backend(app.handle()).is_some_and(|backend| backend.empacotado);
            let (porta, porta_host) = acesso::escolher_portas(empacotado);
            let estado = app.state::<Acesso>();
            estado.fixar_empacotado(empacotado);
            estado.fixar_porta(porta);
            estado.fixar_porta_host(porta_host);
            log(&format!(
                "backend desta execução vai atender em 127.0.0.1:{porta} e o host em \
                 127.0.0.1:{porta_host}{}",
                if empacotado { " (instalado)" } else { " (dev)" }
            ));

            encaixar_na_tela(app);
            let handle: AppHandle = app.handle().clone();
            // Fora do caminho da janela: o app abre sem esperar os serviços, e a
            // interface mostra o estado (online/offline) quando eles responderem.
            std::thread::spawn(move || {
                log("--- Koda desktop iniciado ---");
                let servicos = handle.state::<Servicos>();
                vigiar(&handle, servicos.inner());
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("erro ao construir o app Koda")
        .run(|app, evento| {
            // As duas portas de saída: o pedido (a janela fechando) e o fim mesmo.
            // Encerrar nas duas é barato — depois da primeira a lista fica vazia — e é o
            // que faz as portas ficarem livres antes do próximo Koda abrir.
            if matches!(evento, RunEvent::ExitRequested { .. } | RunEvent::Exit) {
                app.state::<Servicos>().encerrar_todos();
            }
        });
}

#[cfg(test)]
mod testes_da_janela {
    use super::*;

    /// O caso que motivou o conserto: 1280×820 não cabe num 1366×768, e a janela abria
    /// cortada. Aqui ela encolhe para caber, sem passar do preferido.
    #[test]
    fn encolhe_para_caber_na_tela() {
        assert_eq!(tamanho_da_janela(1366.0, 744.0), (1280.0, 720.0));
        assert_eq!(tamanho_da_janela(1280.0, 720.0), (1256.0, 696.0));
    }

    /// Tela grande não estica a janela além do preferido.
    #[test]
    fn nao_passa_do_tamanho_preferido() {
        assert_eq!(tamanho_da_janela(1920.0, 1040.0), (1280.0, 820.0));
        assert_eq!(tamanho_da_janela(3840.0, 2120.0), (1280.0, 820.0));
    }

    /// Tela minúscula: o piso segura a janela num tamanho ainda usável.
    #[test]
    fn tela_minuscula_respeita_o_piso() {
        assert_eq!(tamanho_da_janela(800.0, 600.0), (776.0, 576.0));
        assert_eq!(tamanho_da_janela(500.0, 400.0), (640.0, 480.0));
    }
}
