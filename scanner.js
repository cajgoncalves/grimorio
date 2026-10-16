/* Scanner de cartas do Grimório — motor compartilhado.
   Usado pelo app (index.html, botão "Escanear" na aba Carta) e pelo
   laboratório (laboratorio.html). Também é carregado pelos testes em
   ferramentas/ e pelo gerador do índice de artes.

   Aqui fica TUDO que não é tela: ler o código da coleção e o nome no texto
   da carta, comparar a arte com o índice (artes.js), decidir quando aceitar
   uma carta e o laço da câmera. Cada página só desenha a sua própria tela e
   recebe o resultado por funções ("ganchos") passadas em Scanner.sessao().

   Privacidade: a imagem da câmera nunca sai do celular. Só texto e números
   de carta vão ao Scryfall.

   Uso:
     Scanner.config({ api: minhaFuncaoDeApi });   // opcional (o app passa a dele)
     await Scanner.carregarTudo();                // artes.js + Tesseract + listas
     var s = Scanner.sessao({ video, molde, aoAchar, aoLer, aoEstado, ... });
     await s.ligar();  ...  s.desligar();
*/
(function(){
"use strict";

/* ================= utilidades ================= */
var cfg={ api:null, prefixo:"grimorio.scan.", carregar:null };
function esperar(ms){ return new Promise(function(r){ setTimeout(r,ms); }); }
function norm(s){ return String(s||"").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g,"").replace(/[^a-z0-9 ]/g," ").replace(/\s+/g," ").trim(); }
function ler(k,d){ try{ var v=localStorage.getItem(cfg.prefixo+k); return v?JSON.parse(v):d; }catch(e){ return d; } }
function guardar(k,v){ try{ localStorage.setItem(cfg.prefixo+k,JSON.stringify(v)); }catch(e){} }

/* ================= Scryfall (120 ms entre pedidos) ================= */
var ultima=0, cacheApi={};
async function apiPadrao(caminho){
  var falta=120-(Date.now()-ultima); if(falta>0) await esperar(falta);
  ultima=Date.now();
  var r=await fetch("https://api.scryfall.com"+caminho);
  var d=await r.json().catch(function(){ return null; });
  if(!r.ok && !(r.status===404 && d && d.object==="error")) throw new Error("rede "+r.status);
  return d;
}
async function api(caminho){
  if(cacheApi[caminho]) return cacheApi[caminho];
  var d=await (cfg.api||apiPadrao)(caminho);
  cacheApi[caminho]=d;
  return d;
}

/* ================= carregar o que é pesado, só quando precisa ================= */
var URL_TESSERACT="https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js";
var _scripts={};
function carregarScript(url){
  if(cfg.carregar) return cfg.carregar(url);   /* a página pode ter começado o download antes */
  if(_scripts[url]) return _scripts[url];
  _scripts[url]=new Promise(function(ok,erro){
    var s=document.createElement("script");
    s.src=url; s.async=true;
    s.onload=function(){ ok(); };
    s.onerror=function(){ delete _scripts[url]; erro(new Error("não baixou "+url)); };
    document.head.appendChild(s);
  });
  return _scripts[url];
}

/* ================= lista de coleções ================= */
/* Serve para corrigir o código lido: "FON" vira "FDN". As coleções que
   vocês jogam ganham prioridade no empate. */
var PRIORIDADE=["FDN","J25","FDC"];
var COLECOES=PRIORIDADE.slice();
var TAMANHO={FDN:771,J25:779,FDC:319};
async function carregarColecoes(){
  var salvo=ler("colecoes",null);
  if(salvo && Date.now()-salvo.em < 7*864e5){ definirColecoes(salvo.lista); return; }
  try{
    var d=await api("/sets");
    var lista=d.data.filter(function(s){ return !s.digital; }).map(function(s){ return [s.code.toUpperCase(),s.card_count]; });
    if(lista.length){ definirColecoes(lista); guardar("colecoes",{em:Date.now(),lista:lista}); }
  }catch(e){}
}
function definirColecoes(lista){
  COLECOES=lista.map(function(p){ return p[0]; });
  lista.forEach(function(p){ TAMANHO[p[0]]=p[1]; });
}
/* distância com as confusões típicas do OCR custando menos */
var PARECIDAS={"OD":.3,"DO":.3,"0O":.2,"O0":.2,"1I":.3,"I1":.3,"5S":.3,"S5":.3,"8B":.3,"B8":.3,
               "NH":.5,"HN":.5,"ED":.4,"EF":.4,"FE":.4,"SF":.5,"FS":.5,"CD":.5,"DC":.5,"OC":.4,"CO":.4,"UV":.4,"VU":.4,"2Z":.4,"Z2":.4,"0D":.4,"D0":.4,"CG":.5,"GC":.5};
function distancia(a,b){
  var m=a.length,n=b.length,d=[],i,j;
  for(i=0;i<=m;i++){ d[i]=[i]; }
  for(j=0;j<=n;j++){ d[0][j]=j; }
  for(i=1;i<=m;i++) for(j=1;j<=n;j++){
    var c=a[i-1]===b[j-1]?0:(PARECIDAS[a[i-1]+b[j-1]]||1);
    d[i][j]=Math.min(d[i-1][j]+1,d[i][j-1]+1,d[i-1][j-1]+c);
  }
  return d[m][n];
}
var IDIOMAS=["EN","PT","ES","FR","DE","IT","JA","KO","RU","ZH","PH"];
function lerRodape(txt){
  /* O rodapé moderno tem duas linhas:
       R 0711
       FDN • EN  [pincel] NOME DO ILUSTRADOR
     O código da coleção é o que vem LOGO ANTES do idioma. Procurar em
     qualquer lugar da linha deixava o nome do ilustrador virar coleção
     ("MATT" → MAT, "MAGALI" → MAR). O número vem na linha de cima, às
     vezes grudado na raridade ("M0707").                                */
  var linhas=String(txt).toUpperCase().split(/\n/)
    .map(function(l){ return l.replace(/[^A-Z0-9\s]/g," ").replace(/\s+/g," ").trim(); })
    .filter(Boolean);
  var achado=null;
  for(var i=0;i<linhas.length && !achado;i++){
    var toks=linhas[i].split(" ");
    for(var k=0;k<toks.length;k++){
      var t=toks[k], cod=null;
      if(IDIOMAS.indexOf(t)>=0 && k>0) cod=toks[k-1];
      else{
        for(var L=0;L<IDIOMAS.length;L++){
          var id=IDIOMAS[L];
          if(t.length>=id.length+2 && t.length<=id.length+5 && t.slice(-id.length)===id){ cod=t.slice(0,-id.length); break; }
        }
      }
      if(!cod) continue;
      var numero=numeroPerto(linhas,i,toks.slice(0,k).join(" "));
      var col=casarColecao(cod,numero,false);
      if(col){ achado={colecao:col,numero:numero&&cabe(col,numero)?numero:null}; break; }
    }
  }
  if(achado) return achado;
  /* sem o idioma legível: só aceita as coleções de vocês, e o número tem que caber nelas */
  var todos=linhas.join(" ").split(" "), num=null;
  for(var n=linhas.length;n>0 && !num;n--) num=numeroPerto(linhas,n,"");
  for(var j=0;j<todos.length;j++){
    if(todos[j].length<3 || todos[j].length>4 || /^[0-9]+$/.test(todos[j])) continue;
    if(IDIOMAS.indexOf(todos[j])>=0) continue;   // "EN" está em toda carta: nunca é coleção
    var c=casarColecao(todos[j],num,true);
    if(c) return {colecao:c,numero:num&&cabe(c,num)?num:null};
  }
  return {colecao:null,numero:null};
}
/* número de colecionador: na linha do código (antes dele) ou nas duas de cima */
function numeroPerto(linhas,i,antes){
  var fontes=[antes, linhas[i-1]||"", linhas[i-2]||""];
  for(var f=0;f<fontes.length;f++){
    var l=fontes[f].replace(/\b([CURMLSTPB])(?=[0-9O]{3,4}\b)/g,"$1 ");
    var toks=l.split(" ");
    for(var k=toks.length-1;k>=0;k--){
      var t=toks[k];
      if(!/^[0-9OIS]{3,4}$/.test(t) || !/[0-9]/.test(t)) continue;
      var d=t.replace(/O/g,"0").replace(/I/g,"1").replace(/S/g,"5");
      var n=parseInt(d,10);
      if(n>0) return String(n);
    }
  }
  return null;
}
function cabe(col,num){ var n=TAMANHO[col]; return !n || +num<=n+20; }
function casarColecao(tok,num,soAsNossas){
  tok=String(tok).replace(/[^A-Z0-9]/g,"");
  if(tok.length<2 || tok.length>5) return null;
  var melhor=null;
  var lista=soAsNossas?PRIORIDADE:COLECOES;
  lista.forEach(function(s){
    var nossa=PRIORIDADE.indexOf(s)>=0, dd;
    if(tok.length===2){
      if(!nossa) return;                         // "ON" só pode ser pedaço de FDN
      dd=Math.min(distancia(tok,s.slice(1)),distancia(tok,s.slice(0,2)))+.5;
    }else{
      if(Math.abs(s.length-tok.length)>1) return;
      dd=distancia(tok,s);
    }
    if(dd>1.01) return;
    if(num && !cabe(s,num)) return;              // 717 não cabe numa coleção de 165 cartas
    var peso=dd-(nossa?.6:0);
    if(!melhor || peso<melhor.peso) melhor={peso:peso,col:s};
  });
  return melhor?melhor.col:null;
}

/* Índice local dos nomes das coleções que vocês jogam. Um nome lido pela
   metade ("Sate Who lanalis at fate") ainda casa com o certo ("Alesha, Who
   Laughs at Fate") porque a comparação é palavra a palavra, e o nome só é
   aceito se ganhar do segundo colocado com folga — "Llanowar Elves" e
   "Llanowar Tribe" não podem virar um empate decidido no chute. */
var INDICE=[];
async function carregarIndice(){
  var salvo=ler("indice",null);
  if(salvo && Date.now()-salvo.em < 7*864e5 && salvo.lista.length){ INDICE=prepararIndice(salvo.lista); return; }
  try{
    var q="("+PRIORIDADE.map(function(c){ return "set:"+c.toLowerCase(); }).join(" or ")+") game:paper";
    var caminho="/cards/search?q="+encodeURIComponent(q)+"&unique=cards&order=name", lista=[], voltas=0;
    while(caminho && voltas<20){
      var d=await api(caminho);
      (d.data||[]).forEach(function(c){ lista.push([c.name,c.oracle_id]); });
      caminho=d.has_more&&d.next_page ? d.next_page.replace("https://api.scryfall.com","") : null;
      voltas++;
    }
    if(lista.length){ guardar("indice",{em:Date.now(),lista:lista}); INDICE=prepararIndice(lista); }
  }catch(e){}
}
function prepararIndice(lista){
  return lista.map(function(par){
    var nome=par[0].split(" // ")[0], n=norm(nome);
    return { nome:par[0], oracle:par[1], n:n, palavras:n.split(" ").filter(function(w){ return w.length>=3; }) };
  });
}
function lev(a,b){
  var m=a.length,n=b.length; if(!m) return n; if(!n) return m;
  var ant=new Array(n+1), cur=new Array(n+1), i, j;
  for(j=0;j<=n;j++) ant[j]=j;
  for(i=1;i<=m;i++){ cur[0]=i;
    for(j=1;j<=n;j++) cur[j]=Math.min(ant[j]+1,cur[j-1]+1,ant[j-1]+(a[i-1]===b[j-1]?0:1));
    var t=ant; ant=cur; cur=t; }
  return ant[n];
}
function casarNomeLocal(lido){
  var q=norm(lido); if(q.replace(/ /g,"").length<4 || !INDICE.length) return null;
  var toks=q.split(" ").filter(function(w){ return w.length>=2; });
  if(!toks.length) return null;
  var melhor=null, segundo=null;
  INDICE.forEach(function(e){
    var inteiro=1-lev(q,e.n)/Math.max(q.length,e.n.length);
    /* cada palavra do nome vale pela semelhança com a melhor palavra lida,
       e palavras compridas pesam mais: "vitality" contra "finality" dá
       0,75 e não 1 — antes as duas empatavam e nenhuma era aceita */
    var ws=e.palavras.length?e.palavras:e.n.split(" "), soma=0, peso=0;
    ws.forEach(function(w){
      var sim=0;
      toks.forEach(function(t){ var v=1-lev(t,w)/Math.max(t.length,w.length); if(v>sim) sim=v; });
      if(sim<.6) sim=0;          // palavra meio parecida não conta: "first" não é meio "sure"
      soma+=sim*w.length; peso+=w.length;
    });
    var porPalavra=peso?soma/peso:0;
    var sobra=toks.length-(e.n.split(" ").length+2);
    if(sobra>0) porPalavra*=Math.max(0,1-sobra*.15);
    if(ws.length===1 && inteiro<.6) porPalavra*=.8;
    var nota=Math.max(inteiro,porPalavra*.97);
    if(!melhor || nota>melhor.nota){ segundo=melhor; melhor={nota:nota,e:e}; }
    else if(!segundo || nota>segundo.nota){ segundo={nota:nota,e:e}; }
  });
  if(!melhor || melhor.nota<.74) return null;
  /* nome curto erra fácil ("Angel" → Anger): exige leitura quase exata */
  if(melhor.e.n.replace(/ /g,"").length<=6 && melhor.nota<.9) return null;
  if(segundo && melhor.nota-segundo.nota<.06) return null;
  return { name:melhor.e.nome, oracle_id:melhor.e.oracle, parcial:true, nota:+melhor.nota.toFixed(2) };
}

function rodapeEstrito(linhas){
  var L=IDIOMAS.join("|");
  for(var i=0;i<linhas.length;i++){
    var t=linhas[i].toUpperCase().replace(/[^A-Z0-9\s]/g," ").replace(/\s+/g," ");
    var m=t.match(new RegExp("\\b([A-Z0-9]{3,5})\\s*("+L+")\\b"));
    if(!m) continue;
    var cod=lerRodape(m[1]).colecao;
    if(!cod) continue;
    var perto=(linhas[i-1]||"")+" "+linhas[i];
    var n=perto.toUpperCase().match(/\b[CURMLTS]?\s?([0-9OIS]{3,4})\b/g)||[];
    for(var k=0;k<n.length;k++){
      var dig=n[k].replace(/^[CURMLTS]\s?/,"").replace(/O/g,"0").replace(/I/g,"1").replace(/S/g,"5");
      if(/^\d{3,4}$/.test(dig) && /\d/.test(n[k])) return {colecao:cod, numero:String(parseInt(dig,10))};
    }
    return {colecao:cod, numero:null};
  }
  return {colecao:null, numero:null};
}

function limparNome(txt){
  var linhas=String(txt).split(/\n/).map(function(l){ return l.trim(); }).filter(Boolean);
  var l=linhas.sort(function(a,b){ return b.replace(/[^A-Za-zÀ-ÿ]/g,"").length-a.replace(/[^A-Za-zÀ-ÿ]/g,"").length; })[0]||"";
  l=l.replace(/^[^A-Za-zÀ-ÿ]+/,"").replace(/[^A-Za-zÀ-ÿ'!?]+$/,"");
  l=l.replace(/[|_~^`"“”«»©®]/g,"").replace(/\s{2,}/g," ");
  return l.replace(/[^A-Za-zÀ-ÿ]/g,"").length>=3 ? l : "";
}

/* ================= tratamento da imagem ================= */
/* Recorta uma faixa da carta, amplia, estica o contraste e — se o texto
   for claro sobre fundo escuro (rodapé preto) — inverte. `binarizar`
   aplica o limiar de Otsu (bom no rodapé, ruim no nome). */
function tratar(fonte, r, alturaAlvo, destino, binarizar){
  var k=alturaAlvo/r.h, w=Math.max(1,Math.round(r.w*k)), h=alturaAlvo;
  destino.width=w; destino.height=h;
  var g=destino.getContext("2d",{willReadFrequently:true});
  g.imageSmoothingEnabled=true; g.imageSmoothingQuality="high";
  g.drawImage(fonte,r.x,r.y,r.w,r.h,0,0,w,h);
  var img=g.getImageData(0,0,w,h), p=img.data, n=w*h, cinza=new Uint8ClampedArray(n), hist=new Array(256).fill(0), i, soma=0;
  for(i=0;i<n;i++){ var v=(p[i*4]*299+p[i*4+1]*587+p[i*4+2]*114)/1000|0; cinza[i]=v; hist[v]++; soma+=v; }
  var lo=0,hi=255,acc=0; for(i=0;i<256;i++){ acc+=hist[i]; if(acc>n*.02){ lo=i; break; } }
  acc=0; for(i=255;i>=0;i--){ acc+=hist[i]; if(acc>n*.02){ hi=i; break; } }
  var inverter=(soma/n)<128, faixa=Math.max(1,hi-lo);
  for(i=0;i<n;i++){ var s=(cinza[i]-lo)*255/faixa; s=s<0?0:s>255?255:s; if(inverter) s=255-s; cinza[i]=s; }
  if(binarizar){
    var h2=new Array(256).fill(0); for(i=0;i<n;i++) h2[cinza[i]|0]++;
    var tot=0; for(i=0;i<256;i++) tot+=i*h2[i];
    var sB=0,wB=0,max=0,lim=128;
    for(i=0;i<256;i++){ wB+=h2[i]; if(!wB) continue; var wF=n-wB; if(!wF) break; sB+=i*h2[i];
      var mB=sB/wB, mF=(tot-sB)/wF, entre=wB*wF*(mB-mF)*(mB-mF); if(entre>max){ max=entre; lim=i; } }
    for(i=0;i<n;i++) cinza[i]=cinza[i]>lim?255:0;
  }
  for(i=0;i<n;i++){ p[i*4]=p[i*4+1]=p[i*4+2]=cinza[i]; p[i*4+3]=255; }
  g.putImageData(img,0,0);
  return destino;
}

/* regiões dentro da carta (fração da largura/altura), medidas numa carta real */
var FAIXA_NOME={x:.055,y:.038,w:.74,h:.075};
var FAIXA_RODAPE={x:.03,y:.885,w:.40,h:.09};

/* ================= o leitor (Tesseract) ================= */
var leitor=null, _preparando=null;
async function prepararLeitor(){
  if(leitor) return leitor;
  if(_preparando) return _preparando;
  _preparando=(async function(){
    if(typeof Tesseract==="undefined") await carregarScript(URL_TESSERACT);
    leitor=await Tesseract.createWorker("eng",1,{});
    return leitor;
  })();
  try{ return await _preparando; }catch(e){ _preparando=null; throw e; }
}
async function ocr(canvas, modo){
  if(modo==="rodape"){
    await leitor.setParameters({tessedit_pageseg_mode:"6",tessedit_char_whitelist:"ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 "});
  }else if(modo==="nome"){
    await leitor.setParameters({tessedit_pageseg_mode:"7",tessedit_char_whitelist:""});
  }else{
    await leitor.setParameters({tessedit_pageseg_mode:"11",tessedit_char_whitelist:""});
  }
  var r=await leitor.recognize(canvas);
  return r.data;
}

/* ================= identificar a partir das duas leituras ================= */
async function porRodape(col,num){
  if(!col||!num) return null;
  try{ var c=await api("/cards/"+col.toLowerCase()+"/"+num); return c&&c.object==="card"?c:null; }catch(e){ return null; }
}
async function porNome(nome){
  if(!nome) return null;
  var local=casarNomeLocal(nome);
  if(local) return local;
  /* fora das coleções de vocês: o corretor do Scryfall, só com leitura razoável */
  if(nome.replace(/[^A-Za-zÀ-ÿ]/g,"").length<5) return null;
  try{ var c=await api("/cards/named?fuzzy="+encodeURIComponent(nome)); return c&&c.object==="card"?c:null; }catch(e){ return null; }
}
async function cartaCompleta(c){
  if(c && !c.parcial) return c;
  try{ var d=await api("/cards/named?exact="+encodeURIComponent(c.name)); return d&&d.object==="card"?d:c; }catch(e){ return c; }
}

/* ================= reconhecimento pela ARTE (caminho rápido) ================= */
/* Como os apps de loja fazem: em vez de ler letras, compara o desenho da
   carta com a "impressão digital" das ~1.700 artes de FDN, J25 e FDC,
   guardada em artes.js (~145 KB). Leva poucos milissegundos por quadro e
   não depende de foco nítido nas letras. O leitor de texto continua
   rodando por trás: confirma a arte e cobre cartas de outras coleções. */
/* Impressão digital da arte — MESMO cálculo no scanner e no gerador do
   índice. A arte (não a moldura) é o que distingue as cartas: ela vira uma
   miniatura de 32x32 tons de cinza, passa por uma DCT e guarda o sinal das
   16x16 frequências mais baixas — 256 bits. Brilho, contraste e um pouco de
   desfoque quase não mudam esses bits; outra arte muda metade deles.

   Velocidade: ler pixels do canvas (getImageData) é a parte cara, uns 7 ms
   cada. Como cada quadro testa 27 enquadramentos, fazer isso 27 vezes dava
   ~190 ms por quadro no computador, e bem mais no celular. Agora o quadro é
   lido UMA vez e vira uma "tabela de somas" (imagem integral): depois disso,
   a média de qualquer retângulo sai com 4 consultas, e os 27 enquadramentos
   custam quase nada.                                                      */
var ARTE={x:.10,y:.125,w:.80,h:.41};
var LARGURA_ARTE=256;               /* largura em que a carta é redesenhada */
var _dctC=null;
function _cos(){
  if(_dctC) return _dctC; _dctC=new Float32Array(32*32);
  for(var u=0;u<32;u++) for(var x=0;x<32;x++) _dctC[u*32+x]=Math.cos((2*x+1)*u*Math.PI/64);
  return _dctC;
}
var _cv=[];
function _tela(i,w,h){ var c=_cv[i]||(_cv[i]=document.createElement("canvas")); if(c.width!==w)c.width=w; if(c.height!==h)c.height=h; return c; }

/* Redesenha a CARTA inteira num tamanho fixo e devolve a tabela de somas
   dos tons de cinza. fonte: vídeo/imagem/canvas; r: retângulo da carta. */
function quadroDaCarta(fonte, r){
  var W=LARGURA_ARTE, H=Math.max(8,Math.round(W*r.h/r.w));
  var c=_tela(0,W,H), g=c.getContext("2d",{willReadFrequently:true});
  g.imageSmoothingEnabled=true; g.imageSmoothingQuality="high";
  g.drawImage(fonte, r.x, r.y, r.w, r.h, 0, 0, W, H);
  var d=g.getImageData(0,0,W,H).data;
  var S=new Float32Array((W+1)*(H+1)), x, y, linha;
  for(y=0;y<H;y++){
    linha=0;
    for(x=0;x<W;x++){
      var k=(y*W+x)*4;
      linha+=.299*d[k]+.587*d[k+1]+.114*d[k+2];
      S[(y+1)*(W+1)+x+1]=S[y*(W+1)+x+1]+linha;
    }
  }
  return {W:W, H:H, S:S};
}
/* média de um retângulo, em 4 consultas */
function _media(Q,x0,y0,x1,y1){
  var W=Q.W+1, S=Q.S;
  x0=Math.max(0,Math.min(Q.W,Math.round(x0))); x1=Math.max(x0+1,Math.min(Q.W,Math.round(x1)));
  y0=Math.max(0,Math.min(Q.H,Math.round(y0))); y1=Math.max(y0+1,Math.min(Q.H,Math.round(y1)));
  return (S[y1*W+x1]-S[y0*W+x1]-S[y1*W+x0]+S[y0*W+x0])/((x1-x0)*(y1-y0));
}
/* rel: onde a carta está dentro do quadro, em frações (para os enquadramentos) */
function impressaoDoQuadro(Q, rel){
  var cx=Q.W*rel.x, cy=Q.H*rel.y, cw=Q.W*rel.w, ch=Q.H*rel.h;
  var ax=cx+cw*ARTE.x, ay=cy+ch*ARTE.y, aw=cw*ARTE.w, ah=ch*ARTE.h;
  var p=new Float32Array(1024), i, j;
  for(j=0;j<32;j++) for(i=0;i<32;i++)
    p[j*32+i]=_media(Q, ax+aw*i/32, ay+ah*j/32, ax+aw*(i+1)/32, ay+ah*(j+1)/32);
  var C=_cos(), t=new Float32Array(16*32), q=new Float32Array(256), u, v, x, y, s, k;
  for(u=0;u<16;u++) for(y=0;y<32;y++){ s=0; for(x=0;x<32;x++) s+=C[u*32+x]*p[y*32+x]; t[u*32+y]=s; }
  for(v=0;v<16;v++) for(u=0;u<16;u++){ s=0; for(y=0;y<32;y++) s+=C[v*32+y]*t[u*32+y]; q[v*16+u]=s; }
  var arr=Array.prototype.slice.call(q,1).sort(function(a,b){return a-b;}), med=(arr[127]+arr[128])/2;
  var h32=new Uint32Array(8);
  for(k=1;k<256;k++) if(q[k]>med) h32[k>>5]|=(1<<(k&31))>>>0;
  return h32;
}
/* atalho: impressão de uma carta inteira (usado pelo gerador do índice) */
function impressao(fonte, r){ return impressaoDoQuadro(quadroDaCarta(fonte,r), {x:0,y:0,w:1,h:1}); }
function _pop(n){ n=n-((n>>>1)&0x55555555); n=(n&0x33333333)+((n>>>2)&0x33333333); return (((n+(n>>>4))&0x0F0F0F0F)*0x01010101)>>>24; }
function distanciaArte(a,base,j){ var s=0; for(var k=0;k<8;k++) s+=_pop((a[k]^base[j*8+k])>>>0); return s; }

var BASE_ARTE=null, CARTAS_ARTE=[];
function prepararArtes(){
  var A=window.ARTES; if(!A||!A.h) return false;
  var bin=atob(A.h), bytes=new Uint8Array(bin.length);
  for(var i=0;i<bin.length;i++) bytes[i]=bin.charCodeAt(i);
  BASE_ARTE=new Uint32Array(bytes.buffer);
  CARTAS_ARTE=A.cartas.split("\n").map(function(l){ var p=l.split("|"); return {set:p[0],num:p[1],nome:p[2],o:p[3]}; });
  return CARTAS_ARTE.length*8===BASE_ARTE.length;
}
/* Tenta alguns enquadramentos (carta um pouco menor que o molde, um pouco
   deslocada) e fica com o que mais se parece com alguma arte. */
var VARIANTES_ARTE=(function(){ var v=[]; [1,.93,.86].forEach(function(s){ [-.03,0,.03].forEach(function(dx){ [-.025,0,.025].forEach(function(dy){ v.push({s:s,dx:dx,dy:dy}); }); }); }); return v; })();
function porArte(fonte, r0){
  if(!BASE_ARTE) return null;
  var Q=quadroDaCarta(fonte,r0), n=CARTAS_ARTE.length, porOracle={};
  for(var k=0;k<VARIANTES_ARTE.length;k++){
    var v=VARIANTES_ARTE[k];
    var hh=impressaoDoQuadro(Q,{x:(1-v.s)/2+v.dx, y:(1-v.s)/2+v.dy, w:v.s, h:v.s});
    for(var j=0;j<n;j++){
      var d=distanciaArte(hh,BASE_ARTE,j), o=CARTAS_ARTE[j].o;
      if(porOracle[o]===undefined || d<porOracle[o].d) porOracle[o]={d:d,j:j};
    }
  }
  var lista=Object.keys(porOracle).map(function(o){ return porOracle[o]; }).sort(function(a,b){ return a.d-b.d; });
  var a=lista[0], b=lista[1]||{d:256};
  return {j:a.j, carta:CARTAS_ARTE[a.j], d:a.d, folga:b.d-a.d, segunda:CARTAS_ARTE[b.j]||null};
}

/* Limites da distância entre impressões (0 a 256 bits). Calibrados com as
   1.869 artes e 320 cartas de OUTRAS coleções fotografadas em simulação:
   a carta certa fica em ~48 (fácil) a ~54 (difícil); carta que não está no
   índice nunca ficou abaixo de 84, nem com folga acima de 10. Os limites
   abaixo deixam ~20 bits de margem para a câmera real ser pior. */
var ARTE_CERTA=62, ARTE_FOLGA_CERTA=26, ARTE_BOA=72, ARTE_FOLGA=16;

/* Quando a arte basta:
   1. um quadro com distância muito baixa e nenhuma outra arte por perto;
   2. dois quadros seguidos apontando a mesma carta, com folga;
   3. um quadro razoável + o texto (nome ou rodapé) apontando a mesma carta. */
function julgarArte(va, vt){
  var u=va[va.length-1], p=va[va.length-2];
  if(!u) return null;
  if(u.d<=ARTE_CERTA && u.folga>=ARTE_FOLGA_CERTA) return {carta:u.carta, via:"pela arte"};
  if(p && p.carta.o===u.carta.o && u.d<=ARTE_BOA && p.d<=ARTE_BOA && u.folga>=ARTE_FOLGA && p.folga>=ARTE_FOLGA)
    return {carta:u.carta, via:"pela arte (2 quadros)"};
  if(u.d<=ARTE_BOA+6 && u.folga>=12){
    var bate=(vt||[]).slice(-3).some(function(v){ return (v.a && v.a.slice(0,8)===u.carta.o) || (v.b && v.b.slice(0,8)===u.carta.o); });
    if(bate) return {carta:u.carta, via:"arte e texto concordam"};
  }
  return null;
}

/* Quando aceitar uma carta pelo TEXTO:
   1. nome e rodapé apontam a MESMA carta no mesmo quadro → na hora. Duas
      leituras independentes errarem juntas para a mesma carta é quase
      impossível.
   2. só o nome, repetido: 2 quadros se o nome saiu quase inteiro (nota
      ≥ 0,9), 3 se saiu pela metade.
   3. só o rodapé, repetido 3 vezes — e nunca se algum quadro recente leu
      um nome que aponta outra carta. O rodapé é a leitura que pode sair
      "certa" e errada ao mesmo tempo: o iPhone leu 0712 como "0072", e a
      carta 72 existe.
   Em qualquer caso, uma carta que brigou com outra no mesmo quadro fica
   bloqueada enquanto a briga estiver na janela. */
function julgar(votos){
  var bloqueada={}, porNome={}, porRod={}, notaMax={}, carta={};
  votos.forEach(function(v){
    if(v.a && v.b && v.a!==v.b){ bloqueada[v.a]=1; bloqueada[v.b]=1; }
    if(v.a){ carta[v.a]=v.cartaA; }
    if(v.b && !carta[v.b]) carta[v.b]=v.cartaB;
  });
  var ultimo=votos[votos.length-1];
  if(ultimo && ultimo.a && ultimo.a===ultimo.b)
    return {aceita:true, carta:ultimo.cartaA, via:"as duas leituras concordam"};
  votos.forEach(function(v){
    if(v.b && !(v.a && v.a!==v.b)){ porNome[v.b]=(porNome[v.b]||0)+1; notaMax[v.b]=Math.max(notaMax[v.b]||0,v.nota); }
    if(v.a && !v.b) porRod[v.a]=(porRod[v.a]||0)+1;
  });
  var ids=Object.keys(carta), i, id;
  for(i=0;i<ids.length;i++){
    id=ids[i]; if(bloqueada[id]) continue;
    var n=porNome[id]||0, r=porRod[id]||0;
    var outroNome=Object.keys(porNome).some(function(x){ return x!==id; });
    if(n>=3 || (n>=2 && notaMax[id]>=.9) || (n>=1 && r>=1))
      return {aceita:true, carta:carta[id], via:(r?"nome e rodapé em quadros diferentes":"só o nome")};
    if(r>=3 && !outroNome) return {aceita:true, carta:carta[id], via:"só o rodapé"};
  }
  return {aceita:false, estado:Object.keys(bloqueada).length?"divergente":ids.length?"quase":"procurando"};
}

/* Cada quadro tenta um jeito diferente: reto, girado para um lado, girado
   para o outro, com a faixa mais folgada. Carta torta ou meio fora do molde
   acaba acertada em algum deles, e a votação junta os resultados. */
/* `s` = a carta ocupa só essa fração do molde (quem segura longe demais) */
var ESTRATEGIAS=[{a:0,e:1,s:1},{a:-3,e:1.2,s:1},{a:0,e:1.3,s:.9},{a:3,e:1.2,s:1},{a:0,e:1.3,s:.82},{a:0,e:1.45,s:1}];
function endireitar(cartaCanvas,fonte,r0,ang,escala){
  var s=escala||1, r={x:r0.x+r0.w*(1-s)/2, y:r0.y+r0.h*(1-s)/2, w:r0.w*s, h:r0.h*s};
  var cw=Math.round(r.w*1.12), ch=Math.round(r.h*1.06);
  cartaCanvas.width=cw; cartaCanvas.height=ch;
  var g=cartaCanvas.getContext("2d");
  g.save(); g.translate(cw/2,ch/2); g.rotate(-ang*Math.PI/180);
  g.drawImage(fonte,-(r.x+r.w/2),-(r.y+r.h/2)); g.restore();
  return {canvas:cartaCanvas, mx:(cw-r.w)/2, my:(ch-r.h)/2, w:r.w, h:r.h};
}
function faixa(c,f,exp){
  var w=c.w*f.w*(1+(exp-1)*.35), h=c.h*f.h*exp;
  var cx=c.mx+c.w*(f.x+f.w/2), cy=c.my+c.h*(f.y+f.h/2);
  var x=Math.max(0,cx-w/2), y=Math.max(0,cy-h/2);
  return {x:x, y:y, w:Math.min(w,c.canvas.width-x), h:Math.min(h,c.canvas.height-y)};
}

/* ================= a sessão de câmera ================= */
/* Uma sessão liga a câmera e roda dois laços em paralelo: a arte (rápido) e
   o texto (mais lento, entra depois de 1,2 s). Quando uma carta é aceita, a
   sessão fica pausada e chama o.aoAchar({carta, via}); a página decide o que
   mostrar e chama s.novaTentativa() para continuar.

   Opções:
     video, molde          elementos da página (o molde é o retângulo da carta)
     canvasNome, canvasRodape   (opcionais) onde mostrar os recortes lidos
     semBuscar             true: quando a arte reconhece, entrega só {name, set,
                           collector_number, parcial:true}, sem consultar o Scryfall
     aoAchar(v)            carta aceita (pode devolver uma Promise)
     aoLer(l)              uma leitura de texto terminou (para telas de teste)
     aoArte(res)           uma leitura de arte terminou
     aoEstado(texto,cls)   "procurando…", "quase lá"…
     aoDica(texto)         dica para quem segura a carta                     */
var PEDIDO_CAMERA={audio:false,video:{facingMode:{ideal:"environment"},width:{ideal:1920},height:{ideal:1920}}};
function sessao(o){
  var video=o.video, molde=o.molde;
  var quadro=document.createElement("canvas"), quadroArte=document.createElement("canvas"), cartaCanvas=document.createElement("canvas");
  var cNome=o.canvasNome||document.createElement("canvas"), cRod=o.canvasRodape||document.createElement("canvas");
  var fluxo=null, vez=0, ger=0;   /* ger: cada ligar() é uma "geração"; laços antigos morrem sozinhos */
  var est={ rodando:false, pausado:false, votos:[], votosArte:[], temposArte:[],
            inicioTentativa:0, quadrosTentativa:0, ultimaLeitura:null, quadro:quadro };
  function cb(nome){ var f=o[nome]; if(f) return f.apply(null,Array.prototype.slice.call(arguments,1)); }
  function marcarMolde(cls){ if(molde) molde.className=("molde "+(cls||"")).trim(); }

  function novaTentativa(){
    est.votos=[]; est.votosArte=[]; est.inicioTentativa=Date.now(); est.quadrosTentativa=0; est.pausado=false;
    marcarMolde("");
  }

  /* fluxoPronto (opcional): câmera já aberta pela página. No iPhone convém
     pedir a câmera logo no toque do botão, antes de baixar qualquer coisa. */
  async function ligar(fluxoPronto){
    fluxo=fluxoPronto||await navigator.mediaDevices.getUserMedia(PEDIDO_CAMERA);
    video.srcObject=fluxo;
    await video.play().catch(function(){});
    novaTentativa();
    est.rodando=true;
    var g=++ger; laco(g); lacoArte(g);
  }
  function desligar(){
    est.rodando=false; ger++;
    if(fluxo) fluxo.getTracks().forEach(function(t){ t.stop(); });
    fluxo=null;
    try{ video.srcObject=null; }catch(e){}
  }

  /* onde o molde cai dentro do vídeo (o vídeo usa object-fit: cover) */
  function retanguloDoMolde(){
    var vw=video.videoWidth, vh=video.videoHeight;
    var caixa=video.getBoundingClientRect(), m=molde.getBoundingClientRect();
    var esc=Math.max(caixa.width/vw, caixa.height/vh);
    var ox=(caixa.width-vw*esc)/2, oy=(caixa.height-vh*esc)/2;
    return { x:(m.left-caixa.left-ox)/esc, y:(m.top-caixa.top-oy)/esc, w:m.width/esc, h:m.height/esc };
  }

  /* --- caminho rápido: a arte --- */
  async function lacoArte(g){
    while(est.rodando && g===ger){
      if(est.pausado || !video.videoWidth || !BASE_ARTE){ await esperar(200); continue; }
      try{ await lerArte(); }catch(e){ console.warn(e); }
      await esperar(90);
    }
  }
  async function lerArte(){
    var t0=performance.now(), m=retanguloDoMolde(), pad=.06;
    var esc=Math.min(1,420/m.w);
    quadroArte.width=Math.round(m.w*(1+2*pad)*esc); quadroArte.height=Math.round(m.h*(1+2*pad)*esc);
    quadroArte.getContext("2d").drawImage(video, m.x-m.w*pad, m.y-m.h*pad, m.w*(1+2*pad), m.h*(1+2*pad), 0,0, quadroArte.width, quadroArte.height);
    var r={x:m.w*pad*esc, y:m.h*pad*esc, w:m.w*esc, h:m.h*esc};
    var res=porArte(quadroArte,r); if(!res) return;
    res.ms=Math.round(performance.now()-t0);
    cb("aoArte",res);
    est.temposArte.push(res.ms); if(est.temposArte.length>200) est.temposArte.shift();
    est.votosArte.push(res); est.votosArte=est.votosArte.slice(-4);
    if(est.ultimaLeitura) est.ultimaLeitura.arte={carta:res.carta.nome, d:res.d, folga:res.folga};
    var dec=julgarArte(est.votosArte, est.votos);
    if(dec && !est.pausado){
      est.pausado=true;
      marcarMolde("achou");
      var c=null;
      /* semBuscar: a página só precisa do nome (o app); pula a ida ao Scryfall */
      if(!o.semBuscar){ try{ c=await api("/cards/"+dec.carta.set+"/"+encodeURIComponent(dec.carta.num)); }catch(e){} }
      if(!c || c.object!=="card") c={name:dec.carta.nome, set:dec.carta.set, collector_number:dec.carta.num, parcial:true};
      await cb("aoAchar",{carta:c, via:dec.via});
    }
  }

  /* --- caminho do texto (OCR) --- */
  async function laco(g){
    while(est.rodando && g===ger){
      /* O leitor de texto é pesado (~0,5 s por quadro). Nos primeiros 1,2 s
         ele fica de fora para a arte usar o celular inteiro; quase sempre a
         carta já foi reconhecida antes disso. */
      if(est.pausado || !video.videoWidth || !leitor || (BASE_ARTE && Date.now()-est.inicioTentativa<1200)){ await esperar(200); continue; }
      try{ await lerQuadro(); }catch(e){ console.warn(e); }
      await esperar(150);
    }
  }
  async function lerQuadro(){
    var t0=performance.now();
    quadro.width=video.videoWidth; quadro.height=video.videoHeight;
    quadro.getContext("2d").drawImage(video,0,0);
    var est1=ESTRATEGIAS[vez++%ESTRATEGIAS.length];
    var carta=endireitar(cartaCanvas,quadro,retanguloDoMolde(),est1.a,est1.s);
    marcarMolde("lendo");

    var cR=tratar(carta.canvas,faixa(carta,FAIXA_RODAPE,est1.e),160,cRod,true);
    var dR=await ocr(cR,"rodape");
    var cN=tratar(carta.canvas,faixa(carta,FAIXA_NOME,est1.e),90,cNome,false);
    var dN=await ocr(cN,"nome");
    est.quadrosTentativa++;
    var seg=(Date.now()-est.inicioTentativa)/1000;
    cb("aoDica", seg<4 ? "Encaixe a carta no molde, a um palmo do celular"
      : seg<9 ? "Aproxime: a carta tem que encher o molde" : "Tente mais luz, sem reflexo na carta");

    var rod=lerRodape(dR.text), nome=limparNome(dN.text);
    var a=await porRodape(rod.colecao,rod.numero), b=await porNome(nome);
    var via, carta1=a||b, peso;
    if(a&&b&&a.oracle_id===b.oracle_id){ via="as duas leituras concordam"; peso=2; }
    else if(a&&b){ via="CONFLITO"; peso=0; carta1=null; }
    else if(a){ via="só o rodapé"; peso=1; }
    else if(b){ via="só o nome"; peso=1; }
    else { via="nada"; peso=0; }

    est.ultimaLeitura={rodapeBruto:dR.text.trim(), nomeBruto:dN.text.trim(), rod:rod, nome:nome, via:via,
                   cartaRodape:a&&a.name, cartaNome:b&&b.name, ms:Math.round(performance.now()-t0)};
    cb("aoLer",est.ultimaLeitura);

    est.votos.push({ a:a&&a.oracle_id, b:b&&b.oracle_id, cartaA:a, cartaB:b,
                 nota:b?(b.nota||.85):0, em:Date.now() });
    est.votos=est.votos.slice(-8);
    decidir();
  }
  function decidir(){
    if(est.pausado) return;
    var d=julgar(est.votos);
    if(d.aceita){ est.pausado=true; marcarMolde("achou"); cb("aoAchar",{carta:d.carta, via:d.via}); return; }
    if(d.estado==="divergente") cb("aoEstado","leituras divergentes, segure firme","warn");
    else if(d.estado==="quase") cb("aoEstado","quase lá","warn");
    else cb("aoEstado","procurando…","");
  }

  return { est:est, ligar:ligar, desligar:desligar, novaTentativa:novaTentativa,
           pausar:function(){ est.pausado=true; }, marcarMolde:marcarMolde, retanguloDoMolde:retanguloDoMolde };
}

/* ================= preparação ================= */
/* Baixa o que é pesado (índice de artes, leitor de texto, listas do
   Scryfall). Chamado quando a pessoa toca em escanear, não na abertura. */
async function carregarTudo(url){
  var base=url||"";
  var artes=(async function(){
    if(!BASE_ARTE){
      if(!window.ARTES) await carregarScript(base+"artes.js");
      prepararArtes();
    }
  })();
  /* O leitor de texto (Tesseract) é pesado de iniciar. Só começa depois que a
     arte está pronta: assim o celular não divide o esforço entre os dois
     justo no momento em que a arte tenta reconhecer a carta. */
  var texto=(async function(){
    await artes.then(null,function(){});
    await prepararLeitor();
    await carregarColecoes();
    await carregarIndice();
  })();
  /* a arte já basta para escanear; o texto pode falhar (sem internet) */
  var textoPronto=texto.then(function(){ return true; }, function(){ return false; });
  var artesOk=await artes.then(function(){ return !!BASE_ARTE; }, function(){ return false; });
  if(!artesOk && !(await textoPronto)) throw new Error("scanner não carregou");
  return { artes:artesOk, texto:textoPronto };
}

window.Scanner={
  pedidoCamera:PEDIDO_CAMERA,
  config:function(c){ if(c){ if(c.api) cfg.api=c.api; if(c.prefixo) cfg.prefixo=c.prefixo; if(c.carregar) cfg.carregar=c.carregar; } },
  sessao:sessao, carregarTudo:carregarTudo, carregarScript:carregarScript,
  prepararLeitor:prepararLeitor, prepararArtes:prepararArtes, carregarColecoes:carregarColecoes, carregarIndice:carregarIndice,
  ocr:ocr, tratar:tratar, rodapeEstrito:rodapeEstrito, porRodape:porRodape, porNome:porNome, cartaCompleta:cartaCompleta,
  definirColecoes:definirColecoes, definirIndice:function(l){ INDICE=prepararIndice(l); },
  julgar:julgar, julgarArte:julgarArte, lerRodape:lerRodape, limparNome:limparNome, casarNomeLocal:casarNomeLocal,
  porArte:porArte, impressao:impressao, quadroDaCarta:quadroDaCarta, impressaoDoQuadro:impressaoDoQuadro, distanciaArte:distanciaArte,
  indice:function(){ return INDICE.length; }, artes:function(){ return CARTAS_ARTE.length; },
  temArtes:function(){ return !!BASE_ARTE; }, temLeitor:function(){ return !!leitor; }, cartasArte:function(){ return CARTAS_ARTE; }
};
})();
