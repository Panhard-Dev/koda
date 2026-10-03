; Ganchos do instalador do Koda.
;
; O Koda não é só a janela: a conversa roda num serviço local em Python, e esse serviço vai
; **dentro** do instalador — o interpretador (Python 3.13) e as bibliotecas dele, montados
; por `scripts/gerar-runtime-backend.mjs` a partir do `backend/.venv`. A máquina de destino
; não precisa de Python, nem de `uv`, nem de nada instalado à parte.
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
  DetailPrint "Runtime do serviço local instalado: Python 3.13 + dependências (nada a instalar à parte)."

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

  ; Caixa de aviso: só quando alguém está olhando a tela (instalação silenciosa não para).
  IfSilent koda_aviso_python_fim

  MessageBox MB_OK|MB_ICONINFORMATION \
    "O Koda já traz o Python que ele precisa.$\r$\n\
    $\r$\n\
    O serviço local (a parte em Python que conversa com os modelos) foi instalado junto com o app, com o próprio interpretador e as bibliotecas dele. Você não precisa instalar Python nem nenhum outro programa.$\r$\n\
    $\r$\n\
    Se a conversa não responder, abra Ajustes > Sobre > Serviço local e clique em «Ver diagnóstico»: ali aparecem o estado do serviço e o log dele."

  koda_aviso_python_fim:
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; O runtime do Python (dezenas de MB de bibliotecas) sai junto com o app; só o banco e as
  ; conversas ficam em `%APPDATA%\app.koda.desktop`, que o desinstalador pergunta se quer
  ; apagar.
  DetailPrint "Removendo o app e o runtime do serviço local (Python)."
!macroend
