# Incidente 429 após reinstalação — 23/10/2026

## Reprodução e diagnóstico

- A instalação local 0.7.8 contém `host/c-host.exe` de 7.514.624 bytes (SHA-256 `86F440810214E35C0C56D55807E4A206979FE392AE8A387DA64E4E9688794F7A`).
- O host do projeto contém 8.102.400 bytes (SHA-256 `15B6EE58B3A00BB11818F9BE1DF1C14A72DAF6BCD8013AA035A96FED8D255D1A`).
- Em um teste anterior, o host antigo devolveu 429, enquanto o host novo respondeu no frontend de desenvolvimento. Em uma execução no Navegador, Liz 4.5 Super respondeu “Oi, Gabriel! Como posso ajudar?” em 6,4 s. [Captura](teste-browser-host-novo.png).
- **Correção do diagnóstico (após instalação de 0.7.9):** o app instalado contém exatamente o host novo (SHA-256 `15B6EE58B3A00BB11818F9BE1DF1C14A72DAF6BCD8013AA035A96FED8D255D1A`) e os arquivos do backend correspondem aos do projeto. Mesmo assim, Liz 4.5 Super respondeu 429 às 16:38 e Koda 1 respondeu o mesmo 429 às 16:46. A diferença de binário anterior era real, mas não era uma explicação suficiente para o incidente. O sucesso pontual no ambiente de desenvolvimento não garantia sucesso contínuo no instalado.

## Correções

- O frontend obtém o catálogo em `GET /api/models`, sem testar cada modelo com mensagens `oi` ao iniciar. A rota antiga `/api/models/testados` também deixou de disparar pedidos de chat.
- A lista local de modelos marcados por erro 400 é descartada, pois erros transitórios ou de integração não provam que o modelo é inválido.
- Em 429, o cliente respeita `Retry-After` quando presente e espaça novas tentativas. Isso evita requisições em rajada, mas não promete superar uma cota real do serviço.
- O build exige que o tamanho do host corresponda ao valor declarado no instalador. Na atualização, o NSIS aborta se o host antigo estiver travado e confere o tamanho do arquivo instalado antes de declarar sucesso.

## Validação e limite

- Verificação estática do frontend e testes de reconexão do backend passaram.
- O teste de ponta a ponta no Navegador fez envio real de mensagem com ambos os hosts. O reteste no aplicativo instalado 0.7.9 reproduziu 429 em dois modelos apesar de host e backend atualizados.
- O build completo 0.7.9 terminou com código 0: NSIS, MSI, lançador e verificação do bundle. O host copiado para `src-tauri/target/release/host/c-host.exe` tem o mesmo SHA-256 do host funcional: `15B6EE58B3A00BB11818F9BE1DF1C14A72DAF6BCD8013AA035A96FED8D255D1A`.
- Instalador NSIS final: `src-tauri/target/release/bundle/nsis/Koda_0.7.9_x64-setup.exe` (101.625.856 bytes; SHA-256 `4DC302A88418F262180A3E4895C690A9410216E4F0BFDCFFED0F11D6C6B3637B`).
- A instalação 0.7.9 não resolveu o 429. Não atribuir o incidente ao arquivo antigo do host nem distribuir outro instalador como correção sem demonstrar resposta do modelo no aplicativo instalado.
