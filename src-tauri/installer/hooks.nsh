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

; Atualize este número junto com host/c-host.exe. O build confere a igualdade.
!define KODA_HOST_BYTES 8113664

!macro NSIS_HOOK_PREINSTALL
  ; ---------------------------------------------------------------------------
  ; O Koda aberto segura os arquivos da instalação anterior.
  ;
  ; Sem isso, quem atualiza por cima da versão velha vê "NSIS Error — Error
  ; launching installer" e mais nada: o instalador não consegue substituir o que
  ; está em uso e aborta antes de explicar. A pessoa não tem como saber que bastava
  ; fechar o programa — e algumas desinstalam na mão, o que não devia ser
  ; necessário para atualizar.
  ;
  ; Fecha a árvore inteira com /T: o `koda.exe` é pai do serviço local em Python e
  ; do `c-host.exe`, então matar a árvore encerra os três de uma vez. Nada se
  ; perde — conversas, banco e `mcps.json` ficam em
  ; %APPDATA%\app.koda.desktop\data, que o instalador não substitui.
  ;
  ; Só age se havia instalação anterior: em máquina limpa não há o que fechar.
  ${If} ${FileExists} "$INSTDIR\${MAINBINARYNAME}.exe"
    ; Um exe com atributo somente-leitura dá **a mesma** caixa — «Erro ao abrir o
    ; arquivo para gravação» — sem que o programa esteja aberto. Tirar o atributo
    ; custa uma linha e elimina a causa antes de culpar o processo.
    SetFileAttributes "$INSTDIR\${MAINBINARYNAME}.exe" NORMAL
    SetFileAttributes "$INSTDIR\uninstall.exe" NORMAL

    DetailPrint "Fechando o Koda que está aberto (para atualizar sem erro)…"

    ; ---------------------------------------------------------------------------
    ; Fechar não é o mesmo que estar fechado.
    ;
    ; Aqui havia `taskkill` + `Sleep 1000` e a esperança de que o Windows soltasse o
    ; arquivo nesse segundo. Não solta sempre, e o resultado era a caixa «Erro ao
    ; abrir o arquivo para gravação» apontando para C:\...\Koda\koda.exe — sem uma
    ; palavra sobre o programa estar aberto. Quem escolhia «Ignorar» ficava com a
    ; instalação pela metade: recursos novos e binário velho, que é pior do que não
    ; instalar.
    ;
    ; Duas coisas mudaram aqui.
    ;
    ; A primeira é **como** o app é encerrado. O `taskkill` saiu do lugar de honra:
    ; ele abre um console, pode ser negado e — o que mais dói — era chamado por
    ; `nsExec::ExecToLog`, que escreve na janela de log do instalador. Em instalação
    ; silenciosa essa janela não existe, e o comando não rodava: o app continuava
    ; aberto segurando o arquivo enquanto o instalador achava que tinha feito a
    ; parte dele. Agora quem encerra é o plugin nativo do Tauri
    ; (`KillProcessCurrentUser`), que não depende de console nem de janela. Os
    ; filhos — o serviço em Python e o host — caem junto pelo job object que o app
    ; arma na subida.
    ;
    ; A segunda é que o laço **pergunta ao próprio arquivo** se já dá para gravar
    ; (abrir para escrita é o teste, e nada é escrito nele) em vez de supor que o
    ; processo morreu só porque o encerramento voltou.
    StrCpy $R7 0   ; já mostrou a caixa pedindo para fechar o Koda?
    StrCpy $R8 0   ; tentativas do laço atual

    nsis_tauri_utils::KillProcessCurrentUser "${MAINBINARYNAME}.exe"
    Pop $R9

    koda_fechar_laco:
      ; O `c-host.exe` de uma execução órfã (o job object morre com o app; um app que
      ; já morreu não leva o host junto) segura o próprio binário em `host\`. O
      ; `ExecToStack` — e não `ExecToLog` — funciona em qualquer modo de instalação.
      nsExec::ExecToStack 'taskkill /F /IM c-host.exe /T'
      Pop $0
      Pop $0
      ; os handles do Windows demoram um instante para soltar depois do processo morrer
      Sleep 300

      ClearErrors
      FileOpen $1 "$INSTDIR\${MAINBINARYNAME}.exe" a
      ${IfNot} ${Errors}
        FileClose $1
        Goto koda_exe_liberado
      ${EndIf}

      ; ainda travado: insiste no encerramento antes da próxima tentativa
      nsis_tauri_utils::KillProcessCurrentUser "${MAINBINARYNAME}.exe"
      Pop $R9

      IntOp $R8 $R8 + 1
      ${If} $R8 < 12
        Goto koda_fechar_laco
      ${EndIf}

      ; Segunda rodada, com a pessoa no circuito: o encerramento pode ser negado (o app
      ; aberto por outro usuário, uma política da máquina), e aí não há laço que
      ; resolva — só fechar o programa na mão. Instalação silenciosa e passiva não
      ; param numa caixa: seguem para o plano B, que não precisa de ninguém.
      ${If} $R7 == 0
        StrCpy $R7 1
        IfSilent koda_tentar_renomear
        ${If} $PassiveMode == 1
          Goto koda_tentar_renomear
        ${EndIf}
        MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION \
          "O instalador não conseguiu substituir o Koda porque o programa ainda está em uso.$\r$\n\
          $\r$\n\
          Feche o Koda — inclusive o ícone ao lado do relógio — e clique em Repetir." \
          IDRETRY koda_repetir
        Abort
        koda_repetir:
          StrCpy $R8 0
          Goto koda_fechar_laco
      ${EndIf}

    ; ---------------------------------------------------------------------------
    ; Plano B, e ele existe porque o Windows **permite renomear um executável em
    ; uso**: a imagem é carregada com FILE_SHARE_DELETE. O arquivo travado sai do
    ; caminho sem precisar morrer; o `koda.exe` novo entra no lugar dele e o velho
    ; é apagado no próximo boot. Sem isto, o `File` falhava aqui e a instalação
    ; ficava pela metade.
    koda_tentar_renomear:
      DetailPrint "O koda.exe antigo não soltou o arquivo: renomeando para trocar na próxima reinicialização."
      Delete "$INSTDIR\${MAINBINARYNAME}.exe.velho"
      ClearErrors
      Rename "$INSTDIR\${MAINBINARYNAME}.exe" "$INSTDIR\${MAINBINARYNAME}.exe.velho"
      ${If} ${Errors}
        ; Nem matar, nem renomear: aqui não há saída silenciosa. Melhor parar e dizer
        ; o que fazer do que deixar recursos novos em cima de um binário velho.
        IfSilent koda_exe_travado_fim
        MessageBox MB_ICONSTOP|MB_OK \
          "O Koda está aberto e o Windows não deixou o instalador substituir o programa.$\r$\n\
          $\r$\n\
          Feche o Koda — inclusive o ícone ao lado do relógio — e rode este instalador de novo."
        koda_exe_travado_fim:
        Abort
      ${EndIf}
      Delete /REBOOTOK "$INSTDIR\${MAINBINARYNAME}.exe.velho"
      ; Se ele ainda está rodando — que é o motivo do rename — encerra agora que o
      ; caminho novo está livre: sem isto sobrariam duas janelas do Koda na tela.
      nsis_tauri_utils::KillProcessCurrentUser "${MAINBINARYNAME}.exe"
      Pop $R9

    koda_exe_liberado:

    ; O app pode ter fechado e o host antigo continuar preso. Se o host não estiver
    ; gravável, abortar antes de extrair impede uma instalação com frontend novo e
    ; serviço de modelos velho, que se parece com uma falha aleatória de 429.
    ${If} ${FileExists} "$INSTDIR\host\c-host.exe"
      ClearErrors
      FileOpen $R6 "$INSTDIR\host\c-host.exe" a
      ${If} ${Errors}
        MessageBox MB_ICONSTOP|MB_OK \
          "O c-host.exe antigo ainda está em uso. Feche o Koda e execute a atualização de novo."
        Abort
      ${EndIf}
      FileClose $R6
    ${EndIf}

    ; O perfil WebView2 em %LOCALAPPDATA%\app.koda.desktop contém também Local Storage:
    ; é ali que a sessão da conta e o token de renovação sobrevivem à reabertura.
    ; Uma atualização troca os arquivos em $INSTDIR e preserva o perfil inteiro.
    ; Apagar esse diretório aqui obrigava a entrar na conta em toda versão nova.
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; Confere o arquivo realmente instalado, não apenas a linha File do script NSIS.
  ; Se uma atualização preservar o host antigo, não declarar sucesso.
  ClearErrors
  FileOpen $R6 "$INSTDIR\host\c-host.exe" r
  ${If} ${Errors}
    MessageBox MB_ICONSTOP|MB_OK "O serviço de modelos não foi instalado. Execute a instalação de novo."
    Abort
  ${EndIf}
  FileSeek $R6 0 END $R5
  FileClose $R6
  ${If} $R5 != ${KODA_HOST_BYTES}
    MessageBox MB_ICONSTOP|MB_OK "O serviço de modelos ficou com uma versão antiga. Execute a instalação de novo."
    Abort
  ${EndIf}
  ; ---------------------------------------------------------------------------
  ; Python e Node no sistema, só o que precisar.
  ;
  ; O instalador JÁ carrega os dois: `backend\python` (interpretador + dependências)
  ; e `node`. O app instalado não depende de nada externo, e é assim que tem que
  ; continuar sendo — nada aqui é pré-requisito, e esta seção não vira exigência.
  ;
  ; Ela existe para a máquina em que o runtime portátil falha (política de
  ; execução estranha, DLL barrada, Windows com imagem modificada). A regra é:
  ;
  ;   não tem .......... instala
  ;   tem, versão velha . atualiza
  ;   tem, versão atual . não faz nada, e não baixa nada
  ;
  ; A checagem é rodar o próprio binário (`python --version`, `node --version`) e
  ; olhar o código de saída, e não `where`: no PATH do Windows vive o apelido da
  ; Microsoft Store, que o `where` acha mas que não executa Python nenhum.
  ;
  ; `winget install` só age quando falta. `winget upgrade` só age quando o
  ; manifesto tem versão mais nova — no-op quando já está em ordem. Por isso os
  ; dois comandos cobrem os três casos sem precisar comparar versão, que em NSIS
  ; daria mais trabalho que esta seção inteira.
  ;
  ; winget pode não existir (Windows antigo), pode estar sem rede e pode pedir UAC.
  ; Nada disso derruba a instalação: cada tentativa é só uma tentativa, e o
  ; instalador segue com o runtime que já trouxe. Também desaparece em instalação
  ; silenciosa, porque o UAC no meio de uma atualização automática trava o
  ; processo.
  IfSilent koda_winget_fim

  nsExec::ExecToStack 'python --version'
  Pop $0
  Pop $1
  ${If} $0 != 0
    DetailPrint "Python não responde nesta máquina: instalando."
    nsExec::ExecToLog 'winget install --id Python.Python.3.13 -e --silent --scope user --accept-package-agreements --accept-source-agreements'
    Pop $0
  ${Else}
    DetailPrint "Python já funciona aqui ($1)."
  ${EndIf}

  nsExec::ExecToStack 'node --version'
  Pop $0
  Pop $1
  ${If} $0 != 0
    DetailPrint "Node não responde nesta máquina: instalando."
    nsExec::ExecToLog 'winget install --id OpenJS.NodeJS.LTS -e --silent --scope user --accept-package-agreements --accept-source-agreements'
    Pop $0
  ${Else}
    DetailPrint "Node já funciona aqui ($1)."
  ${EndIf}

  ; Quem tem versão velha é problema do upgrade, não do install. Já está na
  ; versão do manifesto? Não faz nada, e não baixa nada.
  DetailPrint "Atualizando Python e Node se estiverem defasados…"
  nsExec::ExecToLog 'winget upgrade --id Python.Python.3.13 -e --silent --scope user --accept-package-agreements --accept-source-agreements'
  Pop $0
  nsExec::ExecToLog 'winget upgrade --id OpenJS.NodeJS.LTS -e --silent --scope user --accept-package-agreements --accept-source-agreements'
  Pop $0

  koda_winget_fim:

  ; No painel de detalhes, para quem instala em silêncio e para o log do instalador.
  DetailPrint "Runtime do serviço local instalado: Python 3.13 + dependências e Node (nada a instalar à parte)."

  ; ---------------------------------------------------------------------------
  ; Sem toque no antivírus, de propósito.
  ;
  ; Aqui havia uma exclusão de pasta no Defender — `Add-MpPreference
  ; -ExclusionPath '$INSTDIR\host'` — disparada por um PowerShell elevado. Foi
  ; retirada por dois motivos.
  ;
  ; O primeiro é o que o dono pediu: aquilo abria UAC e um shell na cara de quem
  ; estava instalando, e instalador que faz isso sem aviso parecia defeito.
  ;
  ; O segundo é mais sério. Instalador per-user que escala privilégio e desliga a
  ; verificação de antivírus numa pasta é assinatura de malware — é o padrão que
  ; os motores de heurística procuram justamente. Além de abrir uma janela na tela,
  ; aquele passo trabalhava contra o Koda: ele podia ser parte do motivo de o
  ; instalador ser olhado com desconfiança.
  ;
  ; O `c-host.exe` de hoje é build limpo, e não precisa de muleta: compilado sem
  ; ofuscação, com o registro selado (nada de provedor, relay ou modelo em claro),
  ; verificado contra vazamento e varrido pelo Defender sem acusação. Se numa
  ; máquina específica ele for quarentenado, o aviso abaixo avisa na hora — e o
  ; conserto ali é o usuário restaurar o arquivo, não o instalador se meter na
  ; configuração de segurança da máquina dele.

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

  ; ---------------------------------------------------------------------------
  ; Sobra do PREINSTALL: quando o `koda.exe` antigo não soltou o arquivo, ele foi
  ; renomeado para `koda.exe.velho` para o novo entrar no lugar. Agora que a
  ; instalação acabou, tenta apagar; se o processo velho ainda estiver rodando, o
  ; Windows só aceita a remoção no próximo boot.
  Delete "$INSTDIR\${MAINBINARYNAME}.exe.velho"
  Delete /REBOOTOK "$INSTDIR\${MAINBINARYNAME}.exe.velho"
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; Os runtimes (o Python, com dezenas de MB de bibliotecas, e o Node) saem junto com o app;
  ; só o banco e as conversas ficam em `%APPDATA%\app.koda.desktop`, que o desinstalador
  ; pergunta se quer apagar.
  DetailPrint "Removendo o app e os runtimes do serviço local (Python e Node)."

  ; Resto de uma atualização em que o binário velho não pôde ser apagado na hora: sem
  ; esta linha ele fica sozinho em $INSTDIR e o `RMDir` do fim não consegue remover a pasta.
  Delete "$INSTDIR\${MAINBINARYNAME}.exe.velho"
  Delete /REBOOTOK "$INSTDIR\${MAINBINARYNAME}.exe.velho"
!macroend
