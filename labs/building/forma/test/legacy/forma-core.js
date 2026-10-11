
(function(root){
 'use strict';
 const clip=typeof module!=='undefined'?require('./polygon-clipping.js'):root.polygonClipping;
 const clone=v=>JSON.parse(JSON.stringify(v));
 const clamp=(v,a,b)=>Math.max(a,Math.min(b,Number(v)));
 const signedArea=p=>p.reduce((s,a,i)=>{const b=p[(i+1)%p.length];return s+a[0]*b[1]-b[0]*a[1];},0)/2;
 const area=p=>Math.abs(signedArea(p));
 const cross=(a,b,c)=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
 function validPolygon(p){
  if(!Array.isArray(p)||p.length<3||p.length>128||p.some(a=>!Array.isArray(a)||a.length!==2||a.some(n=>!Number.isFinite(n)||Math.abs(n)>500)))return false;
  if(area(p)<.12)return false;
  for(let i=0;i<p.length;i++){const a=p[i],b=p[(i+1)%p.length];if(Math.hypot(a[0]-b[0],a[1]-b[1])<.02)return false;
   for(let j=i+2;j<p.length;j++){if(i===0&&j===p.length-1)continue;const c=p[j],d=p[(j+1)%p.length];if(cross(a,b,c)*cross(a,b,d)<-1e-8&&cross(c,d,a)*cross(c,d,b)<-1e-8)return false;}
  }return true;
 }
 function clean(p){const q=p.map(a=>[+a[0],+a[1]]);if(q.length>1&&q[0][0]===q.at(-1)[0]&&q[0][1]===q.at(-1)[1])q.pop();if(signedArea(q)<0)q.reverse();return q;}
 function validHoles(points,holes){try{for(let i=0;i<holes.length;i++){const h=holes[i];if(!validPolygon(h))return false;const inside=clip.intersection([points],[h]).reduce((s,p)=>s+area(p[0])-p.slice(1).reduce((s,r)=>s+area(r),0),0);if(Math.abs(inside-area(h))>.0001)return false;for(let j=0;j<i;j++){if(clip.intersection([h],[holes[j]]).some(p=>area(p[0])>.0001))return false;}}return true;}catch(e){return false;}}
 const bounds=p=>({minX:Math.min(...p.map(a=>a[0])),maxX:Math.max(...p.map(a=>a[0])),minZ:Math.min(...p.map(a=>a[1])),maxZ:Math.max(...p.map(a=>a[1]))});
 const uid=()=>typeof crypto!=='undefined'&&crypto.randomUUID?crypto.randomUUID():'v'+Date.now().toString(36)+Math.random().toString(36).slice(2,8);
 function volume(input={}){return Object.assign({id:uid(),name:'Volume',points:[[-5,-4],[5,-4],[5,4],[-5,4]],holes:[],x:0,z:0,rotation:0,base:0,height:9.6,floors:3,color:'#b77b56',roof:'flat',roofColor:'#474c4e',roofHeight:2.3,facade:'regular',windowWidth:1.35,windowHeight:1.8,spacing:2.5,trim:'#383e40',balconies:false,brise:false,cornice:true,garden:false,pilotis:false,faces:{}},clone(input));}
 function worldPolygon(v,p=v.points){const a=v.rotation*Math.PI/180,c=Math.cos(a),s=Math.sin(a);return p.map(q=>[q[0]*c+q[1]*s+v.x,-q[0]*s+q[1]*c+v.z]);}
 const polygon=v=>[worldPolygon(v),...v.holes.map(h=>worldPolygon(v,h))];
 function parts(result,template){const out=result.filter(p=>area(p[0])>.15).map((p,i)=>{const b=bounds(p[0]),cx=(b.minX+b.maxX)/2,cz=(b.minZ+b.maxZ)/2,local=r=>clean(r).map(a=>[a[0]-cx,a[1]-cz]);return volume({...clone(template),id:uid(),name:template.name+(result.length>1?' '+(i+1):''),points:local(p[0]),holes:p.slice(1).map(local),x:cx,z:cz,rotation:0,faces:{}});});if(out.some(v=>!validPolygon(v.points)||!validHoles(v.points,v.holes)))throw Error('A operação gerou uma base inválida. Ajuste o desenho e tente de novo.');return out;}
 function booleanVolumes(vs,operation='union'){
  if(vs.length<2)throw Error('Selecione pelo menos dois volumes.');
  if(vs.some(v=>Math.abs(v.base-vs[0].base)>.01||Math.abs(v.height-vs[0].height)>.01))throw Error('Para unir bases, os volumes precisam ter a mesma altura e elevação.');
  return parts(clip[operation](...vs.map(polygon)),vs[0]);
 }
 function cutVolume(v,cut){if(!validPolygon(cut))throw Error('Recorte inválido.');return parts(clip.difference(polygon(v),[cut]),v);}
 function shape(kind,w=10,d=8){const x=w/2,z=d/2;if(kind==='circle')return Array.from({length:32},(_,i)=>[Math.cos(i*Math.PI/16)*x,Math.sin(i*Math.PI/16)*z]);
  if(kind==='l')return [[-x,-z],[x,-z],[x,-z+d*.42],[-x+w*.42,-z+d*.42],[-x+w*.42,z],[-x,z]];
  if(kind==='u')return [[-x,-z],[x,-z],[x,z],[x-w*.3,z],[x-w*.3,-z+d*.38],[-x+w*.3,-z+d*.38],[-x+w*.3,z],[-x,z]];
  return [[-x,-z],[x,-z],[x,z],[-x,z]];
 }
 function validateProject(raw){
  if(!raw||raw.version!==1||!Array.isArray(raw.volumes)||raw.volumes.length>120)throw Error('Projeto incompatível ou acima de 120 volumes.');
  const volumes=raw.volumes.map(v=>{
   if(!validPolygon(v.points))throw Error('O projeto contém uma base inválida.');
   const out=volume(v);out.points=clean(v.points);
   for(const k of ['height','base','floors','x','z','rotation','windowWidth','windowHeight','spacing','roofHeight'])if(!Number.isFinite(out[k]))throw Error('Parâmetro inválido: '+k);
   out.height=clamp(out.height,.5,100);out.base=clamp(out.base,0,100);out.floors=Math.round(clamp(out.floors,1,30));out.x=clamp(out.x,-500,500);out.z=clamp(out.z,-500,500);out.spacing=clamp(out.spacing,1,8);out.windowWidth=clamp(out.windowWidth,.25,5);out.windowHeight=clamp(out.windowHeight,.3,4);out.roofHeight=clamp(out.roofHeight,.2,10);
   if(!Array.isArray(out.holes)||out.holes.length>12||!validHoles(out.points,out.holes))throw Error('Pátio inválido.');
   if(!['flat','gable','shed','dome'].includes(out.roof))out.roof='flat';
   for(const k of ['color','trim','roofColor'])if(!/^#[0-9a-f]{6}$/i.test(out[k]))throw Error('Cor inválida.');
   out.faces=out.faces&&typeof out.faces==='object'?out.faces:{};
   for(const f of Object.values(out.faces)){if(!f||typeof f!=='object')throw Error('Fachada inválida.');if(f.openings){if(!Array.isArray(f.openings)||f.openings.length>80)throw Error('Aberturas inválidas.');for(const o of f.openings){if(!['u','y','w','h'].every(k=>Number.isFinite(o[k])))throw Error('Abertura inválida.');o.u=clamp(o.u,0,1);o.y=clamp(o.y,0,out.height);o.w=clamp(o.w,.25,8);o.h=clamp(o.h,.3,8);}}}
   out.name=String(out.name).slice(0,60);return out;
  });return {version:1,name:String(raw.name||'Projeto sem título').slice(0,70),volumes};
 }
 class History{constructor(initial){this.states=[clone(initial)];this.index=0;}commit(state){const next=clone(state);if(JSON.stringify(next)===JSON.stringify(this.states[this.index]))return false;this.states.splice(this.index+1);this.states.push(next);if(this.states.length>60)this.states.shift();this.index=this.states.length-1;return true;}undo(){if(this.index>0)this.index--;return clone(this.states[this.index]);}redo(){if(this.index<this.states.length-1)this.index++;return clone(this.states[this.index]);}get canUndo(){return this.index>0;}get canRedo(){return this.index<this.states.length-1;}}
 const Core={clone,clamp,area,signedArea,validPolygon,validHoles,clean,bounds,uid,volume,worldPolygon,booleanVolumes,cutVolume,shape,validateProject,History};
 if(typeof module!=='undefined')module.exports=Core;else root.FormaCore=Core;
})(globalThis);

