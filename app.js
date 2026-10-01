const $ = id => document.getElementById(id);
const {parseProgram, homePosition} = LatheParser;
const input = $('gcodeInput'), lineNumbers = $('lineNumbers');
const editorHighlightLayer = $('editorHighlightLayer'), activeLineHighlight = $('activeLineHighlight');
const plot = $('plot'), world = $('world'), stockLayer = $('stockLayer'), axesLayer = $('axes');
const futureLayer = $('futurePath'), completedLayer = $('completedPath'), currentLayer = $('currentPath');
const toolLayer = $('toolLayer'), scrubber = $('scrubber');
let stock = {diameter:1.58, length:4};
let parsed, currentStep = 0, playing = false, playTimer = null;
let view = {scale:1,tx:500,ty:325}, drag = null, debounce, editorDirty = false, parsedText = '';

const sample = `%
O1000 (SIMPLE OD TURNING SAMPLE)
G00 G18 G20 G40 G80 G99
T0101
G50 S1800
G97 S1200 M03
G00 X1.600 Z0.100
G01 Z0.000 F0.010
X1.300
Z-0.800
X1.000
Z-1.400
G02 X0.800 Z-1.600 R0.200
G01 Z-2.000
G00 X1.800
Z0.200
G28 U0 W0
M05
M30
%`;

function svgEl(name, attrs={}) {
  const el = document.createElementNS('http://www.w3.org/2000/svg',name);
  Object.entries(attrs).forEach(([k,v])=>el.setAttribute(k,v));return el;
}
function movePoints(move) { return move.points || [move.start,move.end]; }
// G-code/readouts use diameter X; the drawing uses true physical distance.
function pathD(points) { return points.map((p,i)=>`${i?'L':'M'} ${p.z} ${-p.x/2}`).join(' '); }
function drawAxes() {
  axesLayer.replaceChildren();
  const ref=svgEl('g',{transform:`scale(${1/view.scale})`});
  ref.appendChild(svgEl('line',{x1:-60,y1:0,x2:85,y2:0,class:'axis axis-z'}));
  ref.appendChild(svgEl('path',{d:'M 77 -5 L 85 0 L 77 5',class:'axis axis-z axis-arrow'}));
  ref.appendChild(svgEl('line',{x1:0,y1:60,x2:0,y2:-85,class:'axis axis-x'}));
  ref.appendChild(svgEl('path',{d:'M -5 -77 L 0 -85 L 5 -77',class:'axis axis-x axis-arrow'}));
  for(const [text,x,y,cls] of [['+Z',90,-8,'axis-z-label'],['+X',8,-90,'axis-x-label']]) {
    const label=svgEl('text',{x,y,class:`axis-label ${cls}`});label.textContent=text;ref.appendChild(label);
  }
  axesLayer.appendChild(ref);
}
function stockGeometry() { return {diameter:stock.diameter,length:stock.length,depth:.5,grip:Math.min(.2,stock.length),jaw:.18}; }
function drawStock() {
  stockLayer.replaceChildren();
  const {diameter:d,length:l,depth,grip,jaw}=stockGeometry(),r=d/2;
  stockLayer.appendChild(svgEl('rect',{x:-l,y:-r,width:l,height:d,class:'stock-body'}));
  stockLayer.appendChild(svgEl('rect',{x:-l-depth,y:-r-2*jaw,width:depth,height:d+4*jaw,class:'chuck-body'}));
  for(const y of [-r-jaw,r]) stockLayer.appendChild(svgEl('rect',{x:-l-depth/2,y,width:depth/2+grip,height:jaw,class:'chuck-jaw'}));
  const home=homePosition(stock.diameter),g=svgEl('g',{transform:`translate(${home.z} ${-home.x/2}) scale(${1/view.scale})`});
  g.appendChild(svgEl('circle',{cx:0,cy:0,r:7,class:'home-marker'}));
  const label=svgEl('text',{x:-11,y:-10,'text-anchor':'end',class:'home-label'});label.textContent='Preview home';g.appendChild(label);stockLayer.appendChild(g);
}
function currentState() { return currentStep ? parsed.steps[currentStep-1].state : parsed.initialState; }
function redraw(scroll=false) {
  futureLayer.replaceChildren();completedLayer.replaceChildren();currentLayer.replaceChildren();toolLayer.replaceChildren();
  const lastStep=currentStep ? parsed.steps[currentStep-1] : null;
  const completedMoves=currentStep ? parsed.steps.slice(0,currentStep).reduce((n,s)=>n+s.moves.length,0) : 0;
  const highlighted=lastStep?.moves.at(-1);
  for(let i=0;i<parsed.moves.length;i++) {
    const m=parsed.moves[i],p=svgEl('path',{d:pathD(movePoints(m))});
    const active=m===highlighted && currentStep<parsed.steps.length;
    p.setAttribute('class',active?'path-current':i<completedMoves?(m.type==='G0'?'path-rapid':'path-feed'):'path-future');
    (active?currentLayer:i<completedMoves?completedLayer:futureLayer).appendChild(p);
  }
  const s=currentState();
  toolLayer.appendChild(svgEl('circle',{cx:s.z,cy:-s.x/2,r:5/view.scale,class:'tool-marker'}));
  applyView();updateReadout(scroll);
}
function bounds() {
  const {diameter,length,depth,jaw}=stockGeometry();
  let minZ=-length-depth,maxZ=homePosition(diameter).z,minR=-diameter/2-2*jaw,maxR=Math.max(diameter/2+2*jaw,homePosition(diameter).x/2);
  for(const m of parsed.moves) for(const p of movePoints(m)) {minZ=Math.min(minZ,p.z);maxZ=Math.max(maxZ,p.z);minR=Math.min(minR,p.x/2);maxR=Math.max(maxR,p.x/2);}
  return {minZ,maxZ,minR,maxR};
}
function fitView() {
  flushEditor();
  const b=bounds(),margin=100,w=Math.max(.001,b.maxZ-b.minZ),h=Math.max(.001,b.maxR-b.minR);
  view.scale=clampScale(Math.min((1000-2*margin)/w,(650-2*margin)/h));
  view.tx=500-(b.minZ+b.maxZ)/2*view.scale;view.ty=325+(b.minR+b.maxR)/2*view.scale;applyView();
}
function applyView() {
  world.setAttribute('transform',`translate(${view.tx} ${view.ty}) scale(${view.scale})`);
  drawStock();drawAxes();toolLayer.querySelector('circle')?.setAttribute('r',5/view.scale);
}
function updateReadout(scroll=false) {
  const s=currentState(),factor=s.units==='mm'?25.4:1;
  scrubber.max=parsed.steps.length;scrubber.value=currentStep;
  $('lineReadout').textContent=currentStep?`${s.lineNumber} / ${parsed.lines.length}`:`0 / ${parsed.lines.length}`;
  $('motionReadout').textContent=currentStep?(parsed.steps[currentStep-1].moves.some(m=>m.homeReturn)?'G28':s.motion??'—'):'Home';
  if(s.mCodes?.includes(30))$('motionReadout').textContent='M30';
  else if(s.mCodes?.includes(2))$('motionReadout').textContent='M02';
  $('xReadout').textContent=(s.x*factor).toFixed(4);$('zReadout').textContent=(s.z*factor).toFixed(4);
  $('xReadout').title='Programmed X diameter (drawing shows X / 2 radial distance)';
  $('feedReadout').textContent=s.feed??'—';$('feedReadout').title=s.feedMode==='G99'?`${s.units}/revolution (G99)`:`${s.units}/minute (G98)`;
  $('spindleReadout').textContent=s.spindleOn?(s.speedMode==='G97'?Math.min(s.spindle??0,s.spindleLimit??Infinity):s.spindle??'—'):'—';
  $('spindleReadout').title=s.speedMode==='G97'?'RPM (G97)':s.units==='mm'?'Surface speed m/min (G96)':'Surface speed ft/min (G96)';
  $('toolReadout').textContent=s.tool??'—';$('unitsReadout').textContent=s.units;
  if(scroll && currentStep && document.activeElement!==input) {
    const lineHeight=parseFloat(getComputedStyle(input).lineHeight)||20;
    input.scrollTop=Math.max(0,(s.lineIndex-8)*lineHeight);lineNumbers.scrollTop=input.scrollTop;
  }
  updateEditorHighlight();
}
function updateEditorHighlight() {
  const active = currentStep > 0 && !editorDirty;
  activeLineHighlight.classList.toggle('hidden', !active);
  if (!active) { activeLineHighlight.setAttribute('data-line', ''); return; }
  const style = getComputedStyle(input);
  const lineHeight = parseFloat(style.lineHeight) || 20;
  const paddingTop = parseFloat(style.paddingTop) || 10;
  const top = (input.offsetTop || 0) + (input.clientTop || 0) + paddingTop
    + currentState().lineIndex * lineHeight - input.scrollTop;
  activeLineHighlight.setAttribute('style', `transform: translateY(${top}px); height: ${lineHeight}px;`);
  activeLineHighlight.setAttribute('data-line', currentState().lineIndex + 1);
  // Keep the band inside the text viewport, away from native scrollbars.
  if (input.clientHeight > 0) {
    const right = Math.max(0, input.offsetWidth - input.clientWidth);
    editorHighlightLayer.setAttribute('style', `right: ${right}px; height: ${(input.offsetTop || 0) + input.clientHeight}px;`);
  }
}
function updateLineNumbers() {
  const count=input.value.split(/\r?\n/).length;
  lineNumbers.textContent=Array.from({length:count},(_,i)=>i+1).join('\n');$('lineCount').textContent=`${count} line${count===1?'':'s'}`;
}
function updateWarnings() {
  const box=$('warningBox'),errors=parsed.diagnostics.filter(d=>d.severity==='error').length,checks=parsed.diagnostics.filter(d=>d.severity==='warning').length;
  box.textContent=parsed.warnings.join('\n');box.classList.toggle('hidden',!parsed.warnings.length);
  $('unsupportedSummary').textContent=errors?`${errors} error${errors===1?'':'s'}${checks?` · ${checks} checks`:''}`:checks?`${checks} check${checks===1?'':'s'}`:'No unsupported motion codes detected';
  $('parseStatus').textContent=parsed.halted?'Preview stopped at unsupported/invalid block':errors?'Parsed with errors':checks?'Parsed with checks':'Parsed';
}
function reparse(fit=false,reset=true) {
  stop();clearTimeout(debounce);debounce=null;editorDirty=false;parsedText=input.value;
  parsed=parseProgram(input.value,{stockDiameter:stock.diameter,stockLength:stock.length});
  currentStep=reset?0:Math.min(currentStep,parsed.steps.length);updateLineNumbers();updateWarnings();redraw();if(fit)fitView();
}
function stop() {playing=false;$('playBtn').textContent='▶ Play';if(playTimer!==null)clearInterval(playTimer);playTimer=null;}
function flushEditor() {if(editorDirty || input.value!==parsedText)reparse(false);}
function seek(step) {flushEditor();stop();currentStep=Math.max(0,Math.min(parsed.steps.length,step));redraw(true);}
for(const [id,key] of [['stockDiameter','diameter'],['stockLength','length']]) {
  $(id).addEventListener('input',()=>{
    if(!$(id).checkValidity()||!Number.isFinite(Number($(id).value)))return;
    stock[key]=Number($(id).value);reparse(false,false);
  });
  $(id).addEventListener('change',()=>{if(!$(id).checkValidity())$(id).value=stock[key];reparse(false,false);fitView();});
}
input.addEventListener('input',()=>{if(input.value===parsedText)return;stop();editorDirty=true;updateEditorHighlight();updateLineNumbers();clearTimeout(debounce);debounce=setTimeout(()=>reparse(false),160);});
input.addEventListener('scroll',()=>{lineNumbers.scrollTop=input.scrollTop;updateEditorHighlight();});
window.addEventListener('resize',updateEditorHighlight);
if(typeof ResizeObserver !== 'undefined') new ResizeObserver(updateEditorHighlight).observe(input);
$('loadSampleBtn').onclick=()=>{input.value=sample;reparse(true);};
$('clearBtn').onclick=()=>{input.value='';reparse(true);};
$('downloadBtn').onclick=()=>{
  const url=URL.createObjectURL(new Blob([input.value],{type:'text/plain'})),a=document.createElement('a');
  a.href=url;a.download='program.nc';document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
};
$('fitBtn').onclick=fitView;$('resetViewBtn').onclick=fitView;
function clampScale(scale) {return Math.max(.00002,Math.min(scale,5000));}
function zoomAt(factor,p={x:500,y:325}) {
  const wx=(p.x-view.tx)/view.scale,wy=(p.y-view.ty)/view.scale;
  view.scale=clampScale(view.scale*factor);view.tx=p.x-wx*view.scale;view.ty=p.y-wy*view.scale;applyView();
}
$('zoomInBtn').onclick=()=>zoomAt(1.2);$('zoomOutBtn').onclick=()=>zoomAt(1/1.2);
$('prevBtn').onclick=()=>{flushEditor();seek(currentStep-1);};$('nextBtn').onclick=()=>{flushEditor();seek(currentStep+1);};$('stopBtn').onclick=()=>seek(0);
$('playBtn').onclick=()=>{
  flushEditor();
  if(playing)return stop();if(!parsed.steps.length)return;
  if(currentStep===parsed.steps.length){currentStep=0;redraw();}
  playing=true;$('playBtn').textContent='❚❚ Pause';
  playTimer=setInterval(()=>{
    if(currentStep>=parsed.steps.length)return stop();
    currentStep++;redraw(true);if(parsed.steps[currentStep-1].pause || currentStep===parsed.steps.length)stop();
  },450);
};
scrubber.oninput=()=>seek(Number(scrubber.value)||0);
function screenPoint(e) {const matrix=plot.getScreenCTM();return matrix?new DOMPoint(e.clientX,e.clientY).matrixTransform(matrix.inverse()):null;}
plot.addEventListener('pointerdown',e=>{
  if(e.button!==0)return;const p=screenPoint(e);if(!p)return;
  drag={id:e.pointerId,x:p.x,y:p.y,tx:view.tx,ty:view.ty};plot.setPointerCapture(e.pointerId);
});
plot.addEventListener('pointermove',e=>{if(!drag || drag.id!==e.pointerId)return;const p=screenPoint(e);if(!p)return;view.tx=drag.tx+p.x-drag.x;view.ty=drag.ty+p.y-drag.y;applyView();});
for(const name of ['pointerup','pointercancel','lostpointercapture'])plot.addEventListener(name,()=>drag=null);
plot.addEventListener('wheel',e=>{e.preventDefault();const p=screenPoint(e);if(p)zoomAt(e.deltaY<0?1.12:1/1.12,p);},{passive:false});
input.value=sample;reparse(true);
