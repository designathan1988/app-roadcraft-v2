// Casca da interface do FORMA 3: barra superior, ferramentas, vista, inspetor
// contextual, catálogo e barra de estado. Estilo próprio, compacto.
import { icon } from './icons';

export const CSS = `
.f3{--bg:#f4f3ef;--panel:#ffffff;--ink:#1f2326;--muted:#6b7177;--line:#e3e1db;--accent:#e2702a;--accent-2:#fbe7da;--sel:#2f7de1;
  position:absolute;inset:0;display:grid;grid-template-columns:52px 1fr 300px;grid-template-rows:46px 1fr auto 30px;
  grid-template-areas:"top top top" "tools view side" "tools cat side" "status status status";
  font:13px/1.35 system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--ink);background:var(--bg);user-select:none;overflow:hidden}
.f3 *{box-sizing:border-box}
.f3 [hidden]{display:none !important}
.f3 button{font:inherit;color:inherit;cursor:pointer}
.f3 svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round;flex:none}
.f3-top{grid-area:top;display:flex;align-items:center;gap:6px;padding:0 10px;background:var(--panel);border-bottom:1px solid var(--line)}
.f3-logo{font-weight:800;letter-spacing:.32em;margin-right:8px}
.f3-name{border:1px solid transparent;border-radius:6px;padding:4px 6px;font:inherit;width:180px;background:transparent}
.f3-name:hover,.f3-name:focus{border-color:var(--line);outline:none}
.f3-sp{flex:1}
.f3-tb{display:inline-flex;align-items:center;gap:6px;border:0;background:transparent;border-radius:7px;padding:6px 9px;white-space:nowrap}
.f3-tb:hover{background:#efeee9}
.f3-tb:disabled{opacity:.35;cursor:default;background:transparent}
.f3-tb.primary{background:var(--ink);color:#fff}
.f3-tools{grid-area:tools;background:var(--panel);border-right:1px solid var(--line);display:flex;flex-direction:column;align-items:center;gap:2px;padding:6px 0;overflow:auto}
.f3-tool{width:40px;height:38px;border:0;border-radius:8px;background:transparent;display:grid;place-items:center;position:relative}
.f3-tool:hover{background:#f0efea}
.f3-tool[aria-pressed=true]{background:var(--accent-2);color:var(--accent)}
.f3-tool .k{position:absolute;right:3px;bottom:1px;font-size:9px;color:var(--muted)}
.f3-tools hr{width:28px;border:0;border-top:1px solid var(--line);margin:4px 0}
.f3-view{grid-area:view;position:relative;overflow:hidden;min-height:0}
.f3-canvas{position:absolute;inset:0;width:100%;height:100%;display:block;outline:none}
.f3-aside{grid-area:side;background:var(--panel);border-left:1px solid var(--line);display:flex;flex-direction:column;min-height:0}
.f3-tabs{display:flex;border-bottom:1px solid var(--line);flex:none}
.f3-tabs button{flex:1;border:0;background:transparent;padding:8px 6px;display:flex;align-items:center;justify-content:center;gap:6px;font-size:12px;color:var(--muted);border-bottom:2px solid transparent}
.f3-tabs button[aria-selected=true]{color:var(--ink);border-bottom-color:var(--accent)}
.f3-side,.f3-layers{flex:1;overflow:auto;min-height:0}
.f3-lrow{display:flex;align-items:center;gap:4px;padding:3px 6px;border-radius:6px;min-height:28px}
.f3-lrow:hover{background:#f4f3ef}
.f3-lrow[aria-selected=true]{background:#e8f0fc}
.f3-lrow .nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer}
.f3-lrow input.nm{border:1px solid transparent;border-radius:4px;padding:2px 4px;font:inherit;background:transparent;cursor:text}
.f3-lrow input.nm:focus{border-color:var(--line);outline:none;background:#fff}
.f3-lrow .ic{border:0;background:transparent;border-radius:5px;width:24px;height:24px;display:grid;place-items:center;color:var(--muted);padding:0;flex:none}
.f3-lrow .ic:hover{background:#e9e7e1;color:var(--ink)}
.f3-lrow .ic[aria-pressed=false]{opacity:.35}
.f3-lrow .ic svg{width:15px;height:15px}
.f3-lrow input[type=color]{width:18px;height:18px;border:0;padding:0;background:none;flex:none}
.f3-lrow select{max-width:92px;border:1px solid var(--line);border-radius:5px;font:inherit;font-size:11px;padding:1px 2px;background:#fbfbf9}
.f3-lrow .op{width:16px;text-align:center;font-weight:700;color:var(--muted);flex:none}
.f3-lrow.sub{padding-left:22px}
.f3-lrow.sub2{padding-left:38px;font-size:12px}
.f3-lrow.off .nm{color:var(--muted);text-decoration:line-through}
.f3-cat{grid-area:cat;background:var(--panel);border-top:1px solid var(--line);min-width:0}
.f3-status{grid-area:status;display:flex;align-items:center;gap:12px;padding:0 10px;background:var(--panel);border-top:1px solid var(--line);color:var(--muted);font-size:12px;white-space:nowrap;overflow:hidden}
.f3-hint{overflow:hidden;text-overflow:ellipsis}
.f3-ctl{display:flex;align-items:center;gap:4px}
.f3-ctl select{border:1px solid var(--line);border-radius:6px;padding:1px 4px;font:inherit;background:#fafaf8;color:var(--ink)}
.f3-vcb{display:flex;align-items:center;gap:6px;border:1px solid var(--line);border-radius:6px;padding:1px 4px 1px 8px;background:#fafaf8}
.f3-vcb label{color:var(--muted)}
.f3-vcb input{width:110px;border:0;background:transparent;font:600 12px ui-monospace,monospace;color:var(--ink);outline:none;padding:3px 0}
.f3-crumb{display:flex;align-items:center;gap:4px;position:absolute;left:10px;top:10px;z-index:5}
.f3-crumb button{border:1px solid var(--line);background:#fffffff0;border-radius:999px;padding:3px 10px;font-size:12px}
.f3-crumb button[aria-current=true]{background:var(--ink);color:#fff;border-color:var(--ink)}
.f3-ctx{position:absolute;z-index:6;display:flex;gap:2px;padding:3px;background:#1f2326f2;border-radius:10px;color:#fff;box-shadow:0 6px 20px #0003;transform:translate(-50%,-100%);pointer-events:auto}
.f3-ctx button{border:0;background:transparent;color:#fff;border-radius:7px;padding:6px 8px;display:flex;align-items:center;gap:5px;font-size:12px}
.f3-ctx button:hover{background:#ffffff22}
.f3-ctx button[aria-pressed=true]{background:var(--accent)}
.f3-ctx .sep{width:1px;background:#ffffff33;margin:3px 2px}
.f3-snap{position:absolute;z-index:7;pointer-events:none;font:600 11px system-ui;padding:2px 6px;border-radius:4px;color:#fff;transform:translate(10px,10px);white-space:nowrap}
.f3-dim{position:absolute;z-index:7;pointer-events:none;font:600 12px ui-monospace,monospace;background:#1f2326;color:#fff;padding:2px 6px;border-radius:4px;transform:translate(-50%,-50%);white-space:nowrap}
.f3-toast{position:absolute;left:50%;bottom:14px;transform:translateX(-50%);z-index:9;background:#1f2326;color:#fff;border-radius:8px;padding:7px 12px;font-size:12px;opacity:0;transition:opacity .2s;pointer-events:none;max-width:70%;text-align:center}
.f3-toast.on{opacity:1}
.f3-warn{position:absolute;right:10px;bottom:10px;z-index:5;max-width:min(420px,60%);background:#fff7e6;border:1px solid #f1c27d;color:#7a4b00;border-radius:8px;padding:6px 10px;font-size:12px;display:none}
.f3-warn.on{display:block}
/* Inspetor */
.f3-sec{border-bottom:1px solid var(--line);padding:10px 12px}
.f3-sec h3{margin:0 0 8px;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);display:flex;align-items:center;gap:6px}
.f3-sec h3 .r{margin-left:auto;text-transform:none;letter-spacing:0}
.f3-title{display:flex;align-items:center;gap:8px;padding:12px;border-bottom:1px solid var(--line)}
.f3-title input{flex:1;min-width:0;font:600 14px system-ui;border:1px solid transparent;border-radius:6px;padding:4px 6px;background:transparent}
.f3-title input:hover,.f3-title input:focus{border-color:var(--line);outline:none}
.f3-kind{font-size:11px;color:var(--muted);background:#f1f0ec;border-radius:999px;padding:2px 8px;white-space:nowrap}
.f3-grid2{display:grid;grid-template-columns:1fr 1fr;gap:6px 8px}
.f3-field{display:flex;flex-direction:column;gap:3px;min-width:0}
.f3-field>span{font-size:11px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.f3-field input,.f3-field select{width:100%;min-width:0;border:1px solid var(--line);border-radius:6px;padding:5px 7px;font:inherit;background:#fbfbf9}
.f3-field input:focus,.f3-field select:focus{outline:2px solid #e2702a55;border-color:var(--accent)}
.f3-field.over input,.f3-field.over select{border-color:#2f7de1;background:#eef5ff}
.f3-row{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.f3-seg{display:flex;border:1px solid var(--line);border-radius:8px;overflow:hidden;width:100%}
.f3-seg button{flex:1;border:0;background:#fbfbf9;padding:6px 4px;font-size:12px;display:flex;flex-direction:column;align-items:center;gap:2px;min-width:0}
.f3-seg button+button{border-left:1px solid var(--line)}
.f3-seg button[aria-pressed=true]{background:var(--accent-2);color:var(--accent);font-weight:600}
.f3-chips{display:grid;grid-template-columns:repeat(4,1fr);gap:4px}
.f3-chip{border:1px solid var(--line);background:#fbfbf9;border-radius:8px;padding:6px 2px;font-size:10.5px;display:flex;flex-direction:column;align-items:center;gap:3px;min-width:0;line-height:1.1;text-align:center}
.f3-chip[aria-pressed=true]{border-color:var(--accent);background:var(--accent-2);color:#9a4314;font-weight:600}
.f3-btn{border:1px solid var(--line);background:#fbfbf9;border-radius:7px;padding:5px 9px;display:inline-flex;align-items:center;gap:5px;font-size:12px}
.f3-btn:hover{background:#f1f0ec}
.f3-btn.danger{color:#b42318}
.f3-btn.primary{background:var(--ink);color:#fff;border-color:var(--ink)}
.f3-sw{display:flex;gap:6px;align-items:center}
.f3-sw input[type=color]{width:30px;height:26px;border:1px solid var(--line);border-radius:6px;padding:1px;background:#fff}
.f3-sw select{flex:1;min-width:0;border:1px solid var(--line);border-radius:6px;padding:4px 6px;font:inherit;background:#fbfbf9}
.f3-sw>span{width:46px;font-size:11px;color:var(--muted)}
.f3-op{border:1px solid var(--line);border-radius:8px;padding:8px;margin-top:8px}
.f3-op h4{margin:0 0 6px;font-size:11px;font-weight:600;color:var(--muted);text-transform:none}
.f3-rule{display:grid;grid-template-columns:1fr auto auto auto;align-items:center;gap:6px;border:1px solid var(--line);border-radius:8px;padding:6px;margin-bottom:6px}
.f3-rule .t{grid-column:1/-1}
.f3-rule select,.f3-rule input{border:1px solid var(--line);border-radius:6px;padding:4px 6px;font:inherit;background:#fbfbf9;min-width:0}
.f3-rule img{width:34px;height:34px;border-radius:6px;background:#f1f0ec;flex:none}
.f3-rule .t{flex:1;min-width:0}
.f3-rule .t b{display:block;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.f3-rule .t small{color:var(--muted)}
.f3-rule[aria-current=true]{border-color:var(--accent);background:#fff8f3}
.f3-empty{color:var(--muted);font-size:12px;padding:16px 12px;line-height:1.5}
.f3-empty kbd,.f3-help kbd{font:600 11px ui-monospace,monospace;border:1px solid var(--line);border-bottom-width:2px;border-radius:4px;padding:0 4px;background:#fff}
/* Catálogo */
.f3-cat-head{display:flex;align-items:center;gap:8px;padding:6px 10px;border-bottom:1px solid var(--line)}
.f3-cat-head input{width:200px;border:1px solid var(--line);border-radius:7px;padding:5px 8px;font:inherit;background:#fbfbf9}
.f3-cat-tabs{display:flex;gap:2px;overflow-x:auto;scrollbar-width:thin;min-width:0;flex:1}
.f3-cat-tabs button{border:0;background:transparent;border-radius:999px;padding:4px 10px;font-size:12px;white-space:nowrap}
.f3-cat-tabs button[aria-pressed=true]{background:var(--ink);color:#fff}
.f3-cards{display:flex;gap:8px;padding:8px 10px;overflow-x:auto;scrollbar-width:thin}
.f3-card{flex:none;width:96px;border:1px solid var(--line);border-radius:10px;background:#fbfbf9;padding:4px;position:relative;cursor:grab;text-align:center}
.f3-card:hover{border-color:#cfccc4;background:#fff}
.f3-card[aria-pressed=true]{border-color:var(--accent);box-shadow:0 0 0 2px var(--accent-2)}
.f3-card img{width:86px;height:70px;object-fit:contain;display:block;margin:0 auto;border-radius:6px;background:linear-gradient(#f3f2ee,#e9e8e3)}
.f3-blockico{width:86px;height:70px;display:grid;place-items:center;border-radius:6px;background:linear-gradient(#f3f2ee,#e6e4dd);color:#7a4a2a}
.f3-blockico svg{width:38px;height:38px;stroke-width:1.3}
.f3-card span{display:block;font-size:11px;line-height:1.2;margin-top:3px;height:2.4em;overflow:hidden}
.f3-card .fav{position:absolute;top:4px;right:4px;border:0;background:#ffffffd9;border-radius:999px;width:20px;height:20px;display:grid;place-items:center;padding:0;color:#b9b5ab}
.f3-card .fav svg{width:12px;height:12px}
.f3-card .fav[aria-pressed=true]{color:#e2a21a}
.f3-card .fav[aria-pressed=true] svg{fill:currentColor}
.f3-cat.closed .f3-cards{display:none}
.f3-modal{position:absolute;inset:0;background:#0006;z-index:20;display:grid;place-items:center}
.f3-modal>div{background:#fff;border-radius:12px;max-width:min(720px,92vw);max-height:86vh;overflow:auto;padding:18px 20px;box-shadow:0 20px 60px #0004}
.f3-help h2{margin:0 0 10px;font-size:18px}
.f3-help .cols{display:grid;grid-template-columns:1fr 1fr;gap:6px 22px;font-size:13px}
.f3-menu{position:absolute;z-index:30;background:#fff;border:1px solid var(--line);border-radius:10px;box-shadow:0 10px 30px #0002;padding:4px;min-width:200px}
.f3-menu button{display:flex;width:100%;border:0;background:transparent;border-radius:7px;padding:7px 9px;gap:8px;align-items:center;text-align:left}
.f3-menu button:hover{background:#f1f0ec}
.f3-menu small{margin-left:auto;color:var(--muted)}
`;

export interface Shell3 {
  root: HTMLElement;
  view: HTMLElement;
  side: HTMLElement;
  layers: HTMLElement;
  tabs: HTMLElement;
  cat: HTMLElement;
  tools: HTMLElement;
  status: { hint: HTMLElement; vcbLabel: HTMLElement; vcb: HTMLInputElement; stats: HTMLElement };
  crumb: HTMLElement;
  ctxbar: HTMLElement;
  snap: HTMLElement;
  dim: HTMLElement;
  toast: HTMLElement;
  warn: HTMLElement;
  name: HTMLInputElement;
  top: HTMLElement;
}

export function createShell3(container: HTMLElement): Shell3 {
  const doc = container.ownerDocument;
  if (!doc.getElementById('f3-css')) {
    const st = doc.createElement('style');
    st.id = 'f3-css';
    st.textContent = CSS;
    doc.head.appendChild(st);
  }
  const root = doc.createElement('div');
  root.className = 'f3';
  root.innerHTML = `
  <header class="f3-top">
    <span class="f3-logo">FORMA</span>
    <input class="f3-name" aria-label="Nome do projeto" value="Projeto sem título">
    <button class="f3-tb" data-cmd="undo" title="Desfazer · Ctrl+Z" aria-label="Desfazer">${icon('undo')}</button>
    <button class="f3-tb" data-cmd="redo" title="Refazer · Ctrl+Y" aria-label="Refazer">${icon('redo')}</button>
    <span class="f3-sp"></span>
    <button class="f3-tb" data-cmd="templates" title="Modelos prontos">${icon('template')}<span>Modelos</span></button>
    <button class="f3-tb" data-cmd="new" title="Projeto novo">${icon('folder')}<span>Novo</span></button>
    <button class="f3-tb" data-cmd="open" title="Abrir projeto (.json)">${icon('open')}<span>Abrir</span></button>
    <button class="f3-tb" data-cmd="save" title="Salvar projeto (.json) · Ctrl+S">${icon('save')}<span>Salvar</span></button>
    <button class="f3-tb primary" data-cmd="export" title="Exportar">${icon('export')}<span>Exportar</span></button>
    <button class="f3-tb" data-cmd="help" title="Ajuda · ?" aria-label="Ajuda">${icon('help')}</button>
  </header>
  <nav class="f3-tools" aria-label="Ferramentas"></nav>
  <main class="f3-view">
    <div class="f3-crumb"></div>
    <div class="f3-ctx" hidden></div>
    <div class="f3-snap" hidden></div>
    <div class="f3-dim" hidden></div>
    <div class="f3-toast" role="status"></div>
    <div class="f3-warn" role="alert"></div>
  </main>
  <aside class="f3-aside">
    <div class="f3-tabs" role="tablist"><button role="tab" data-tab="props" aria-selected="true">${icon('props')}Propriedades</button><button role="tab" data-tab="layers" aria-selected="false">${icon('layers')}Camadas</button></div>
    <div class="f3-side" role="tabpanel" aria-label="Propriedades"></div>
    <div class="f3-layers" role="tabpanel" aria-label="Camadas e elementos" hidden></div>
  </aside>
  <section class="f3-cat" aria-label="Catálogo"></section>
  <footer class="f3-status">
    <span class="f3-hint"></span>
    <span class="f3-sp"></span>
    <label class="f3-ctl" title="Passo da grade e do encaixe">Grade <select data-grid><option value="0.05">5 cm</option><option value="0.1">10 cm</option><option value="0.25">25 cm</option><option value="0.5" selected>50 cm</option><option value="1">1 m</option><option value="2">2 m</option><option value="5">5 m</option></select></label>
    <label class="f3-ctl" title="Passo do giro">Giro <select data-rot><option value="1">1°</option><option value="5">5°</option><option value="15" selected>15°</option><option value="30">30°</option><option value="45">45°</option><option value="90">90°</option></select></label>
    <span class="f3-stats"></span>
    <span class="f3-vcb" title="Digite um valor e Enter durante ou logo depois de uma operação"><label>Medidas</label><input aria-label="Medidas" spellcheck="false" autocomplete="off"></span>
  </footer>
  <input type="file" accept=".json,application/json" hidden data-file="project">
  <input type="file" accept=".json,application/json" hidden data-file="component">`;
  container.appendChild(root);
  const $ = <T extends HTMLElement>(s: string) => root.querySelector(s) as T;
  return {
    root,
    view: $('.f3-view'),
    side: $('.f3-side'),
    layers: $('.f3-layers'),
    tabs: $('.f3-tabs'),
    cat: $('.f3-cat'),
    tools: $('.f3-tools'),
    status: { hint: $('.f3-hint'), vcbLabel: $('.f3-vcb label'), vcb: $('.f3-vcb input'), stats: $('.f3-stats') },
    crumb: $('.f3-crumb'),
    ctxbar: $('.f3-ctx'),
    snap: $('.f3-snap'),
    dim: $('.f3-dim'),
    toast: $('.f3-toast'),
    warn: $('.f3-warn'),
    name: $('.f3-name'),
    top: $('.f3-top'),
  };
}
