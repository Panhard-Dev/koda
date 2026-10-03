//! O acesso à API local: **porta efêmera** e **token por execução**.
//!
//! O backend escuta em loopback, e loopback não é fronteira de segurança: qualquer
//! processo desta máquina alcança a porta — inclusive o código que o agente roda. Antes
//! disto, quem alcançasse a 8787 podia chamar `PUT /api/permissions`, se dar o modo `auto`
//! e passar a agir sem cartão. O que fecha essa porta são duas coisas, e as duas nascem
//! aqui:
//!
//! 1. **Token por execução.** Sorteado a cada abertura do app, entregue ao backend por
//!    `stdin` (nunca por ambiente, que é justamente o que o código do agente lê) e à
//!    interface por `invoke`. Sem ele, o backend responde 401 em tudo que é `/api`.
//! 2. **Porta efêmera.** No app instalado a porta é escolhida na hora, em vez da 8787
//!    fixa: quem quisesse falar com o backend precisaria antes descobrir onde ele está.
//!    A 8787 continua valendo em dev, que é onde ela é útil.
//!
//! O **handshake** existe para o caso de já haver alguém na porta: o launcher manda um
//! nonce e confere o HMAC que volta. Só adota o que provar conhecer o token desta execução;
//! o resto é sobra e sai da frente. Como o token é por execução, um backend de execução
//! anterior **nunca** prova — e matar e subir outro é o comportamento esperado, não erro.
//!
//! **As duas portas do app nascem aqui** (a da API e a do host). A do host também era fixa
//! (21128) e isso não se sustentou: numa máquina onde **outro programa** já ocupa a 21128 o
//! app antigo ou não subia o host, ou — pior — tratava o estranho como se fosse o host e
//! mandava a sessão da conta para ele. Endereço fixo em máquina que não é nossa não é
//! endereço, é aposta.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::time::Duration;

use serde::Serialize;

use crate::log;
use crate::servicos::{PORTA_API, PORTA_HOST};

/// Quantos bytes de aleatoriedade tem o token (256 bits).
const BYTES_DO_TOKEN: usize = 32;

/// Quantos bytes tem o nonce do handshake.
const BYTES_DO_NONCE: usize = 16;

/// Prazo das duas pontas do handshake.
const PRAZO: Duration = Duration::from_millis(1500);

/// O que a interface recebe por `invoke` para falar com o backend.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Credenciais {
    /// Onde a API está atendendo **nesta execução**.
    pub porta: u16,
    /// O que ela exige no `Authorization: Bearer …`.
    pub token: String,
}

/// As credenciais desta execução, vivas enquanto o app estiver aberto.
///
/// As portas começam nas de dev e são fixadas no `setup`, depois de o app saber se é o
/// instalado ou o do projeto — daí os átomos, e não campos comuns.
pub struct Acesso {
    porta: AtomicU16,
    /// A porta do host (`c-host.exe`) **desta execução**.
    ///
    /// Mora aqui, e não numa constante, pelo mesmo motivo da porta da API: no app instalado
    /// ela é sorteada a cada abertura. A 21128 fixa era uma aposta de que ninguém mais na
    /// máquina do cliente estaria usando aquela porta — e essa aposta se perde com
    /// frequência suficiente para ter virado relatório de campo.
    porta_host: AtomicU16,
    /// O app é o instalado? É o que decide se as portas são sorteadas ou as fixas de dev.
    empacotado: AtomicBool,
    token: String,
}

impl Acesso {
    /// Sorteia o token desta execução. Chamado uma vez, na abertura do app.
    pub fn novo() -> Acesso {
        Acesso {
            porta: AtomicU16::new(PORTA_API),
            porta_host: AtomicU16::new(PORTA_HOST),
            empacotado: AtomicBool::new(false),
            token: sortear(BYTES_DO_TOKEN),
        }
    }

    pub fn fixar_porta(&self, porta: u16) {
        self.porta.store(porta, Ordering::SeqCst);
    }

    pub fn porta(&self) -> u16 {
        self.porta.load(Ordering::SeqCst)
    }

    /// Troca a porta do host. Usada no `setup` e, de novo, se a sorteada for tomada por
    /// outra coisa entre a escolha e a subida (ver `iniciar_host`).
    pub fn fixar_porta_host(&self, porta: u16) {
        self.porta_host.store(porta, Ordering::SeqCst);
    }

    pub fn porta_host(&self) -> u16 {
        self.porta_host.load(Ordering::SeqCst)
    }

    pub fn fixar_empacotado(&self, empacotado: bool) {
        self.empacotado.store(empacotado, Ordering::SeqCst);
    }

    pub fn empacotado(&self) -> bool {
        self.empacotado.load(Ordering::SeqCst)
    }

    pub fn token(&self) -> &str {
        &self.token
    }
}

/// As portas desta execução, na ordem `(api, host)`.
///
/// `KODA_API_PORT`/`KODA_HOST_PORT` mandam (são os ganchos de teste e de quem sobe o serviço
/// à mão). Sem elas, o dev fica nas fixas — 8787 e 21128, que é o que o Vite e o
/// `backend/.env` esperam — e o instalado sorteia as duas.
///
/// **As duas sorteadas são diferentes entre si**, e é por isso que a segunda recebe a
/// primeira como exclusão: `porta_livre` abre e fecha o soquete na hora, então duas chamadas
/// seguidas podem devolver a mesma porta — e aí o host e o backend brigariam por ela.
pub fn escolher_portas(empacotado: bool) -> (u16, u16) {
    let api = escolher("KODA_API_PORT", PORTA_API, empacotado, &[]);
    let host = escolher("KODA_HOST_PORT", PORTA_HOST, empacotado, &[api]);
    (api, host)
}

fn escolher(variavel: &str, padrao: u16, empacotado: bool, excluir: &[u16]) -> u16 {
    if let Some(porta) = std::env::var(variavel).ok().and_then(|valor| valor.parse().ok()) {
        return porta;
    }
    if !empacotado {
        return padrao;
    }
    porta_livre(excluir).unwrap_or(padrao)
}

/// Deixa o sistema escolher uma porta livre em loopback e a devolve.
///
/// O soquete fecha na saída da função, então há uma janela mínima entre escolher e o serviço
/// subir. Numa faixa de portas efêmeras isso é praticamente impossível de acertar por acaso
/// — e se acertar, o handshake abaixo percebe e o serviço não é adotado.
///
/// `excluir` existe para as duas portas do app não saírem iguais (ver `escolher_portas`).
/// `None` = o sistema não tinha porta para dar, que é o caso em que o chamador cai no
/// padrão e diz no log o que aconteceu.
pub fn porta_livre(excluir: &[u16]) -> Option<u16> {
    for _ in 0..8 {
        let soquete = TcpListener::bind("127.0.0.1:0").ok()?;
        let endereco = soquete.local_addr().ok()?;
        if !excluir.contains(&endereco.port()) {
            return Some(endereco.port());
        }
    }
    None
}

/// `n` bytes aleatórios em hexadecimal.
fn sortear(n: usize) -> String {
    let mut bytes = vec![0u8; n];
    if getrandom::fill(&mut bytes).is_err() {
        // Sem aleatoriedade do sistema não há token que valha: é melhor o app falhar de
        // forma visível do que subir com um segredo previsível.
        panic!("não consegui sortear aleatoriedade do sistema para o token da API");
    }
    hex(&bytes)
}

fn hex(bytes: &[u8]) -> String {
    let mut texto = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        texto.push_str(&format!("{byte:02x}"));
    }
    texto
}

/// HMAC-SHA256, em hexadecimal.
///
/// Escrito aqui em cima do `sha2` (que o projeto já compila) em vez de trazer o crate
/// `hmac`: a construção são vinte linhas e a alternativa era uma dependência a mais no
/// binário do cliente.
fn hmac_sha256(chave: &[u8], mensagem: &[u8]) -> [u8; 32] {
    use sha2::{Digest, Sha256};

    const BLOCO: usize = 64;
    let mut chave_interna = [0u8; BLOCO];
    if chave.len() > BLOCO {
        chave_interna[..32].copy_from_slice(&Sha256::digest(chave));
    } else {
        chave_interna[..chave.len()].copy_from_slice(chave);
    }

    let mut interno = Sha256::new();
    interno.update(chave_interna.map(|byte| byte ^ 0x36));
    interno.update(mensagem);
    let resumo = interno.finalize();

    let mut externo = Sha256::new();
    externo.update(chave_interna.map(|byte| byte ^ 0x5c));
    externo.update(resumo);
    let saida = externo.finalize();

    let mut bytes = [0u8; 32];
    bytes.copy_from_slice(&saida);
    bytes
}

/// O HMAC que este launcher espera de volta para um nonce.
pub fn hmac_do_nonce(token: &str, nonce: &str) -> String {
    hex(&hmac_sha256(token.as_bytes(), nonce.as_bytes()))
}

/// Compara sem sair no primeiro byte diferente.
fn iguais(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diferenca = 0u8;
    for (x, y) in a.bytes().zip(b.bytes()) {
        diferenca |= x ^ y;
    }
    diferenca == 0
}

/// Faz um `GET` cru na porta e devolve o corpo, se vier um `200`.
fn pedir(porta: u16, caminho: &str) -> Option<String> {
    let endereco: SocketAddr = format!("127.0.0.1:{porta}").parse().ok()?;
    let mut fluxo = TcpStream::connect_timeout(&endereco, PRAZO).ok()?;
    fluxo.set_read_timeout(Some(PRAZO)).ok()?;
    fluxo.set_write_timeout(Some(PRAZO)).ok()?;
    let pedido =
        format!("GET {caminho} HTTP/1.1\r\nHost: 127.0.0.1:{porta}\r\nConnection: close\r\n\r\n");
    fluxo.write_all(pedido.as_bytes()).ok()?;
    let mut resposta = String::new();
    fluxo.read_to_string(&mut resposta).ok()?;
    let (cabecalhos, corpo) = resposta.split_once("\r\n\r\n")?;
    if !cabecalhos.starts_with("HTTP/1.1 200") && !cabecalhos.starts_with("HTTP/1.0 200") {
        return None;
    }
    Some(corpo.to_string())
}

/// O que está nesta porta é o backend **desta execução**?
///
/// Manda um nonce e confere o HMAC devolvido. Não é uma pergunta de "é o Koda?": é "você
/// conhece o token que eu acabei de sortear?". Um backend de execução anterior — que é o
/// caso real, o que sobra de um app que morreu no tapa — responde que não.
pub fn confere_handshake(porta: u16, token: &str) -> bool {
    let nonce = sortear(BYTES_DO_NONCE);
    let esperado = hmac_do_nonce(token, &nonce);
    let Some(corpo) = pedir(porta, &format!("/api/handshake?nonce={nonce}")) else {
        return false;
    };
    match serde_json::from_str::<serde_json::Value>(&corpo) {
        Ok(valor) => match valor.get("hmac").and_then(|campo| campo.as_str()) {
            Some(servidor) => iguais(&esperado, servidor),
            None => false,
        },
        Err(_) => false,
    }
}

/// Porta e token desta execução, para a interface.
///
/// É por aqui que a interface sabe onde falar: no app instalado a porta não é a 8787 nem
/// é sempre a mesma, e o token não existe em lugar nenhum que o código do agente alcance.
#[tauri::command]
pub fn acesso(acesso: tauri::State<'_, Acesso>) -> Credenciais {
    Credenciais { porta: acesso.porta(), token: acesso.token().to_string() }
}

/// Escreve o token na entrada padrão do backend e fecha o canal.
///
/// É por aqui, e não pelo ambiente, porque o ambiente é herdado por **todo** processo que o
/// backend abrir — e é o backend que roda o shell e o Python do agente. Um token em variável
/// de ambiente ficaria ao alcance de qualquer comando que o próprio agente executasse.
///
/// (Não existe allowlist de ambiente no launcher: o filho herda o ambiente inteiro. Se um
/// dia ela existir, este é o comentário que descreve o que ela protegeria.)
pub fn entregar_token(filho: &mut std::process::Child, token: &str) -> bool {
    let Some(mut entrada) = filho.stdin.take() else {
        log("backend subiu sem canal de entrada — não consegui entregar o token");
        return false;
    };
    let escrito = writeln!(entrada, "{token}").and_then(|_| entrada.flush());
    match escrito {
        Ok(()) => {
            log("token da execução entregue ao backend pelo stdin");
            true
        }
        Err(erro) => {
            log(&format!("não consegui entregar o token ao backend: {erro}"));
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// O HMAC tem que bater com o do Python, byte a byte — é o que faz o handshake valer.
    /// Vetor conferido com `hmac.new(b"koda", b"nonce", hashlib.sha256).hexdigest()`.
    #[test]
    fn hmac_bate_com_o_do_python() {
        assert_eq!(
            hmac_do_nonce("koda", "nonce"),
            "c8ae299e4311092d943f0278c5774e2a1f382d2b03ee51982916077281bc0b41"
        );
    }

    /// Chave vazia não pode virar pânico nem sair diferente: é o caso do backend que subiu
    /// sem token (a rota do handshake responde HMAC de chave vazia).
    #[test]
    fn chave_vazia_ainda_calcula() {
        assert_eq!(
            hmac_do_nonce("", "x"),
            "4cbc96099a6467ce002461f10549b4898265ebe6188b45efacc44293516e62c4"
        );
    }

    #[test]
    fn o_hmac_muda_com_o_nonce_e_com_o_token() {
        assert_ne!(hmac_do_nonce("a", "nonce"), hmac_do_nonce("a", "outro"));
        assert_ne!(hmac_do_nonce("a", "nonce"), hmac_do_nonce("b", "nonce"));
        // Determinístico: mesma entrada, mesma saída.
        assert_eq!(hmac_do_nonce("a", "nonce"), hmac_do_nonce("a", "nonce"));
    }

    /// Vetor oficial do RFC 4231 (caso 2), que é o que prova que a construção está certa.
    #[test]
    fn hmac_segue_o_vetor_do_rfc_4231() {
        let chave = b"Jefe";
        let mensagem = b"what do ya want for nothing?";
        assert_eq!(
            hex(&hmac_sha256(chave, mensagem)),
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
    }

    #[test]
    fn o_token_e_longo_e_sempre_diferente() {
        let um = sortear(BYTES_DO_TOKEN);
        let outro = sortear(BYTES_DO_TOKEN);
        assert_eq!(um.len(), BYTES_DO_TOKEN * 2);
        assert_ne!(um, outro);
        assert!(um.chars().all(|caractere| caractere.is_ascii_hexdigit()));
    }

    #[test]
    fn a_comparacao_nao_aceita_tamanho_diferente() {
        assert!(iguais("abc", "abc"));
        assert!(!iguais("abc", "abd"));
        assert!(!iguais("abc", "ab"));
        assert!(!iguais("", "a"));
    }

    /// As duas portas do instalado saem livres e **diferentes** entre si.
    ///
    /// Livres: nenhuma delas aceita conexão agora (a efêmera não valeria nada se caísse numa
    /// porta ocupada). Diferentes: é o que impede o host e o backend de brigarem pela mesma
    /// — `porta_livre` abre e fecha o soquete na hora, então duas chamadas seguidas podiam
    /// devolver o mesmo número.
    #[test]
    fn as_duas_portas_do_instalado_sao_livres_e_diferentes() {
        let (api, host) = escolher_portas(true);
        assert_ne!(api, host, "o host e o backend não podem ficar na mesma porta");
        for porta in [api, host] {
            let endereco = format!("127.0.0.1:{porta}").parse().expect("endereço");
            assert!(
                TcpStream::connect_timeout(&endereco, Duration::from_millis(200)).is_err(),
                "a porta {porta} já estava ocupada"
            );
        }
        // Sem os ganchos de ambiente, o instalado sorteia em vez de usar as fixas.
        if std::env::var("KODA_API_PORT").is_err() {
            assert_ne!(api, PORTA_API);
        }
        if std::env::var("KODA_HOST_PORT").is_err() {
            assert_ne!(host, PORTA_HOST);
        }
    }

    /// O dev continua nas duas portas fixas — é o que o Vite e o `backend/.env` esperam.
    #[test]
    fn o_dev_fica_nas_portas_fixas() {
        // Não mexemos no ambiente do processo de teste: só confirmamos que, sem ninguém
        // pedir outra porta, o dev não sorteia.
        if std::env::var("KODA_API_PORT").is_err() && std::env::var("KODA_HOST_PORT").is_err() {
            assert_eq!(escolher_portas(false), (PORTA_API, PORTA_HOST));
        }
    }

    /// Handshake de verdade contra um backend de mentira que **conhece** o token e outro
    /// que não conhece — os dois casos que decidem se o serviço é adotado.
    #[test]
    fn o_handshake_recusa_quem_nao_prova() {
        let (porta, _guardado) = backend_de_mentira(Some("token-desta-execucao"));
        assert!(confere_handshake(porta, "token-desta-execucao"));
        assert!(!confere_handshake(porta, "token-de-outra-execucao"));
    }

    #[test]
    fn porta_vazia_nao_passa_no_handshake() {
        let porta = porta_livre(&[]).expect("o sistema tem porta livre");
        assert!(!confere_handshake(porta, "qualquer"));
    }

    /// Um backend mínimo: responde o HMAC do nonce, como o de verdade (ver
    /// `app/seguranca.py`). Roda até o teste acabar.
    ///
    /// Cada conexão é atendida na sua própria thread e é **fechada explicitamente**
    /// (`shutdown`): o cliente lê até o fim do corpo, então depender da hora em que o
    /// descarte do soquete acontece deixaria o teste à mercê do coletor de lixo — e foi
    /// exatamente assim que ele ficou instável na primeira versão.
    fn backend_de_mentira(token: Option<&str>) -> (u16, std::thread::JoinHandle<()>) {
        use std::net::Shutdown;

        let soquete = TcpListener::bind("127.0.0.1:0").expect("porta livre");
        let porta = soquete.local_addr().expect("endereço").port();
        let token = token.map(str::to_string);
        let fio = std::thread::spawn(move || {
            for conexao in soquete.incoming() {
                let Ok(mut fluxo) = conexao else { break };
                let token = token.clone();
                std::thread::spawn(move || {
                    let nonce = ler_nonce(&mut fluxo);
                    let corpo = match &token {
                        Some(token) => format!(r#"{{"hmac":"{}"}}"#, hmac_do_nonce(token, &nonce)),
                        None => r#"{"hmac":""}"#.to_string(),
                    };
                    let resposta = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        corpo.len(),
                        corpo
                    );
                    let _ = fluxo.write_all(resposta.as_bytes());
                    let _ = fluxo.shutdown(Shutdown::Both);
                });
            }
        });
        (porta, fio)
    }

    /// Lê a linha do pedido e devolve o `nonce` da consulta.
    fn ler_nonce(fluxo: &mut TcpStream) -> String {
        let mut pedido: Vec<u8> = Vec::new();
        let mut bloco = [0u8; 512];
        while !pedido.windows(2).any(|par| par == b"\r\n") {
            match fluxo.read(&mut bloco) {
                Ok(0) | Err(_) => break,
                Ok(lidos) => pedido.extend_from_slice(&bloco[..lidos]),
            }
        }
        String::from_utf8_lossy(&pedido)
            .split_whitespace()
            .nth(1)
            .and_then(|alvo| alvo.split("nonce=").nth(1))
            .unwrap_or("")
            .to_string()
    }
}
