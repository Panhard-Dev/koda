/*
 * Service worker mínimo do Koda mobile.
 *
 * Ele existe para o app poder ser instalado na tela inicial do celular e para
 * abrir mesmo com a rede oscilando. Tudo é **network-first**: com internet, a
 * versão servida pelo PC é sempre a nova; o cache só entra quando o fetch
 * falha. Nada de API passa por aqui — o app fala com o PC por WebSocket, que o
 * service worker não intercepta.
 */

const CACHE = 'koda-mobile-v4'
const CASCA = [
  './',
  './mobile.js',
  './blocos.js',
  './mobile.css',
  './manifest.webmanifest',
  './icone-192.png',
  './icone-512.png',
]

self.addEventListener('install', (evento) => {
  evento.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(CASCA))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (evento) => {
  evento.waitUntil(
    caches
      .keys()
      .then((chaves) =>
        Promise.all(chaves.filter((chave) => chave !== CACHE).map((chave) => caches.delete(chave))),
      )
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (evento) => {
  const pedido = evento.request
  if (pedido.method !== 'GET') return

  const url = new URL(pedido.url)
  if (url.origin !== self.location.origin) return
  if (!url.pathname.startsWith('/mobile/')) return

  evento.respondWith(
    fetch(pedido)
      .then((resposta) => {
        if (resposta.ok) {
          const copia = resposta.clone()
          caches.open(CACHE).then((cache) => cache.put(pedido, copia))
        }
        return resposta
      })
      .catch(() => caches.match(pedido).then((salva) => salva ?? caches.match('./'))),
  )
})
