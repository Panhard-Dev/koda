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
