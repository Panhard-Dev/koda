//! Quem está ocupando uma porta — e quando isso é sobra de uma execução que já morreu.
//!
//! O app abre as duas peças que a conversa usa (host em 21128, backend numa porta que ele
//! mesmo escolhe — ver `acesso`) e aceitava reutilizar qualquer coisa que já estivesse
//! ouvindo nessas portas. Duas armadilhas moram aí, e as duas apareceram na prática:
//!
//! 1. **Host de uma versão anterior.** O desenho antigo levava a chave embutida e não
//!    conhecia a autorização remota, então recusava a sessão da conta com 401 — e a
//!    conversa caía no modelo local sem ninguém entender por quê.
//! 2. **Backend de uma execução morta.** Quem morre no tapa (gerenciador de tarefas, erro)
//!    deixa os filhos vivos. O app seguinte adotava esse resto, com o provedor escolhido e o
//!    cache da nuvem que estavam na memória dele.
//!
//! Este módulo responde à pergunta que faltava: o que está na porta é **nosso** e é
//! **sobra**? Só nesse caso ele deve sair da frente. Quem decide se o serviço é desta
//! execução é o handshake de `acesso` — aqui só se descobre o que é aquele processo. Nada
//! aqui aparece para o usuário — vira linha de log.

/// O que encontramos escutando na porta.
#[derive(Debug, PartialEq, Eq)]
pub enum Ocupante {
    /// Ninguém está ouvindo: a porta é nossa para subir o serviço.
    Ninguem,
    /// Outra janela do Koda está viva — os serviços são dela, e ela é quem manda.
    OutraJanela,
    /// Ocupada por outra coisa (com o motivo, para o log).
    Alheio(String),
    /// Sobra nossa: o pid deve ser encerrado antes de subirmos o serviço.
    Sobra(u32),
}

/// Decide o que fazer com o que estiver na porta.
///
/// `imagem` é o executável que aceitamos considerar nosso (`c-host.exe`, `python.exe`) e
/// `assinatura` é um trecho da linha de comando que confirma que é mesmo o serviço do Koda
/// (o Python é um executável genérico demais para valer só pelo nome).
pub fn dono_da_sobra(porta: u16, imagem: &str, assinatura: Option<&str>) -> Ocupante {
    if !porta_aberta(porta) {
        return Ocupante::Ninguem;
    }
    if sistema::janelas_do_koda() > 1 {
        return Ocupante::OutraJanela;
    }
    let Some(pid) = sistema::dono_da_porta(porta) else {
        return Ocupante::Alheio("não consegui descobrir o pid".to_string());
    };
    match sistema::nome_do_processo(pid) {
        Some(nome) if nome.eq_ignore_ascii_case(imagem) => {}
        Some(nome) => return Ocupante::Alheio(format!("outro programa: {nome} (pid {pid})")),
        None => return Ocupante::Alheio(format!("processo fora do alcance (pid {pid})")),
    }
    if let Some(assinatura) = assinatura {
        let linha = sistema::linha_de_comando(pid).unwrap_or_default();
        if !linha.contains(assinatura) {
            return Ocupante::Alheio(format!("{imagem} que não é do Koda (pid {pid})"));
        }
    }
    Ocupante::Sobra(pid)
}

/// Encerra o processo e o que ele tiver aberto, esperando a porta fechar de verdade.
pub fn encerrar(pid: u32) -> bool {
    sistema::encerrar(pid)
}

/// A porta ficou livre depois de encerrar o dono dela?
pub fn esperar_fechar(porta: u16, segundos: u64) -> bool {
    sistema::esperar_fechar(porta, segundos)
}

/// Alguém está ouvindo nesta porta?
fn porta_aberta(porta: u16) -> bool {
    use std::net::{SocketAddr, TcpStream};
    use std::time::Duration;
    let endereco: SocketAddr = format!("127.0.0.1:{porta}").parse().expect("endereço fixo");
    TcpStream::connect_timeout(&endereco, Duration::from_millis(300)).is_ok()
}

/// Qual processo está escutando nesta porta, lido do `netstat -ano`.
///
/// A linha é `TCP  127.0.0.1:8787  0.0.0.0:0  LISTENING  7884`.
fn pid_da_linha_do_netstat(texto: &str, porta: u16) -> Option<u32> {
    let alvo = format!(":{porta}");
    for linha in texto.lines() {
        let campos: Vec<&str> = linha.split_whitespace().collect();
        if campos.len() < 5 {
            continue;
        }
        // Protocolo, endereço local, endereço remoto, estado, pid.
        if !campos[0].eq_ignore_ascii_case("TCP")
            || !campos[1].ends_with(&alvo)
            || !campos[3].eq_ignore_ascii_case("LISTENING")
        {
            continue;
        }
        if let Ok(pid) = campos[4].parse() {
            return Some(pid);
        }
    }
    None
}

/// Nome do executável a partir do CSV do `tasklist` — `"python.exe","7884",…`.
///
/// Quando não há processo correspondente, o `tasklist` responde uma linha de aviso; ela não
/// termina em `.exe` e por isso vira `None`.
fn nome_da_linha_do_tasklist(texto: &str) -> Option<String> {
    let nome = texto.lines().next()?.split(',').next()?.trim().trim_matches('"');
    if nome.is_empty() || !nome.to_ascii_lowercase().ends_with(".exe") {
        return None;
    }
    Some(nome.to_string())
}

#[cfg(windows)]
mod sistema {
    use std::net::{SocketAddr, TcpStream};
    use std::os::windows::process::CommandExt;
    use std::process::Command;
    use std::time::{Duration, Instant};

    /// Roda um utilitário do Windows sem janela de console piscando.
    fn executar(programa: &str, argumentos: &[&str]) -> Option<String> {
        let mut comando = Command::new(programa);
        comando.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        let saida = comando.args(argumentos).output().ok()?;
        saida
            .status
            .success()
            .then(|| String::from_utf8_lossy(&saida.stdout).into_owned())
    }

    pub fn dono_da_porta(porta: u16) -> Option<u32> {
        let texto = executar("netstat", &["-ano"])?;
        super::pid_da_linha_do_netstat(&texto, porta)
    }

    pub fn nome_do_processo(pid: u32) -> Option<String> {
        let filtro = format!("PID eq {pid}");
        let texto = executar("tasklist", &["/FI", &filtro, "/FO", "CSV", "/NH"])?;
        super::nome_da_linha_do_tasklist(&texto)
    }

    /// Linha de comando do processo — é o que separa o backend do Koda de qualquer Python.
    pub fn linha_de_comando(pid: u32) -> Option<String> {
        let script =
            format!("(Get-CimInstance Win32_Process -Filter \"ProcessId={pid}\").CommandLine");
        let texto = executar("powershell", &["-NoProfile", "-Command", &script])?;
        let linha = texto.trim().to_string();
        (!linha.is_empty()).then_some(linha)
    }

    pub fn encerrar(pid: u32) -> bool {
        executar("taskkill", &["/PID", &pid.to_string(), "/T", "/F"]).is_some()
    }

    /// Quantas janelas do Koda estão vivas, contando esta.
    pub fn janelas_do_koda() -> usize {
        // Consulta falhou? Digamos "outra janela", que é o palpite que **não** encerra nada.
        executar("tasklist", &["/FI", "IMAGENAME eq koda.exe", "/FO", "CSV", "/NH"])
            .map(|texto| texto.to_ascii_lowercase().matches("koda.exe").count())
            .unwrap_or(2)
    }

    pub fn esperar_fechar(porta: u16, segundos: u64) -> bool {
        let endereco: SocketAddr = format!("127.0.0.1:{porta}").parse().expect("endereço fixo");
        let ocupada = || TcpStream::connect_timeout(&endereco, Duration::from_millis(200)).is_ok();
        let prazo = Instant::now() + Duration::from_secs(segundos);
        while Instant::now() < prazo {
            if !ocupada() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        !ocupada()
    }
}

#[cfg(not(windows))]
mod sistema {
    //! Fora do Windows os utilitários não existem: nada é identificado nem encerrado —
    //! o comportamento volta a ser o antigo, o de reutilizar o que estiver na porta.

    pub fn dono_da_porta(_porta: u16) -> Option<u32> {
        None
    }

    pub fn nome_do_processo(_pid: u32) -> Option<String> {
        None
    }

    pub fn linha_de_comando(_pid: u32) -> Option<String> {
        None
    }

    pub fn encerrar(_pid: u32) -> bool {
        false
    }

    pub fn janelas_do_koda() -> usize {
        1
    }

    pub fn esperar_fechar(_porta: u16, _segundos: u64) -> bool {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const REDE: &str = "\
Conexões ativas

  Proto  Endereço local         Endereço externo       Estado           PID
  TCP    127.0.0.1:8787         0.0.0.0:0              LISTENING        7884
  TCP    0.0.0.0:21128          0.0.0.0:0              LISTENING        11296
  TCP    [::]:21128             [::]:0                 LISTENING        11296
  TCP    127.0.0.1:8787         127.0.0.1:51234        ESTABLISHED      2
  TCP    127.0.0.1:1128         0.0.0.0:0              LISTENING        12976
  UDP    127.0.0.1:8787         *:*                                    3";

    #[test]
    fn acha_o_pid_de_quem_escuta() {
        assert_eq!(pid_da_linha_do_netstat(REDE, 8787), Some(7884));
        assert_eq!(pid_da_linha_do_netstat(REDE, 21128), Some(11296));
    }

    #[test]
    fn nao_confunde_porta_parecida_nem_conexao_estabelecida() {
        // A comparação é pelo fim do endereço: 878 não casa com a linha do 8787, e
        // 21128 (a linha do host) não casa com 1128 (a do Vite).
        assert_eq!(pid_da_linha_do_netstat(REDE, 878), None);
        assert_eq!(pid_da_linha_do_netstat(REDE, 1128), Some(12976));
        assert_eq!(pid_da_linha_do_netstat(REDE, 21128), Some(11296));
        // Só `LISTENING` conta: uma conexão estabelecida na mesma porta não entra.
        assert_eq!(
            pid_da_linha_do_netstat("  TCP  127.0.0.1:8787  0.0.0.0:0  ESTABLISHED  9", 8787),
            None
        );
        assert_eq!(pid_da_linha_do_netstat("", 8787), None);
    }

    #[test]
    fn le_o_nome_do_processo_do_tasklist() {
        let linha = "\"python.exe\",\"7884\",\"Console\",\"1\",\"17.236 K\"\n";
        assert_eq!(nome_da_linha_do_tasklist(linha).as_deref(), Some("python.exe"));
        assert_eq!(nome_da_linha_do_tasklist("\"c-host.exe\",\"11296\",\"Console\",\"1\",\"22 K\"").as_deref(), Some("c-host.exe"));
    }

    #[test]
    fn recusa_a_linha_de_aviso_do_tasklist() {
        let aviso = "INFO: No tasks are running which match the specified criteria.\n";
        assert_eq!(nome_da_linha_do_tasklist(aviso), None);
        assert_eq!(nome_da_linha_do_tasklist(""), None);
    }

    /// Perguntas de verdade ao sistema: abrimos um soquete nesta máquina e conferimos que
    /// `netstat`, `tasklist` e `powershell` respondem o que o módulo espera. O parser acima
    /// pode estar certo e a ferramenta mudar de formato — é isto que pega isso.
    #[cfg(windows)]
    mod sistema_de_verdade {
        use super::super::sistema;
        use std::net::TcpListener;

        #[test]
        fn descobre_o_pid_de_um_soquete_nosso() {
            let soquete = TcpListener::bind("127.0.0.1:0").expect("soquete livre");
            let porta = soquete.local_addr().expect("endereço").port();
            assert_eq!(sistema::dono_da_porta(porta), Some(std::process::id()));
        }

        #[test]
        fn descobre_o_nome_e_a_linha_de_comando_do_proprio_processo() {
            let eu = std::process::id();
            let nome = sistema::nome_do_processo(eu).expect("nome do processo");
            assert!(nome.to_ascii_lowercase().ends_with(".exe"), "nome inesperado: {nome}");
            let linha = sistema::linha_de_comando(eu).expect("linha de comando");
            assert!(
                linha.to_ascii_lowercase().contains(&nome.to_ascii_lowercase()),
                "linha inesperada: {linha}"
            );
        }

        #[test]
        fn pid_inexistente_nao_vira_processo() {
            assert_eq!(sistema::nome_do_processo(0xFFFF_FF00), None);
        }
    }
}
