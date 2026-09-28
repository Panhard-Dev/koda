; Mensagens próprias do instalador do Tauri em português do Brasil.
;
; O NSIS já traz as telas padrão em pt-BR (Bem-vindo, Avançar, Cancelar, pasta de
; instalação…) pelo `PortugueseBR.nlf` que vem com ele; o que não vem traduzido são as
; mensagens **do Tauri** — instalador já no ar, versão anterior, WebView2 — e são elas
; que ficariam em inglês no meio de uma tela em português. Este arquivo cobre as 27.
;
; Sem BOM de propósito: o Tauri acrescenta o dele ao copiar o arquivo para a pasta de
; build, e dois BOMs seguidos fazem o makensis ler o `;` como comando e abortar.
;
; Os nomes à esquerda de `${LANG_PORTUGUESEBR}` são os que o template do Tauri procura;
; trocar qualquer um deles quebra a compilação do instalador. `{{product_name}}` e
; `$\n` (quebra de linha) são do próprio template e vão como estão.
LangString addOrReinstall ${LANG_PORTUGUESEBR} "Adicionar/Reinstalar componentes"
LangString alreadyInstalled ${LANG_PORTUGUESEBR} "Já instalado"
LangString alreadyInstalledLong ${LANG_PORTUGUESEBR} "${PRODUCTNAME} ${VERSION} já está instalado. Escolha o que você quer fazer e clique em Avançar para continuar."
LangString appRunning ${LANG_PORTUGUESEBR} "{{product_name}} está em execução! Feche o programa e tente de novo."
LangString appRunningOkKill ${LANG_PORTUGUESEBR} "{{product_name}} está em execução!$\nClique em OK para encerrar"
LangString chooseMaintenanceOption ${LANG_PORTUGUESEBR} "Escolha a opção de manutenção que você quer executar."
LangString choowHowToInstall ${LANG_PORTUGUESEBR} "Escolha como você quer instalar o ${PRODUCTNAME}."
LangString createDesktop ${LANG_PORTUGUESEBR} "Criar atalho na área de trabalho"
LangString deleteAppData ${LANG_PORTUGUESEBR} "Apagar os dados do aplicativo"
LangString dontUninstall ${LANG_PORTUGUESEBR} "Não desinstalar"
LangString dontUninstallDowngrade ${LANG_PORTUGUESEBR} "Não desinstalar (voltar para uma versão anterior sem desinstalar está desativado neste instalador)"
LangString failedToKillApp ${LANG_PORTUGUESEBR} "Não foi possível encerrar o {{product_name}}. Feche o programa e tente de novo"
LangString installingWebview2 ${LANG_PORTUGUESEBR} "Instalando o WebView2..."
LangString newerVersionInstalled ${LANG_PORTUGUESEBR} "Uma versão mais nova do ${PRODUCTNAME} já está instalada! Não é recomendado instalar uma versão anterior. Se você quer mesmo esta versão, o melhor é desinstalar a atual primeiro. Escolha o que você quer fazer e clique em Avançar para continuar."
LangString older ${LANG_PORTUGUESEBR} "anterior"
LangString olderOrUnknownVersionInstalled ${LANG_PORTUGUESEBR} "Há uma versão $R4 do ${PRODUCTNAME} instalada neste computador. O recomendado é desinstalar a atual antes de instalar. Escolha o que você quer fazer e clique em Avançar para continuar."
LangString silentDowngrades ${LANG_PORTUGUESEBR} "Voltar para uma versão anterior está desativado neste instalador, então não dá para seguir com a instalação silenciosa. Use o instalador com a interface gráfica.$\n"
LangString unableToUninstall ${LANG_PORTUGUESEBR} "Não foi possível desinstalar!"
LangString uninstallApp ${LANG_PORTUGUESEBR} "Desinstalar o ${PRODUCTNAME}"
LangString uninstallBeforeInstalling ${LANG_PORTUGUESEBR} "Desinstalar antes de instalar"
LangString unknown ${LANG_PORTUGUESEBR} "desconhecida"
LangString webview2AbortError ${LANG_PORTUGUESEBR} "Não foi possível instalar o WebView2! O app não roda sem ele. Tente reiniciar o instalador."
LangString webview2DownloadError ${LANG_PORTUGUESEBR} "Erro: falha ao baixar o WebView2 - $0"
LangString webview2DownloadSuccess ${LANG_PORTUGUESEBR} "O instalador do WebView2 foi baixado"
LangString webview2Downloading ${LANG_PORTUGUESEBR} "Baixando o instalador do WebView2..."
LangString webview2InstallError ${LANG_PORTUGUESEBR} "Erro: a instalação do WebView2 falhou com o código $1"
LangString webview2InstallSuccess ${LANG_PORTUGUESEBR} "WebView2 instalado"
