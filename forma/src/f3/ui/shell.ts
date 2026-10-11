// Casca da interface do FORMA 3: a vista 3D ocupa a tela e a interface flutua
// em ilhas compactas (como o Figma UI3 e o Shapr3D): barra fina em cima,
// ferramentas à esquerda, inspetor à direita, biblioteca em gaveta embaixo e
// uma barra de estado curta. Tema grafite, linhas de 26 px, ícones de 16 px.
import { icon } from './icons';

export const CSS = `
.f3{--canvas:#d9d6cc;--panel:#1d1f23f2;--panel-solid:#1d1f23;--raise:#26292e;--field:#2b2e34;--field-h:#33373e;--line:#33363c;--line-2:#3d4148;
  --ink:#e9eaec;--muted:#a3a8b0;--faint:#737881;--accent:#f07a32;--accent-2:#f07a3229;--accent-ink:#ffb48a;--sel:#5b9cff;--sel-2:#5b9cff26;--danger:#ff7b72;
  --r:10px;--shadow:0 8px 28px #0000004d,0 1px 0 #ffffff0a inset;
  position:absolute;inset:0;display:grid;grid-template-rows:40px 1fr;grid-template-areas:"top" "view";
  font:12px/1.35 Inter,"Segoe UI",system-ui,-apple-system,sans-serif;color:var(--ink);background:var(--panel-solid);user-select:none;overflow:hidden;letter-spacing:.005em}
.f3 *{box-sizing:border-box}
.f3 [hidden]{display:none !important}
.f3 button{font:inherit;color:inherit;cursor:pointer}
.f3 svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round;flex:none}
.f3 ::-webkit-scrollbar{width:8px;height:8px}
.f3 ::-webkit-scrollbar-thumb{background:#ffffff1f;border-radius:8px;border:2px solid transparent;background-clip:padding-box}
.f3 ::-webkit-scrollbar-track{background:transparent}
.f3 *{scrollbar-width:thin;scrollbar-color:#ffffff24 transparent}
/* Barra de cima */
.f3-top{grid-area:top;display:flex;align-items:center;gap:2px;padding:0 8px;background:var(--panel-solid);border-bottom:1px solid #000}
.f3-brand{display:flex;align-items:center;gap:7px;border:0;background:transparent;border-radius:7px;padding:5px 8px;font-weight:800;letter-spacing:.28em;font-size:11px}
.f3-brand:hover,.f3-brand[aria-expanded=true]{background:var(--raise)}
.f3-brand i{width:9px;height:9px;border-radius:2px;background:var(--accent);transform:rotate(45deg);display:block}
.f3-name{border:1px solid transparent;border-radius:6px;padding:4px 6px;font:500 12px Inter,"Segoe UI",system-ui,sans-serif;width:200px;background:transparent;color:var(--ink)}
.f3-name:hover{background:var(--raise)}
.f3-name:focus{border-color:var(--accent);outline:none;background:var(--field)}
.f3-saved{color:var(--faint);font-size:11px;margin-right:8px;white-space:nowrap}
.f3-sp{flex:1}
.f3-tb{display:inline-flex;align-items:center;justify-content:center;gap:6px;border:0;background:transparent;border-radius:7px;height:28px;min-width:28px;padding:0 7px;white-space:nowrap;color:var(--muted)}
.f3-tb:hover{background:var(--raise);color:var(--ink)}
.f3-tb:disabled{opacity:.3;cursor:default;background:transparent}
.f3-tb.primary{background:var(--accent);color:#1b0f06;font-weight:600;padding:0 12px;margin-left:6px}
.f3-tb.primary:hover{background:#ff8b45;color:#1b0f06}
.f3-search{display:flex;align-items:center;gap:8px;border:1px solid var(--line);background:var(--raise);color:var(--faint);border-radius:7px;height:28px;padding:0 8px 0 9px;width:240px}
.f3-search:hover{border-color:var(--line-2);color:var(--muted)}
.f3-search span{flex:1;text-align:left}
.f3 kbd{font:600 10px ui-monospace,Consolas,monospace;border:1px solid var(--line-2);border-radius:4px;padding:1px 4px;color:var(--muted);background:#ffffff08}
/* Vista e ilhas */
.f3-view{grid-area:view;position:relative;overflow:hidden;min-height:0;background:var(--canvas)}
.f3-canvas{position:absolute;inset:0;width:100%;height:100%;display:block;outline:none}
.f3-island{position:absolute;z-index:6;background:var(--panel);border:1px solid #00000059;border-radius:var(--r);box-shadow:var(--shadow);backdrop-filter:blur(10px)}
.f3-tools{left:10px;top:50px;display:flex;flex-direction:column;gap:2px;padding:4px}
.f3-tool{width:32px;height:32px;border:0;border-radius:7px;background:transparent;display:grid;place-items:center;position:relative;color:var(--muted)}
.f3-tool:hover{background:var(--raise);color:var(--ink)}
.f3-tool[aria-pressed=true]{background:var(--accent);color:#1b0f06}
.f3-tool.grp::after{content:"";position:absolute;right:3px;bottom:3px;border:2.5px solid transparent;border-right-color:currentColor;border-bottom-color:currentColor;opacity:.6}
.f3-tools hr{width:20px;border:0;border-top:1px solid var(--line);margin:3px auto}
.f3-fly{position:absolute;z-index:12;min-width:200px;padding:4px}
.f3-fly button{display:flex;align-items:center;gap:9px;width:100%;border:0;background:transparent;border-radius:6px;height:30px;padding:0 8px;color:var(--ink)}
.f3-fly button:hover{background:var(--raise)}
.f3-fly button[aria-pressed=true]{color:var(--accent-ink)}
.f3-fly kbd{margin-left:auto}
.f3-crumb{left:58px;top:10px;display:flex;align-items:center;gap:0;padding:3px}
.f3-crumb button{border:0;background:transparent;border-radius:6px;height:24px;padding:0 8px;font-size:12px;color:var(--muted)}
.f3-crumb button:hover{background:var(--raise);color:var(--ink)}
.f3-crumb button[aria-current=true]{color:var(--ink);font-weight:600}
.f3-crumb i{font-style:normal;color:var(--faint);padding:0 1px}
.f3-aside{right:10px;top:10px;max-height:calc(100% - 20px);width:284px;display:flex;flex-direction:column;overflow:hidden}
.f3-aside.min{bottom:auto}
.f3-aside.min .f3-side,.f3-aside.min .f3-layers{display:none !important}
.f3-tabs{display:flex;align-items:center;gap:2px;padding:4px;border-bottom:1px solid var(--line);flex:none}
.f3-tabs button[role=tab]{border:0;background:transparent;border-radius:6px;height:26px;padding:0 10px;display:flex;align-items:center;gap:6px;font-weight:600;color:var(--faint)}
.f3-tabs button[role=tab]:hover{color:var(--ink)}
.f3-tabs button[aria-selected=true]{background:var(--raise);color:var(--ink)}
.f3-tabs .f3-tb{margin-left:auto;height:26px}
.f3-side,.f3-layers{flex:0 1 auto;overflow:auto;min-height:0}
/* Biblioteca (gaveta) */
.f3-cat{left:58px;right:304px;bottom:48px;height:300px;display:flex;flex-direction:column;overflow:hidden}
.f3-cat.closed{display:none}
.f3-cat-head{display:flex;align-items:center;gap:8px;padding:6px 6px 6px 12px;border-bottom:1px solid var(--line)}
.f3-cat-head b{font-size:12px}
.f3-cat-head input{flex:1;max-width:320px;border:1px solid transparent;border-radius:6px;height:26px;padding:0 8px;font:inherit;background:var(--field);color:var(--ink)}
.f3-cat-head input:focus{outline:none;border-color:var(--accent)}
.f3-cat-head .f3-tb{margin-left:auto}
.f3-cat-body{flex:1;display:flex;min-height:0}
.f3-cat-tabs{width:176px;flex:none;overflow:auto;padding:4px;border-right:1px solid var(--line);display:flex;flex-direction:column;gap:1px}
.f3-cat-tabs button{border:0;background:transparent;border-radius:6px;height:26px;padding:0 9px;text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--muted);flex:none}
.f3-cat-tabs button:hover{background:var(--raise);color:var(--ink)}
.f3-cat-tabs button[aria-pressed=true]{background:var(--accent-2);color:var(--accent-ink);font-weight:600}
.f3-cat-tabs hr{border:0;border-top:1px solid var(--line);margin:4px 2px;width:100%}
.f3-cards{flex:1;overflow:auto;padding:8px;display:grid;grid-template-columns:repeat(auto-fill,minmax(88px,1fr));gap:6px;align-content:start}
.f3-card{border:1px solid transparent;border-radius:8px;background:var(--raise);padding:4px 4px 5px;position:relative;cursor:grab;text-align:center;min-width:0}
.f3-card:hover{border-color:var(--line-2);background:#2d3036}
.f3-card[aria-pressed=true]{border-color:var(--accent);background:var(--accent-2)}
.f3-card img{width:100%;height:60px;object-fit:contain;display:block;border-radius:5px;background:radial-gradient(circle at 50% 35%,#f2f0ea,#cfccc3)}
.f3-blockico{height:60px;display:grid;place-items:center;border-radius:5px;background:radial-gradient(circle at 50% 35%,#3a3e45,#2b2e34);color:var(--accent-ink)}
.f3-blockico svg{width:26px;height:26px;stroke-width:1.4}
.f3-card span{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;font-size:11px;line-height:1.25;height:2.5em;margin-top:4px;overflow:hidden;color:var(--muted);overflow-wrap:anywhere}
.f3-card:hover span{color:var(--ink)}
.f3-card .fav{position:absolute;top:6px;right:6px;border:0;background:#1d1f23cc;border-radius:999px;width:18px;height:18px;display:none;place-items:center;padding:0;color:var(--muted)}
.f3-card:hover .fav,.f3-card .fav[aria-pressed=true]{display:grid}
.f3-card .fav svg{width:11px;height:11px}
.f3-card .fav[aria-pressed=true]{color:#ffc24b}
.f3-card .fav[aria-pressed=true] svg{fill:currentColor}
/* Barra de estado */
.f3-status{left:58px;right:304px;bottom:10px;height:32px;display:flex;align-items:center;gap:4px;padding:0 4px;color:var(--muted);font-size:11.5px;white-space:nowrap}
.f3-hint{overflow:hidden;text-overflow:ellipsis;min-width:0;flex:1;padding-left:4px}
.f3-status .f3-tb{height:24px;min-width:24px;padding:0 6px}
.f3-status .f3-tb[aria-pressed=true]{color:var(--accent-ink);background:var(--accent-2)}
.f3-ctl{display:flex;align-items:center;gap:3px;color:var(--faint)}
.f3-ctl svg{width:14px;height:14px}
.f3-ctl select{border:0;border-radius:5px;height:22px;padding:0 2px;font:inherit;background:transparent;color:var(--muted);cursor:pointer}
.f3-ctl select:hover{background:var(--field);color:var(--ink)}
.f3-stats{color:var(--faint);padding:0 4px}
.f3-vcb{display:flex;align-items:center;gap:6px;border-radius:6px;height:24px;padding:0 6px 0 8px;background:var(--field)}
.f3-vcb label{color:var(--faint)}
.f3-vcb input{width:90px;border:0;background:transparent;font:600 12px ui-monospace,Consolas,monospace;color:var(--ink);outline:none;padding:0}
.f3-sepv{width:1px;height:16px;background:var(--line);margin:0 3px;flex:none}
/* Sobre a vista */
.f3-ctx{position:absolute;z-index:7;display:flex;gap:1px;padding:3px;background:var(--panel);border:1px solid #00000059;border-radius:9px;color:var(--ink);box-shadow:var(--shadow);transform:translateX(-50%);pointer-events:auto}
.f3-ctx button{border:0;background:transparent;color:var(--muted);border-radius:6px;height:28px;min-width:28px;padding:0 6px;display:flex;align-items:center;justify-content:center;gap:5px;font-size:12px}
.f3-ctx button:hover{background:var(--raise);color:var(--ink)}
.f3-ctx button[aria-pressed=true]{background:var(--accent);color:#1b0f06}
.f3-ctx .sep{width:1px;background:var(--line);margin:4px 2px}
.f3-snap{position:absolute;z-index:8;pointer-events:none;font:600 11px Inter,system-ui;padding:2px 6px;border-radius:4px;color:#fff;transform:translate(12px,12px);white-space:nowrap;box-shadow:0 2px 6px #0003}
.f3-dim{position:absolute;z-index:8;pointer-events:none;font:600 11.5px ui-monospace,Consolas,monospace;background:#1d1f23;color:#fff;padding:2px 6px;border-radius:4px;transform:translate(-50%,-50%);white-space:nowrap;box-shadow:0 2px 6px #0003}
.f3-toast{position:absolute;left:58px;bottom:50px;z-index:9;background:var(--panel-solid);border:1px solid var(--line);color:var(--ink);border-radius:8px;padding:7px 11px;font-size:12px;opacity:0;transform:translateY(4px);transition:opacity .18s,transform .18s;pointer-events:none;max-width:420px;box-shadow:var(--shadow)}
.f3-toast.on{opacity:1;transform:none}
.f3-warn{position:absolute;left:50%;top:54px;transform:translateX(-50%);z-index:5;max-width:min(520px,40%);background:#3a2a12f2;border:1px solid #7a5a22;color:#ffd79a;border-radius:8px;padding:5px 10px;font-size:11.5px;display:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;box-shadow:var(--shadow)}
.f3-warn.on{display:block}
.f3-tip{position:fixed;z-index:60;pointer-events:none;background:#0d0e10f2;color:#f3f4f5;border:1px solid #ffffff14;border-radius:6px;padding:4px 8px;font:12px/1.35 Inter,"Segoe UI",system-ui,sans-serif;max-width:280px;box-shadow:0 6px 18px #0006;opacity:0;transition:opacity .12s}
.f3-tip.on{opacity:1}
/* Inspetor */
.f3-title{display:flex;align-items:center;gap:6px;padding:8px 8px 8px 10px;border-bottom:1px solid var(--line);min-height:41px}
.f3-title input{flex:1;min-width:0;font:600 13px Inter,"Segoe UI",system-ui,sans-serif;border:1px solid transparent;border-radius:6px;padding:3px 5px;background:transparent;color:var(--ink)}
.f3-title input:hover{background:var(--raise)}
.f3-title input:focus{border-color:var(--accent);outline:none;background:var(--field)}
.f3-title>span:first-child{flex:1;font-weight:600;font-size:13px;padding-left:5px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.f3-kind{font-size:10.5px;color:var(--muted);background:var(--raise);border-radius:5px;padding:2px 7px;white-space:nowrap}
.f3-sec{border-bottom:1px solid var(--line);padding:2px 10px 10px}
.f3-sec>h3{margin:0 -4px 2px;height:30px;padding:0 4px;font-size:11.5px;font-weight:600;color:var(--ink);display:flex;align-items:center;gap:7px;cursor:pointer;border-radius:5px;letter-spacing:0;text-transform:none}
.f3-sec>h3::before{content:"";width:0;height:0;border:4px solid transparent;border-top-color:var(--faint);margin-top:4px;transition:transform .12s;flex:none}
.f3-sec>h3:hover::before{border-top-color:var(--ink)}
.f3-sec.closed>h3::before{transform:rotate(-90deg);margin-top:0}
.f3-sec.closed{padding-bottom:2px}
.f3-sec.closed>*:not(h3){display:none !important}
.f3-sec>h3>svg{display:none}
.f3-sec>h3 .r{margin-left:auto;display:flex;gap:2px}
.f3-grid2{display:grid;grid-template-columns:1fr 1fr;gap:4px 8px}
.f3-field{display:grid;grid-template-columns:auto minmax(0,1fr);align-items:center;gap:6px;min-width:0;min-height:26px}
.f3-field>span{font-size:11px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:120px}
.f3-field.w{grid-column:1/-1;grid-template-columns:116px minmax(0,1fr)}
.f3-field.w>span{max-width:none;white-space:normal;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;line-height:1.15;overflow-wrap:anywhere}
.f3-field.st{grid-template-columns:minmax(0,1fr);gap:3px}
.f3-field.st>span{-webkit-line-clamp:1}
.f3-in{position:relative;min-width:0;display:block}
.f3-in em{position:absolute;right:7px;top:50%;transform:translateY(-50%);font-style:normal;font-size:10.5px;color:var(--faint);pointer-events:none}
.f3-field input,.f3-field select,.f3-sw select{width:100%;min-width:0;height:24px;border:1px solid transparent;border-radius:5px;padding:0 7px;font:inherit;background:var(--field);color:var(--ink)}
.f3-in input{padding-right:22px;font-variant-numeric:tabular-nums}
.f3-field input:hover,.f3-field select:hover{background:var(--field-h)}
.f3-field input:focus,.f3-field select:focus,.f3-sw select:focus{outline:none;border-color:var(--accent);background:var(--field)}
.f3-field input[type=color]{padding:2px;height:24px;width:40px}
.f3-field.over input,.f3-field.over select{border-color:#5b9cff66;background:#1f2e47}
.f3-field>span.drag{cursor:ew-resize}
.f3 select option{background:#24272c;color:var(--ink)}
.f3-row{display:flex;gap:4px;align-items:center;flex-wrap:wrap}
.f3-seg{display:flex;background:var(--field);border-radius:6px;padding:2px;gap:2px;width:100%}
.f3-seg button{flex:1;border:0;background:transparent;border-radius:4px;height:22px;padding:0 4px;font-size:11.5px;display:flex;align-items:center;justify-content:center;gap:4px;min-width:0;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.f3-seg button:hover{color:var(--ink)}
.f3-seg button[aria-pressed=true]{background:var(--raise);color:var(--ink);box-shadow:0 1px 2px #0005}
.f3-chips{display:grid;grid-template-columns:repeat(6,1fr);gap:2px;background:var(--field);border-radius:6px;padding:2px}
.f3-chip{border:0;background:transparent;border-radius:4px;height:28px;display:grid;place-items:center;color:var(--muted);padding:0}
.f3-chip span{display:none}
.f3-chip:hover{color:var(--ink);background:#ffffff0d}
.f3-chip[aria-pressed=true]{background:var(--raise);color:var(--accent-ink);box-shadow:0 1px 2px #0005}
.f3-btn{border:0;background:var(--raise);border-radius:6px;height:24px;padding:0 9px;display:inline-flex;align-items:center;gap:5px;font-size:11.5px;color:var(--ink);white-space:nowrap}
.f3-btn:hover{background:var(--field-h)}
.f3-btn svg{width:14px;height:14px}
.f3-btn.danger{color:var(--danger)}
.f3-btn.primary{background:var(--accent);color:#1b0f06;font-weight:600}
.f3-btn.ic{width:24px;padding:0;justify-content:center}
.f3-sw{display:grid;grid-template-columns:116px 24px minmax(0,1fr);gap:6px;align-items:center;min-height:26px}
.f3-sw input[type=color]{width:24px;height:22px;border:0;border-radius:5px;padding:0;background:none;cursor:pointer}
.f3-sw>span{font-size:11px;color:var(--muted)}
.f3-pick{width:100%;height:26px;border:1px solid transparent;border-radius:5px;padding:0 6px;font:inherit;background:var(--field);color:var(--ink)}
.f3-pick:focus{outline:none;border-color:var(--accent)}
.f3-swatch{display:flex;align-items:center;gap:6px;color:var(--muted);font-size:11px;cursor:pointer}
.f3-swatch input{width:22px;height:22px;border:0;border-radius:5px;padding:0;background:none;cursor:pointer}
.f3-op{border-top:1px solid var(--line);margin-top:8px;padding-top:6px}
.f3-op h4{margin:0 0 4px;font-size:11px;font-weight:600;color:var(--muted)}
.f3-op .f3-row{justify-content:flex-end;margin-top:4px}
.f3-rule{display:grid;grid-template-columns:minmax(0,1fr) auto auto auto;align-items:center;gap:4px;border-radius:7px;background:var(--raise);padding:5px 6px;margin-bottom:4px}
.f3-rule .t{grid-column:1;min-width:0}
.f3-rule .t b{display:block;font-size:11.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.f3-rule .t small{color:var(--faint);font-size:10.5px;display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.f3-rule>.f3-grid2,.f3-rule>.f3-row{grid-column:1/-1}
.f3-rule select,.f3-rule input{height:22px;border:0;border-radius:5px;padding:0 6px;font:inherit;background:var(--field);color:var(--ink);min-width:0}
.f3-rule .f3-btn{height:22px}
.f3-empty{color:var(--muted);font-size:11.5px;padding:14px 12px;line-height:1.55}
.f3-empty b{color:var(--ink)}
.f3-keys{display:grid;grid-template-columns:auto 1fr;gap:6px 10px;align-items:center;margin-top:12px}
/* Camadas */
.f3-lrow{display:flex;align-items:center;gap:3px;padding:0 4px;border-radius:5px;height:26px}
.f3-lrow:hover{background:var(--raise)}
.f3-lrow[aria-selected=true]{background:var(--sel-2)}
.f3-lrow .nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer}
.f3-lrow input.nm{border:1px solid transparent;border-radius:4px;height:22px;padding:0 4px;font:inherit;background:transparent;color:var(--ink);cursor:text}
.f3-lrow input.nm:focus{border-color:var(--accent);outline:none;background:var(--field)}
.f3-lrow .ic{border:0;background:transparent;border-radius:4px;width:22px;height:22px;display:grid;place-items:center;color:var(--muted);padding:0;flex:none;opacity:0}
.f3-lrow:hover .ic,.f3-lrow .ic[aria-pressed=false],.f3-lrow .ic.on{opacity:1}
.f3-lrow .ic:hover{background:var(--field-h);color:var(--ink)}
.f3-lrow .ic[aria-pressed=false]{color:var(--faint)}
.f3-lrow .ic svg{width:14px;height:14px}
.f3-lrow input[type=color]{width:14px;height:14px;border:0;padding:0;background:none;flex:none;border-radius:3px;cursor:pointer}
.f3-lrow select{max-width:84px;height:20px;border:0;border-radius:4px;font:inherit;font-size:10.5px;padding:0 2px;background:transparent;color:var(--faint)}
.f3-lrow:hover select{background:var(--field);color:var(--ink)}
.f3-lrow .op{width:14px;text-align:center;font-weight:700;color:var(--faint);flex:none}
.f3-lrow small{color:var(--faint);font-size:10.5px;min-width:14px;text-align:right}
.f3-lrow.sub{padding-left:20px}
.f3-lrow.sub2{padding-left:34px;color:var(--muted)}
.f3-lrow.off .nm{color:var(--faint);text-decoration:line-through}
/* Janelas */
.f3-modal{position:absolute;inset:0;background:#0009;z-index:40;display:grid;place-items:start center;padding-top:12vh}
.f3-modal>div{background:var(--panel-solid);border:1px solid var(--line);border-radius:12px;max-width:min(720px,92vw);max-height:76vh;overflow:auto;padding:16px 18px;box-shadow:0 24px 70px #000a;color:var(--ink)}
.f3-help h2{margin:0 0 10px;font-size:16px}
.f3-help .cols{display:grid;grid-template-columns:1fr 1fr;gap:6px 22px;font-size:12px}
.f3-menu{position:absolute;z-index:30;background:var(--panel-solid);border:1px solid var(--line);border-radius:9px;box-shadow:0 14px 40px #0008;padding:4px;min-width:210px;color:var(--ink)}
.f3-menu button{display:flex;width:100%;border:0;background:transparent;border-radius:6px;height:30px;padding:0 9px;gap:9px;align-items:center;text-align:left;color:var(--ink);letter-spacing:0;font-weight:400}
.f3-menu button:hover{background:var(--raise)}
.f3-menu small,.f3-menu kbd{margin-left:auto;color:var(--faint)}
.f3-menu hr{border:0;border-top:1px solid var(--line);margin:4px 2px}
.f3-pal{width:min(560px,92vw);padding:0 !important;overflow:hidden !important;display:flex;flex-direction:column}
.f3-pal input{border:0;border-bottom:1px solid var(--line);background:transparent;color:var(--ink);font:14px Inter,"Segoe UI",system-ui,sans-serif;padding:14px 16px;outline:none}
.f3-pal ul{list-style:none;margin:0;padding:4px;overflow:auto;max-height:52vh}
.f3-pal li{display:flex;align-items:center;gap:10px;height:32px;padding:0 10px;border-radius:6px;cursor:pointer}
.f3-pal li[aria-selected=true]{background:var(--accent-2)}
.f3-pal li small{margin-left:auto;color:var(--faint)}
.f3-pal li em{font-style:normal;color:var(--faint);font-size:11px}
`;

export interface Shell3 {
  root: HTMLElement;
  view: HTMLElement;
  side: HTMLElement;
  layers: HTMLElement;
  tabs: HTMLElement;
  aside: HTMLElement;
  cat: HTMLElement;
  tools: HTMLElement;
  status: { hint: HTMLElement; vcbLabel: HTMLElement; vcb: HTMLInputElement; stats: HTMLElement; bar: HTMLElement };
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
    <button class="f3-brand" aria-haspopup="menu" aria-expanded="false" title="Projeto: novo, abrir, salvar, modelos"><i></i>FORMA</button>
    <input class="f3-name" aria-label="Nome do projeto" value="Projeto sem título">
    <span class="f3-saved"></span>
    <button class="f3-tb" data-cmd="undo" title="Desfazer · Ctrl+Z" aria-label="Desfazer">${icon('undo')}</button>
    <button class="f3-tb" data-cmd="redo" title="Refazer · Ctrl+Y" aria-label="Refazer">${icon('redo')}</button>
    <span class="f3-sp"></span>
    <button class="f3-search" data-cmd="palette" title="Buscar ferramentas, comandos e componentes">${icon('search')}<span>Buscar comandos</span><kbd>Ctrl K</kbd></button>
    <span class="f3-sp"></span>
    <button class="f3-tb" data-cmd="help" title="Atalhos · ?" aria-label="Atalhos">${icon('help')}</button>
    <button class="f3-tb primary" data-cmd="export" title="Exportar GLB, OBJ, jogo, imagem">${icon('export')}<span>Exportar</span></button>
    <div class="f3-menu" data-menu-of="project" role="menu" hidden>
      <button data-cmd="new" role="menuitem">${icon('folder')}Novo projeto</button>
      <button data-cmd="open" role="menuitem">${icon('open')}Abrir…</button>
      <button data-cmd="save" role="menuitem">${icon('save')}Salvar<kbd>Ctrl S</kbd></button>
      <hr><button data-cmd="templates" role="menuitem">${icon('template')}Modelos prontos</button>
    </div>
  </header>
  <main class="f3-view">
    <nav class="f3-tools f3-island" aria-label="Ferramentas"></nav>
    <div class="f3-crumb f3-island"></div>
    <div class="f3-ctx" hidden></div>
    <div class="f3-snap" hidden></div>
    <div class="f3-dim" hidden></div>
    <div class="f3-toast" role="status"></div>
    <div class="f3-warn" role="alert"></div>
    <aside class="f3-aside f3-island">
      <div class="f3-tabs" role="tablist"><button role="tab" data-tab="props" aria-selected="true">Propriedades</button><button role="tab" data-tab="layers" aria-selected="false">Camadas</button><button class="f3-tb" data-aside="min" title="Recolher o painel">${icon('minus')}</button></div>
      <div class="f3-side" role="tabpanel" aria-label="Propriedades"></div>
      <div class="f3-layers" role="tabpanel" aria-label="Camadas e elementos" hidden></div>
    </aside>
    <section class="f3-cat f3-island closed" aria-label="Biblioteca"></section>
    <footer class="f3-status f3-island">
      <button class="f3-tb" data-cmd="library" title="Biblioteca: blocos e componentes · K">${icon('catalog')}<span>Biblioteca</span></button>
      <span class="f3-sepv"></span>
      <span class="f3-hint"></span>
      <span class="f3-stats"></span>
      <span class="f3-vcb" title="Digite um valor e Enter durante ou logo depois de uma operação (10, 10x8, 5x)"><label>Medidas</label><input aria-label="Medidas" spellcheck="false" autocomplete="off"></span>
      <label class="f3-ctl" title="Passo da grade e do encaixe">${icon('grid')}<select data-grid><option value="0.05">5 cm</option><option value="0.1">10 cm</option><option value="0.25">25 cm</option><option value="0.5" selected>50 cm</option><option value="1">1 m</option><option value="2">2 m</option><option value="5">5 m</option></select></label>
      <label class="f3-ctl" title="Passo do giro">${icon('rotate')}<select data-rot><option value="1">1°</option><option value="5">5°</option><option value="15" selected>15°</option><option value="30">30°</option><option value="45">45°</option><option value="90">90°</option></select></label>
      <span class="f3-sepv"></span>
      <button class="f3-tb" data-cmd="snap" title="Encaixe · G">${icon('magnet')}</button>
      <button class="f3-tb" data-cmd="frame" title="Enquadrar · F">${icon('focus')}</button>
    </footer>
  </main>
  <input type="file" accept=".json,application/json" hidden data-file="project">
  <input type="file" accept=".json,application/json" hidden data-file="component">`;
  container.appendChild(root);
  const $ = <T extends HTMLElement>(s: string) => root.querySelector(s) as T;
  // Menu do projeto (na marca).
  const brand = $('.f3-brand');
  const pmenu = $('[data-menu-of="project"]');
  const closeMenu = () => {
    pmenu.hidden = true;
    brand.setAttribute('aria-expanded', 'false');
  };
  brand.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = pmenu.hidden;
    pmenu.hidden = !open;
    brand.setAttribute('aria-expanded', String(open));
    if (open) {
      const r = brand.getBoundingClientRect(),
        rr = root.getBoundingClientRect();
      pmenu.style.left = `${r.left - rr.left}px`;
      pmenu.style.top = `${r.bottom - rr.top + 4}px`;
    }
  });
  pmenu.addEventListener('click', closeMenu);
  doc.addEventListener('pointerdown', (e) => {
    if (!pmenu.hidden && !pmenu.contains(e.target as Node) && !brand.contains(e.target as Node)) closeMenu();
  });
  const aside = $('.f3-aside');
  $('[data-aside="min"]').addEventListener('click', () => aside.classList.toggle('min'));
  installTooltips(root);
  return {
    root,
    view: $('.f3-view'),
    side: $('.f3-side'),
    layers: $('.f3-layers'),
    tabs: $('.f3-tabs'),
    aside,
    cat: $('.f3-cat'),
    tools: $('.f3-tools'),
    status: { hint: $('.f3-hint'), vcbLabel: $('.f3-vcb label'), vcb: $('.f3-vcb input'), stats: $('.f3-stats'), bar: $('.f3-status') },
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

/**
 * Dicas próprias no lugar do `title` nativo (que demora e destoa): o título
 * vira `data-tip` na primeira passagem do mouse e aparece num balão escuro.
 */
function installTooltips(root: HTMLElement): void {
  const doc = root.ownerDocument;
  const tip = doc.createElement('div');
  tip.className = 'f3-tip';
  root.appendChild(tip);
  let timer = 0;
  let cur: HTMLElement | null = null;
  const hide = () => {
    clearTimeout(timer);
    tip.classList.remove('on');
    cur = null;
  };
  root.addEventListener('pointerover', (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[title],[data-tip]');
    if (!el || !root.contains(el)) return hide();
    if (el.title) {
      el.dataset.tip = el.title;
      el.removeAttribute('title');
    }
    if (el === cur) return;
    hide();
    cur = el;
    timer = window.setTimeout(() => {
      if (!cur || !cur.isConnected) return;
      tip.textContent = cur.dataset.tip ?? '';
      const r = cur.getBoundingClientRect();
      tip.classList.add('on');
      const tw = tip.offsetWidth,
        th = tip.offsetHeight;
      let x = r.left + r.width / 2 - tw / 2,
        y = r.bottom + 6;
      // Ferramentas à esquerda: balão do lado direito.
      if (cur.closest('.f3-tools')) {
        x = r.right + 8;
        y = r.top + r.height / 2 - th / 2;
      }
      if (y + th > innerHeight - 4) y = r.top - th - 6;
      tip.style.left = `${Math.max(4, Math.min(innerWidth - tw - 4, x))}px`;
      tip.style.top = `${Math.max(4, y)}px`;
    }, 380);
  });
  root.addEventListener('pointerleave', hide);
  root.addEventListener('pointerdown', hide);
}
