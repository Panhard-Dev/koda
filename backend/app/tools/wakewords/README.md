# Modelo de palavra de ativação (terceiro, só de referência)

`hey_koda.tflite` — modelo de hotword on-device, redistribuído junto com o código de
terceiros desta pasta (licença e titular em `../LICENSE.koda`).

**O Koda não tem palavra de ativação**: nada aqui é carregado em tempo de execução. O arquivo
foi mantido só porque faz parte da cópia de referência.

Duas ressalvas de quem for mexer:

- o **rótulo** do modelo acompanha o nome do arquivo (por isso o arquivo e o código da
  referência concordam), mas o modelo **não** foi retreinado: a frase que ele detecta é a que
  foi treinada, não "hey koda";
- o motor de referência é o [pyopen-wakeword](https://github.com/rhasspy/pyopen-wakeword)
  (Apache-2.0), que roda TFLite e não baixa modelo por nome.

Para usar uma frase diferente, seria preciso treinar outro modelo e apontar o caminho para ele.
