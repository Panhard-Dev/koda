//! Os serviços que o app mantém no ar — e que precisam morrer junto com ele.
//!
//! O Koda abre duas peças: o **host** (`c-host.exe`, porta 21128 — o serviço de modelos) e o
//! **backend** (FastAPI, porta 8787 — a API que a interface fala). Duas garantias faltavam,
//! e as duas apareceram na prática:
//!
//! 1. **Fechar o app fechava os dois?** Só quando o Koda saía pela porta da frente. O
//!    `RunEvent::Exit` encerra os filhos, mas quem morre no tapa — gerenciador de tarefas,
//!    travada, erro durante uma atualização — não passa por ali, e os processos ficavam no
//!    ar: a máquina do cliente com um `c-host.exe` e um `python.exe` órfãos e ninguém
//!    sabendo de quem são. A resposta é a *job object* do Windows com
//!    `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`: entrando nela, os serviços são derrubados pelo
//!    próprio sistema no instante em que este processo termina, **de qualquer jeito**. O
//!    encerramento explícito continua existindo, para a saída ser imediata e para o caso
//!    do job falhar.
//! 2. **Serviço que caía no meio da conversa não voltava.** O app abria com os dois no ar e
//!    ficava com a porta vazia se um deles estourasse — o sintoma é a conversa piorando
//!    sozinha no meio do uso. Aqui mora também a conta do vigia: quantas vezes já tentamos
//!    reerguer e quanto falta para a próxima (`pode_subir`), com limite para não virar um
//!    laço de reinício eterno.

use std::collections::HashMap;
use std::process::Child;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::log;

/// Porta do host (`c-host.exe`) — a mesma que o backend usa em `KODA_HOST_URL`.
pub const PORTA_HOST: u16 = 21128;
/// Porta da API FastAPI — a mesma que o frontend usa em `api/client.ts`.
pub const PORTA_API: u16 = 8787;

/// Quantas vezes seguidas vale a pena reerguer um serviço que caiu.
const TENTATIVAS_MAX: u32 = 5;

/// Cadência depois de esgotar as tentativas rápidas: cinco minutos entre uma e outra.
///
/// O vigia **não** desiste de vez. Era o que faltava num PC onde o serviço caía por motivo
/// passageiro: esgotadas as cinco tentativas, a sessão inteira ficava sem modelos até alguém
/// reabrir o app. Devagar é melhor que nunca.
const ESPERA_DESISTIDO: Duration = Duration::from_secs(300);

/// Qual das duas peças é esta.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Papel {
    Host,
    Backend,
}

impl Papel {
    /// Nome para o log.
    pub fn nome(self) -> &'static str {
        match self {
            Papel::Host => "host",
            Papel::Backend => "backend",
        }
    }

    /// A porta em que ela escuta.
    ///
    /// `KODA_HOST_PORT`/`KODA_API_PORT` trocam a porta padrão: é o gancho que permite
    /// exercitar este ciclo de vida (nasce, morre, ressuscita) em teste, sem encostar nos
    /// serviços do Koda que o desenvolvedor já está usando. O app instalado nunca define
    /// essas variáveis — e com elas ligadas é só o ciclo de vida que faz sentido, porque a
    /// interface continua falando com a 8787.
    pub fn porta(self) -> u16 {
        let (variavel, padrao) = match self {
            Papel::Host => ("KODA_HOST_PORT", PORTA_HOST),
            Papel::Backend => ("KODA_API_PORT", PORTA_API),
        };
        std::env::var(variavel).ok().and_then(|valor| valor.parse().ok()).unwrap_or(padrao)
    }

    /// As duas, na ordem em que o app sobe (o host primeiro).
    pub fn todas() -> [Papel; 2] {
        [Papel::Host, Papel::Backend]
    }
}

/// Decisão do vigia para um serviço que está fora do ar.
#[derive(Debug, PartialEq, Eq)]
pub enum Decisao {
    /// Hora de tentar subir de novo.
    Subir,
    /// Ainda é cedo: esperar mais.
    Esperar,
    /// Já tentamos demais — insistir, mas **devagar** (ver `ESPERA_DESISTIDO`).
    Devagar,
}

/// Quanto esperar, já tendo tentado `tentativa` vezes, antes da próxima.
///
/// A primeira é imediata (acabamos de notar que o serviço caiu) e as seguintes crescem de
/// propósito: um serviço que morre por cota ou por porta ocupada volta rápido, e um que
/// morre por estar quebrado não merece uma tentativa a cada dois segundos para sempre.
pub fn espera_da_tentativa(tentativa: u32) -> Duration {
    match tentativa {
        0 => Duration::ZERO,
        1 => Duration::from_secs(1),
        2 => Duration::from_secs(5),
        3 => Duration::from_secs(15),
        _ => Duration::from_secs(30),
    }
}

/// A conta do vigia, sem relógio: `ja_tentou` tentativas e `decorrido` desde a última.
///
/// Separada de `Servicos::pode_subir` porque assim dá para testá-la sem dormir.
pub fn decidir(ja_tentou: u32, decorrido: Duration) -> Decisao {
    if ja_tentou >= TENTATIVAS_MAX {
        // As tentativas rápidas acabaram, mas **desistir de vez** era o defeito: serviço que
        // caiu por motivo passageiro (antivírus, rede, painel fora do ar) deixava a sessão
        // inteira sem modelos até alguém reabrir o app. Agora insiste de cinco em cinco
        // minutos — devagar, e para sempre.
        return if decorrido >= ESPERA_DESISTIDO {
            Decisao::Devagar
        } else {
            Decisao::Esperar
        };
    }
    if decorrido < espera_da_tentativa(ja_tentou) {
        return Decisao::Esperar;
    }
    Decisao::Subir
}

/// Processo que **este app** abriu.
struct Crianca {
    papel: Papel,
    /// Guardado à parte: depois de colher o filho o `Child` não responde mais o id.
    pid: u32,
    filho: Child,
}

/// O que já tentamos por um serviço que caiu.
struct Queda {
    tentativas: u32,
    ultima: Instant,
    avisou: bool,
}

/// As peças do app: quem foi aberto, quem o app mantém de pé e quem morre com ele.
pub struct Servicos {
    /// A job object do Windows: tudo que entra nela é derrubado quando este processo sai.
    job: Option<job::Job>,
    criancas: Mutex<Vec<Crianca>>,
    /// Papéis que o app reergue sozinho — só os que ele mesmo subiu.
    cuidados: Mutex<Vec<Papel>>,
    quedas: Mutex<HashMap<Papel, Queda>>,
    /// A partir daqui nada mais sobe: o app está fechando.
    parando: AtomicBool,
}

impl Servicos {
    pub fn novo() -> Servicos {
        let job = job::Job::novo();
        log(if job.is_some() {
            "job object armado: os serviços morrem junto com o app, mesmo em saída forçada"
        } else {
            "sem job object: os serviços só são encerrados na saída normal do app"
        });
        Servicos {
            job,
            criancas: Mutex::new(Vec::new()),
            cuidados: Mutex::new(Vec::new()),
            quedas: Mutex::new(HashMap::new()),
            parando: AtomicBool::new(false),
        }
    }

    /// O app está fechando?
    pub fn parando(&self) -> bool {
        self.parando.load(Ordering::SeqCst)
    }

    /// Marca que o app está fechando — o vigia para e nada mais sobe.
    pub fn parar(&self) {
        self.parando.store(true, Ordering::SeqCst);
    }

    /// O job object está armado? (A prova de que uma saída forçada também leva os serviços.)
    #[cfg(test)]
    pub fn protegido(&self) -> bool {
        self.job.is_some()
    }

    /// Guarda o filho que acabamos de abrir e o põe sob o job object.
    pub fn guardar(&self, papel: Papel, filho: Child) {
        let pid = filho.id();
        if let Some(job) = &self.job {
            if !job.incluir(&filho) {
                log(&format!(
                    "não consegui pôr o {} (pid {pid}) no job object — ele só morre na saída normal",
                    papel.nome()
                ));
            }
        }
        // O log da abertura não diz "no ar" de propósito: o `spawn` deu certo, a porta é
        // que confirma (o chamador loga isso quando ela responde).
        log(&format!("{} iniciado (pid {pid})", papel.nome()));
        self.criancas
            .lock()
            .expect("lock dos filhos")
            .push(Crianca { papel, pid, filho });
    }

    /// Quantos filhos deste papel continuam vivos (colhendo no caminho os que já saíram).
    pub fn quantos_vivos(&self, papel: Papel) -> usize {
        let mut criancas = self.criancas.lock().expect("lock dos filhos");
        criancas.retain_mut(|crianca| match crianca.filho.try_wait() {
            Ok(None) => true,
            Ok(Some(estado)) => {
                log(&format!(
                    "{} (pid {}) saiu por conta própria: {estado}",
                    crianca.papel.nome(),
                    crianca.pid
                ));
                false
            }
            Err(erro) => {
                log(&format!("não consegui falar com o pid {}: {erro}", crianca.pid));
                false
            }
        });
        criancas.iter().filter(|crianca| crianca.papel == papel).count()
    }

    /// O app passa a manter este serviço de pé (reerguer se cair).
    ///
    /// Só vale para o que o app abriu: um backend de desenvolvimento é do desenvolvedor, e
    /// ressuscitá-lo por cima do dele seria brigar pela porta.
    pub fn cuidar_de(&self, papel: Papel) {
        let mut cuidados = self.cuidados.lock().expect("lock dos cuidados");
        if !cuidados.contains(&papel) {
            cuidados.push(papel);
        }
    }

    /// O app mantém este serviço de pé?
    pub fn cuidado(&self, papel: Papel) -> bool {
        self.cuidados.lock().expect("lock dos cuidados").contains(&papel)
    }

    /// A porta respondeu: zera o contador de quedas deste papel.
    pub fn anotar_ok(&self, papel: Papel) {
        if self.quedas.lock().expect("lock das quedas").remove(&papel).is_some() {
            log(&format!("{} de volta ao ar", papel.nome()));
        }
    }

    /// Já passou a hora de tentar subir este serviço de novo?
    ///
    /// Conta a tentativa quando a resposta é `true` — quem chama é quem sobe.
    pub fn pode_subir(&self, papel: Papel) -> bool {
        if self.parando() {
            return false;
        }
        let mut quedas = self.quedas.lock().expect("lock das quedas");
        let queda = quedas.entry(papel).or_insert(Queda {
            tentativas: 0,
            ultima: Instant::now(),
            avisou: false,
        });
        match decidir(queda.tentativas, queda.ultima.elapsed()) {
            Decisao::Subir => {
                queda.tentativas += 1;
                queda.ultima = Instant::now();
                true
            }
            Decisao::Esperar => false,
            Decisao::Devagar => {
                if !queda.avisou {
                    queda.avisou = true;
                    log(&format!(
                        "{} caiu {TENTATIVAS_MAX} vezes seguidas — passando a insistir de 5 em 5 minutos",
                        papel.nome()
                    ));
                }
                // Sobe igual: o que muda é a cadência, não a desistência.
                queda.tentativas += 1;
                queda.ultima = Instant::now();
                true
            }
        }
    }

    /// Encerra tudo que o app abriu. Repetir a chamada é inofensivo: a lista fica vazia.
    pub fn encerrar_todos(&self) {
        self.parar();
        let mut criancas = self.criancas.lock().expect("lock dos filhos");
        // Ordem inversa: a API morre antes do host que a atende.
        for crianca in criancas.iter_mut().rev() {
            let _ = crianca.filho.kill();
            // Colher o filho: sem isto o processo pode continuar vivo até o SO reaproveitar
            // o pid (o `kill` já pediu o término, mas não espera).
            let _ = crianca.filho.wait();
            log(&format!("{} (pid {}) encerrado", crianca.papel.nome(), crianca.pid));
        }
        criancas.clear();
    }
}

/// A job object do Windows: o que entra nela morre quando o último handle dela fecha.
#[cfg(windows)]
mod job {
    use std::os::windows::io::AsRawHandle;
    use std::process::Child;

    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };


    pub struct Job(HANDLE);

    // O handle é um número do kernel: pode ser usado de qualquer thread (o app só o guarda
    // e o usa para pôr processos dentro do job).
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}

    impl Job {
        /// Cria o job já com `KILL_ON_JOB_CLOSE`.
        ///
        /// O handle mora nesta struct: quando o processo do Koda termina — saída normal,
        /// travada ou `TerminateProcess` —, o Windows fecha o handle por conta própria e
        /// derruba todos os processos do job. É o único mecanismo que sobrevive a uma
        /// morte que não passa pelo código do app.
        pub fn novo() -> Option<Job> {
            unsafe {
                let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if job.is_null() {
                    return None;
                }
                let mut limite: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                limite.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                let ok = SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    &limite as *const _ as *const core::ffi::c_void,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                );
                if ok == 0 {
                    CloseHandle(job);
                    return None;
                }
                Some(Job(job))
            }
        }

        /// Põe o processo dentro do job (vale também para os filhos que ele abrir depois).
        pub fn incluir(&self, filho: &Child) -> bool {
            unsafe { AssignProcessToJobObject(self.0, filho.as_raw_handle() as HANDLE) != 0 }
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

/// Fora do Windows não existe job object: resta o encerramento explícito na saída.
#[cfg(not(windows))]
mod job {
    use std::process::Child;

    pub struct Job;

    impl Job {
        pub fn novo() -> Option<Job> {
            None
        }

        pub fn incluir(&self, _filho: &Child) -> bool {
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_espera_cresce_a_cada_tentativa() {
        let esperas: Vec<Duration> = (1..=4).map(espera_da_tentativa).collect();
        assert!(esperas.windows(2).all(|par| par[0] <= par[1]), "{esperas:?}");
        assert_eq!(esperas[0], Duration::from_secs(1));
        assert!(esperas[3] >= Duration::from_secs(30));
    }

    #[test]
    fn o_vigia_sobe_na_hora_espera_e_depois_insiste_devagar() {
        // Primeira vez: sobe na hora.
        assert_eq!(decidir(0, Duration::ZERO), Decisao::Subir);
        // Logo depois de uma tentativa: cedo demais.
        assert_eq!(decidir(1, Duration::ZERO), Decisao::Esperar);
        assert_eq!(decidir(1, Duration::from_millis(999)), Decisao::Esperar);
        assert_eq!(decidir(1, Duration::from_secs(1)), Decisao::Subir);
        // Cada tentativa espera mais que a anterior.
        assert_eq!(decidir(2, Duration::from_secs(4)), Decisao::Esperar);
        assert_eq!(decidir(2, Duration::from_secs(5)), Decisao::Subir);
        // Passado o limite, o ritmo cai para cinco minutos — mas **nunca** para de tentar:
        // desistir de vez deixava a sessão sem modelos até reabrir o app.
        assert_eq!(decidir(TENTATIVAS_MAX, Duration::from_secs(299)), Decisao::Esperar);
        assert_eq!(decidir(TENTATIVAS_MAX, Duration::from_secs(300)), Decisao::Devagar);
        assert_eq!(decidir(TENTATIVAS_MAX + 20, Duration::from_secs(3600)), Decisao::Devagar);
    }

    #[test]
    fn quem_nunca_foi_cuidado_nao_e_ressuscitado() {
        let servicos = Servicos::novo();
        assert!(!servicos.cuidado(Papel::Backend));
        servicos.cuidar_de(Papel::Backend);
        assert!(servicos.cuidado(Papel::Backend));
        assert!(!servicos.cuidado(Papel::Host));
    }

    #[test]
    fn a_primeira_tentativa_e_imediata_e_o_encerramento_trava_o_vigia() {
        let servicos = Servicos::novo();
        assert!(servicos.pode_subir(Papel::Host));
        // A segunda, logo em seguida, tem que esperar.
        assert!(!servicos.pode_subir(Papel::Host));
        servicos.parar();
        assert!(servicos.parando());
        assert!(!servicos.pode_subir(Papel::Host));
    }

    #[test]
    fn sem_queda_registrada_nao_ha_o_que_anotar() {
        let servicos = Servicos::novo();
        servicos.pode_subir(Papel::Host);
        // Volta ao ar: o contador some, e a próxima tentativa é imediata de novo.
        servicos.anotar_ok(Papel::Host);
        assert!(servicos.pode_subir(Papel::Host));
    }

    /// Perguntas de verdade ao sistema: processos de verdade, job de verdade.
    #[cfg(windows)]
    mod de_verdade {
        use super::*;
        use std::process::{Command, Stdio};

        /// Um processo que fica vivo por um bom tempo, sem janela.
        fn processo_longo() -> Child {
            Command::new("cmd")
                .args(["/C", "ping", "-n", "60", "127.0.0.1"])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .stdin(Stdio::null())
                .spawn()
                .expect("processo de teste")
        }

        fn esperar_sair(filho: &mut Child, segundos: u64) -> bool {
            let prazo = Instant::now() + Duration::from_secs(segundos);
            while Instant::now() < prazo {
                if matches!(filho.try_wait(), Ok(Some(_))) {
                    return true;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            false
        }

        #[test]
        fn o_job_object_esta_armado() {
            // Sem ele, uma saída forçada deixa o cliente com serviços órfãos.
            assert!(Servicos::novo().protegido());
        }

        #[test]
        fn fechar_o_job_derruba_quem_estava_dentro() {
            // É exatamente o que o Windows faz quando o Koda termina: o handle do job fecha.
            let job = job::Job::novo().expect("job object");
            let mut filho = processo_longo();
            assert!(job.incluir(&filho), "o filho entrou no job");
            drop(job);
            if !esperar_sair(&mut filho, 5) {
                let _ = filho.kill();
                panic!("o filho continuou vivo depois de fechar o job");
            }
        }

        #[test]
        fn encerrar_todos_mata_o_que_esta_rodando() {
            let servicos = Servicos::novo();
            let filho = processo_longo();
            let pid = filho.id();
            servicos.guardar(Papel::Backend, filho);
            assert_eq!(servicos.quantos_vivos(Papel::Backend), 1);
            assert_eq!(servicos.quantos_vivos(Papel::Host), 0);

            servicos.encerrar_todos();

            assert!(servicos.parando());
            assert_eq!(servicos.quantos_vivos(Papel::Backend), 0);
            assert!(!portas_do_teste::vivo(pid));
        }

        #[test]
        fn filho_que_sai_sozinho_sai_da_lista() {
            let servicos = Servicos::novo();
            let filho = Command::new("cmd")
                .args(["/C", "exit"])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .expect("processo de teste");
            servicos.guardar(Papel::Host, filho);
            std::thread::sleep(Duration::from_millis(700));
            assert_eq!(servicos.quantos_vivos(Papel::Host), 0);
        }

        /// Consulta ao sistema se o pid ainda existe (o `tasklist` responde só o que existe).
        mod portas_do_teste {
            pub fn vivo(pid: u32) -> bool {
                let filtro = format!("PID eq {pid}");
                std::process::Command::new("tasklist")
                    .args(["/FI", &filtro, "/FO", "CSV", "/NH"])
                    .output()
                    .map(|saida| String::from_utf8_lossy(&saida.stdout).to_ascii_lowercase().contains(".exe"))
                    .unwrap_or(true)
            }
        }
    }
}
