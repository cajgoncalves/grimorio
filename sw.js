/* Service worker do "Magic em português".
   Três estratégias, uma para cada tipo de coisa:
   - a própria página, ícones e dicionários: rede primeiro, cache se não houver rede
   - consultas ao Scryfall: rede primeiro, cache como rede de segurança
   - imagens das cartas: cache primeiro (a imagem de uma carta nunca muda)      */

var VERSAO = "v20";
var SHELL  = "mtgpt-shell-" + VERSAO;
var DADOS  = "mtgpt-dados-" + VERSAO;
var FIGS   = "mtgpt-figuras-" + VERSAO;

var ESSENCIAIS = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./dic/indice.js",
  "./dic/blb.js",
  "./dic/fdn.js",
  "./icon-512.png"
];

var LIMITE_FIGURAS = 200;

self.addEventListener("install", function (evento) {
  evento.waitUntil(
    caches.open(SHELL).then(function (cache) {
      // addAll falha inteiro se um arquivo faltar; aqui cada um é independente
      return Promise.all(ESSENCIAIS.map(function (url) {
        return cache.add(new Request(url, { cache: "reload" })).catch(function () {});
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (evento) {
  evento.waitUntil(
    caches.keys().then(function (nomes) {
      return Promise.all(nomes.map(function (n) {
        if (n !== SHELL && n !== DADOS && n !== FIGS) return caches.delete(n);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

function guardarComLimite(nomeCache, pedido, resposta, limite) {
  return caches.open(nomeCache).then(function (cache) {
    return cache.put(pedido, resposta).then(function () {
      return cache.keys().then(function (chaves) {
        if (chaves.length <= limite) return;
        return Promise.all(chaves.slice(0, chaves.length - limite).map(function (c) {
          return cache.delete(c);
        }));
      });
    });
  });
}

self.addEventListener("fetch", function (evento) {
  var pedido = evento.request;
  if (pedido.method !== "GET") return;

  var url;
  try { url = new URL(pedido.url); } catch (e) { return; }

  /* ---- consultas ao Scryfall: rede primeiro ---- */
  if (url.hostname === "api.scryfall.com") {
    evento.respondWith(
      fetch(pedido).then(function (resposta) {
        if (resposta && resposta.ok) {
          var copia = resposta.clone();
          guardarComLimite(DADOS, pedido, copia, 300);
        }
        return resposta;
      }).catch(function () {
        return caches.match(pedido).then(function (guardada) {
          if (guardada) return guardada;
          return new Response(
            JSON.stringify({ object: "error", code: "offline", details: "Sem internet." }),
            { status: 503, headers: { "Content-Type": "application/json" } }
          );
        });
      })
    );
    return;
  }

  /* ---- imagens das cartas: cache primeiro ---- */
  if (url.hostname === "cards.scryfall.io") {
    evento.respondWith(
      caches.match(pedido).then(function (guardada) {
        if (guardada) return guardada;
        return fetch(pedido).then(function (resposta) {
          if (resposta && (resposta.ok || resposta.type === "opaque")) {
            guardarComLimite(FIGS, pedido, resposta.clone(), LIMITE_FIGURAS);
          }
          return resposta;
        });
      })
    );
    return;
  }

  /* ---- fontes do Google: cache primeiro ---- */
  if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") {
    evento.respondWith(
      caches.match(pedido).then(function (guardada) {
        return guardada || fetch(pedido).then(function (resposta) {
          if (resposta && (resposta.ok || resposta.type === "opaque")) {
            guardarComLimite(SHELL, pedido, resposta.clone(), 40);
          }
          return resposta;
        }).catch(function () { return guardada; });
      })
    );
    return;
  }

  /* ---- a própria página e os dicionários: rede primeiro ----
     Antes era "cache primeiro, atualizando por trás": abria instantâneo,
     mas cada atualização do site só aparecia na SEGUNDA vez que o app era
     aberto — e, na primeira, a página nova podia rodar com o índice velho
     dos dicionários, sem achar as explicações novas. Agora vai à rede e
     usa o cache só se a rede falhar ou demorar mais de 3 segundos (sinal
     fraco na mesa de jogo continua abrindo rápido, e sem internet também). */
  if (url.origin === self.location.origin) {
    evento.respondWith(
      new Promise(function (resolver) {
        var respondeu = false;
        function responder(r) { if (!respondeu && r) { respondeu = true; resolver(r); } }
        var doCache = function () {
          return caches.match(pedido).then(function (g) { return g || caches.match("./index.html"); });
        };
        var espera = setTimeout(function () { doCache().then(responder); }, 3000);
        fetch(pedido, { cache: "no-cache" }).then(function (resposta) {
          if (resposta && resposta.ok) {
            var copia = resposta.clone();
            caches.open(SHELL).then(function (c) { c.put(pedido, copia); });
            clearTimeout(espera); responder(resposta);
          } else {
            doCache().then(function (g) { clearTimeout(espera); responder(g || resposta); });
          }
        }).catch(function () {
          doCache().then(function (g) {
            clearTimeout(espera);
            responder(g || new Response("Sem internet e sem cópia guardada.", { status: 503 }));
          });
        });
      })
    );
  }
});
