; Ganchos do instalador do Koda.
;
; O Koda não é só a janela: a conversa roda num serviço local em Python, e esse serviço vai
; **dentro** do instalador — o interpretador (Python 3.13) e as bibliotecas dele, montados
; por `scripts/gerar-runtime-backend.mjs` a partir do `backend/.venv`. A máquina de destino
; não precisa de Python, nem de `uv`, nem de nada instalado à parte.
;
; Os dois servidores do Painel Dev (`navegador` e `logs`) são programas **Node**, e vão junto
; pelo mesmo motivo — `scripts/gerar-runtime-node.mjs` põe o `node.exe` em `resources/node/`,
; e o `mcps.json` continua dizendo `"command": "node"` porque o gerenciador troca esse nome
; pelo Node que veio com o app. Sem isso o Painel Dev nasceria sem ferramenta nenhuma na
; máquina de quem não tem Node — e o instalador dizia que não era preciso instalar mais nada.
;
; A única dependência que sobra é o **navegador**: o Painel Dev abre o Chrome ou o Edge que
; já existe na máquina (nada é baixado, `mcp/dev-browser/server.mjs`). É por isso que o aviso
; aqui fala dele como recurso, e não como requisito do app.
;
; Isso não estava dito em lugar nenhum, e o silêncio virou dúvida: quem instala num PC novo
; não sabe se falta instalar o Python, e quando o serviço não sobe sobra a impressão de que
; era isso que faltava. Por isso o aviso aqui, no fim da instalação — e o mesmo assunto
; aparece em Ajustes › Sobre › Serviço local, que mostra o interpretador empacotado e o log
; dele.
;
; Sem BOM de propósito, como o `PortugueseBR.nsh`: o Tauri acrescenta o dele ao copiar o
; arquivo para a pasta de build, e dois BOMs seguidos fazem o makensis abortar.
;
; Os nomes das macros são os que o template do Tauri procura (`NSIS_HOOK_POSTINSTALL`).
; Trocar qualquer um deles faz o gancho deixar de rodar sem erro nenhum de compilação.

!macro NSIS_HOOK_POSTINSTALL
  ; No painel de detalhes, para quem instala em silêncio e para o log do instalador.
  DetailPrint "Runtime do serviço local instalado: Python 3.13 + dependências e Node (nada a instalar à parte)."

  ; ---------------------------------------------------------------------------
  ; A quarentena do antivírus — resolvida aqui, e não com um aviso.
  ;
  ; O `c-host.exe` é um binário de Go ofuscado e sem assinatura digital. Em algumas
  ; máquinas o Windows Defender o classifica como ameaça **na hora de executar** e apaga o
  ; arquivo: o log do app mostra `ERROR_VIRUS_INFECTED (os error 225)` e, logo depois,
  ; "c-host.exe ausente". A partir daí não há o que reerguer — o Koda fica sem modelos
  ; oficiais para sempre, e reinstalar só faz o antivírus comer o arquivo de novo.
  ;
  ; Não há como o app impedir isso mexendo no próprio processo: quem decide é o antivírus.
  ; O que o app pode fazer é **pedir ao Windows, uma vez, para não verificar aquele
  ; arquivo** — e é exatamente isto: uma exclusão de pasta, do mesmo jeito que a tela do
  ; Defender oferece (Segurança do Windows › Proteção contra vírus e ameaças › Exclusões).
  ;
  ; Exclui a pasta `host` inteira, e não só o executável: ela não tem mais nada dentro, e
  ; assim a exclusão sobrevive a uma troca de nome do binário numa versão futura.
  ;
  ; Exclusão no Defender é decisão de máquina e exige administrador: daí o `runas`, que
  ; abre o UAC. Recusou? A instalação segue normalmente — o host continua sujeito ao
  ; antivírus, e o app diz no log o que aconteceu.
  ;
  ; Em instalação silenciosa o passo é pulado de propósito: o UAC não pode aparecer no meio
  ; de uma atualização automática, que é onde o instalador roda com `/S`. Quem instalou
  ; olhando a tela já tem a exclusão; quem instalou em silêncio fica com o comportamento
  ; antigo (e o log do app explica).
  IfSilent koda_exclusao_fim
  DetailPrint "Pedindo ao Windows para não verificar o serviço de modelos (evita a quarentena do antivírus)…"
  ExecShellWait "runas" "powershell.exe" \
    "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -Command $\"try { Add-MpPreference -ExclusionPath '$INSTDIR\host' -ErrorAction Stop } catch { }$\""
  koda_exclusao_fim:

  ; Os modelos oficiais dependem deste binário proprietário. O instalador já o empacota
  ; como recurso; confira o arquivo instalado para detectar remoção por antivírus ou pacote
  ; incompleto ainda durante a instalação, em vez de deixar o usuário descobrir no chat.
  IfFileExists "$INSTDIR\host\c-host.exe" koda_host_presente
  DetailPrint "AVISO: c-host.exe não está em $INSTDIR\host\c-host.exe."
  IfSilent koda_aviso_host_fim
  MessageBox MB_OK|MB_ICONEXCLAMATION \
    "O serviço de modelos não foi encontrado em $INSTDIR\host\c-host.exe.$\r$\n\
    O Koda ficará sem os modelos oficiais. Verifique se o antivírus colocou c-host.exe em quarentena e reinstale o Koda depois de restaurá-lo."
  Goto koda_aviso_host_fim

  koda_host_presente:
    DetailPrint "Serviço de modelos instalado: host\c-host.exe."
  koda_aviso_host_fim:

  ; O Painel Dev abre um navegador que **já existe** na máquina: nada é baixado. É a única
  ; coisa de fora que o Koda usa, e é de um recurso só — por isso a checagem é sobre ele, e o
  ; aviso diz o que fazer, em vez de dar o app inteiro como incompleto.
  ;
  ; `$0` é registrador temporário: nenhuma instrução abaixo depende do valor anterior dele.
  StrCpy $0 "O Painel Dev abre o Chrome ou o Edge que já existe nesta máquina, e não encontrei nenhum dos dois. O Painel Dev fica sem a aba de navegador; o resto do Koda funciona igual. Instale um deles para usar esse recurso.$\r$\n$\r$\n"
  IfFileExists "$PROGRAMFILES\Google\Chrome\Application\chrome.exe" koda_tem_navegador
  IfFileExists "$PROGRAMFILES32\Google\Chrome\Application\chrome.exe" koda_tem_navegador
  IfFileExists "$LOCALAPPDATA\Google\Chrome\Application\chrome.exe" koda_tem_navegador
  IfFileExists "$PROGRAMFILES\Microsoft\Edge\Application\msedge.exe" koda_tem_navegador
  IfFileExists "$PROGRAMFILES32\Microsoft\Edge\Application\msedge.exe" koda_tem_navegador
  Goto koda_aviso_python_caixa
  koda_tem_navegador:
    StrCpy $0 ""
  koda_aviso_python_caixa:

  ; Caixa de aviso: só quando alguém está olhando a tela (instalação silenciosa não para).
  IfSilent koda_aviso_python_fim

  MessageBox MB_OK|MB_ICONINFORMATION \
    "O Koda já traz o Python e o Node que ele precisa.$\r$\n\
    $\r$\n\
    O serviço local (a parte em Python que conversa com os modelos) e os servidores do Painel Dev foram instalados junto com o app, com os interpretadores deles. Você não precisa instalar Python nem Node.$\r$\n\
    $\r$\n\
    $0Se a conversa não responder, abra Ajustes > Sobre > Serviço local e clique em «Ver diagnóstico»: ali aparecem o estado do serviço e o log dele."

  koda_aviso_python_fim:
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; Os runtimes (o Python, com dezenas de MB de bibliotecas, e o Node) saem junto com o app;
  ; só o banco e as conversas ficam em `%APPDATA%\app.koda.desktop`, que o desinstalador
  ; pergunta se quer apagar.
  DetailPrint "Removendo o app e os runtimes do serviço local (Python e Node)."
!macroend
