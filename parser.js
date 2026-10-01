/* Haas two-axis lathe preview. Coordinates are stored in inches; X is diameter.
   R and I/K describe physical radii. Machine/work/tool offsets are not available. */
(function(root) {
  'use strict';
  const EPS = 1e-8;
  const MAX_FEED_PER_REV_INCH = 0.05;
  const stripComments = line => line.replace(/\([^)]*\)/g, ' ').replace(/;.*$/g, ' ');
  function parseWords(line) {
    return [...stripComments(line).toUpperCase().matchAll(/([A-Z])\s*([+\-]?(?:\d+(?:\.\d*)?|\.\d+))/g)]
      .map(m => ({letter:m[1], value:Number(m[2]), raw:m[0]}));
  }
  function programUnits(text) {
    for (const line of text.split(/\r?\n/)) {
      const unit = parseWords(line).find(w => w.letter === 'G' && [20,21].includes(w.value));
      if (unit) return unit.value === 21 ? 'mm' : 'inch';
      if (parseWords(line).some(w => ['X','Z','U','W'].includes(w.letter))) break;
    }
    return 'inch';
  }
  function homePosition(stockDiameter=1.58) { return {x:Math.max(3,stockDiameter+1), z:2}; }
  function sweepFrom(center, start, end, cw) {
    const a0=Math.atan2(start.x-center.x,start.z-center.z);
    const a1=Math.atan2(end.x-center.x,end.z-center.z);
    let d=a1-a0;
    if (cw) { while(d>=-EPS) d-=2*Math.PI; }
    else { while(d<=EPS) d+=2*Math.PI; }
    return d;
  }
  // x arguments here are PHYSICAL radial distances, unlike stored X diameters.
  function arcCenterFromR(x0,z0,x1,z1,r,cw) {
    const dx=x1-x0, dz=z1-z0, q=Math.hypot(dx,dz), radius=Math.abs(r);
    if(q<EPS || radius<EPS || q>2*radius+EPS) return null;
    const h=Math.sqrt(Math.max(0,radius*radius-q*q/4));
    for(const sign of [1,-1]) {
      const center={x:(x0+x1)/2+sign*dz*h/q,z:(z0+z1)/2-sign*dx*h/q};
      const sweep=sweepFrom(center,{x:x0,z:z0},{x:x1,z:z1},cw);
      if((Math.abs(sweep)<=Math.PI+EPS)===(r>=0)) return {...center,sweep};
    }
    return null;
  }
  function segmentIntersects(a,b,minZ,maxZ,minX,maxX) {
    let low=0, high=1;
    for(const [axis,min,max] of [['z',minZ,maxZ],['x',minX,maxX]]) {
      const delta=b[axis]-a[axis];
      if(Math.abs(delta)<EPS) { if(a[axis]<min || a[axis]>max) return false; }
      else { const t0=(min-a[axis])/delta,t1=(max-a[axis])/delta;
        low=Math.max(low,Math.min(t0,t1)); high=Math.min(high,Math.max(t0,t1)); }
      if(low>high) return false;
    }
    return true;
  }
  function parseProgram(text, options={}) {
    const lines=text.split(/\r?\n/), moves=[], steps=[], states=[], diagnostics=[];
    const stockDiameter=options.stockDiameter ?? 1.58, stockLength=options.stockLength ?? 4;
    const home=homePosition(stockDiameter), units=programUnits(text);
    let s={...home,motion:'G0',units,feed:null,feedMode:'G99',spindle:null,speedMode:'G97',
      spindleOn:false,spindleDirection:null,spindleLimit:null,tool:null,plane:'G18',workOffset:'G54'};
    const initialState={...s};
    let halted=false,ended=false,cutSeen=false;
    let firstG01Seen=false,programNumberSeen=false,executableSeen=false;
    const seenG=new Set(), warned=new Set();
    const warn=(lineIndex,severity,message,key)=> {
      if(key && warned.has(key)) return;
      if(key) warned.add(key);
      diagnostics.push({lineNumber:lineIndex+1,severity,message});
    };
    const unsupportedCycles=new Set([32,70,71,72,73,74,75,76,81,82,83,84,85,86,87,88,89,90,92,94,95]);
    function addMove(end, type, idx, raw, extra={}) {
      const m={lineIndex:idx,lineNumber:idx+1,raw,type,start:{x:s.x,z:s.z},end,
        units:s.units,feed:s.feed,feedMode:s.feedMode,spindle:s.spindle,speedMode:s.speedMode,
        spindleOn:s.spindleOn,spindleLimit:s.spindleLimit,tool:s.tool,points:null,...extra};
      moves.push(m); s.x=end.x;s.z=end.z;return m;
    }
    for(let idx=0;idx<lines.length;idx++) {
      const raw=lines[idx],clean=stripComments(raw).toUpperCase().trim();
      if(!clean || clean==='%') { states.push({...s,lineIndex:idx,raw});continue; }
      const words=parseWords(raw), codes=words.filter(w=>w.letter==='G').map(w=>w.value);
      const mCodes=words.filter(w=>w.letter==='M').map(w=>w.value);
      let invalid=false;
      const fail=message=>{warn(idx,'error',message);invalid=true;};
      // Classroom header rules apply to the whole source, including after M30.
      if(clean.includes('O')) {
        const headers=words.filter(w=>w.letter==='O');
        if(idx>=5 || executableSeen) fail('O is only allowed as the opening program number within the first five source lines. Use the number 0, not the letter O, in G/M codes and coordinates.');
        else if(programNumberSeen) fail('Only one opening O program number is allowed.');
        else if(headers.length!==1 || !Number.isInteger(headers[0].value) || headers[0].value<0 || words.some(w=>!['N','O'].includes(w.letter))) fail('Put the opening O program number on its own line, with an optional N line number or comment.');
        else programNumberSeen=true;
      }
      if(words.some(w=>!['O','N'].includes(w.letter))) executableSeen=true;
      if(ended || halted) {
        if(invalid) halted=true;
        if(ended && words.some(w=>!['N','O'].includes(w.letter))) warn(idx,'warning','Block after program end is not executed.','after-end');
        states.push({...s,lineIndex:idx,raw});continue;
      }
      if((raw.match(/\(/g)||[]).length !== (raw.match(/\)/g)||[]).length) fail('Unclosed or unmatched comment.');
      const residue=clean.replace(/([A-Z])\s*([+\-]?(?:\d+(?:\.\d*)?|\.\d+))/g,'').replace(/[%/\s]/g,'');
      if(residue) fail(`Cannot interpret "${residue}". Check missing values, decimal points, or unsupported expressions.`);
      if(clean.startsWith('/')) fail('Optional block deletion depends on the control setting; this block cannot be assumed to execute.');
      const map={};
      for(const w of words) {
        if(!Number.isFinite(w.value) || Math.abs(w.value)>1e7) fail(`${w.letter} value is outside the preview range.`);
        if(w.letter in map && !['G','M','N'].includes(w.letter)) fail(`Duplicate ${w.letter} address in one block.`);
        map[w.letter]=w.value;
      }
      if(words.some(w=>'XZUWIK'.includes(w.letter) && w.value!==0 && !w.raw.includes('.'))) warn(idx,'warning','A coordinate has no decimal point. The preview uses literal units; Haas Setting 162 can change integer interpretation. Add decimal points or verify that setting.','integer-coordinate');
      if(words.some(w=>w.letter==='F' && w.value>0 && !w.raw.includes('.'))) warn(idx,'warning','F has no decimal point. The preview uses its literal value; verify Haas Setting 77 (Scale Integer F) or program a decimal feed.','integer-feed');
      if('X' in map && 'U' in map) fail('Use X or U for this axis, not both in one block.');
      if('Z' in map && 'W' in map) fail('Use Z or W for this axis, not both in one block.');
      const supportedLetters=new Set('GMNOXZUWIKRFSTP');
      for(const w of words) if(!supportedLetters.has(w.letter)) fail(`${w.letter} address is not supported by this two-axis preview.`);
      const motionCodes=codes.filter(g=>[0,1,2,3,...unsupportedCycles].includes(g));
      if(motionCodes.length>1) fail('Multiple Group 01 motion codes in the same block.');
      for(const group of [[18,17,19],[20,21],[98,99],[96,97],[54,55,56,57,58,59]]) {
        if(codes.filter(g=>group.includes(g)).length>1) fail('Conflicting modal G codes in one block.');
      }
      for(const g of codes) {
        seenG.add(g);
        if(unsupportedCycles.has(g)) fail(`G${g} is a Haas lathe cycle; cycle expansion is not supported. Preview stops here.`);
        else if(g===91) fail('G91 is not the supported Haas turning increment format; use U for X and W for Z.');
        else if([17,19].includes(g)) fail(`G${g} live-tool plane is not supported; this preview uses G18.`);
        else if([41,42].includes(g)) fail(`G${g} tool nose compensation requires tool geometry. Preview stops here.`);
        else if([53,55,56,57,58,59,10,51,52,154,171,172,170,390,391].includes(g)) fail(`G${g} requires coordinate, mode, or machine data not available in this preview.`);
        else if(![0,1,2,3,4,9,18,20,21,28,40,50,54,80,96,97,98,99].includes(g)) fail(`G${g} is not interpreted. Preview stops here.`);
      }
      for(const m of mCodes) if(![0,1,2,3,4,5,8,9,30].includes(m)) fail(`M${m} is not supported. Preview stops here.`);
      if(mCodes.length>1) fail('Haas permits one M code per block.');
      if('F' in map && map.F<=0) fail('Feed F must be greater than zero.');
      if('S' in map && map.S<=0) fail('Spindle speed/limit S must be greater than zero.');
      if(codes.includes(1) && !firstG01Seen && (!('S' in map) || !('F' in map) || codes.includes(50)))
        fail('Classroom rule: the first G01 line must include spindle speed S and feedrate F on that same line.');
      const nextUnits=codes.includes(21)?'mm':codes.includes(20)?'inch':s.units;
      const nextFeedMode=codes.includes(98)?'G98':codes.includes(99)?'G99':s.feedMode;
      const nextFeed='F' in map?map.F:s.feed;
      const maxFeed=MAX_FEED_PER_REV_INCH*(nextUnits==='mm'?25.4:1);
      if(nextFeedMode==='G99' && nextFeed!==null && nextFeed>maxFeed+1e-10)
        fail(`Classroom feed limit: F${nextFeed} exceeds F${Number(maxFeed.toFixed(3))} ${nextUnits==='mm'?'mm':'in'}/rev. Preview stops before this block.`);
      if('T' in map && (!Number.isInteger(map.T)||map.T<0||map.T>9999)) fail('Tool T must be an integer from 0 to 9999.');
      if(codes.includes(50) && !('S' in map)) fail('G50 spindle limit needs an S value.');
      const hasAxis=['X','Z','U','W'].some(k=>k in map);
      if(codes.some(g=>[4,50].includes(g)) && hasAxis) fail('Axis motion on this non-motion G block is not supported.');
      if('P' in map && !codes.includes(4)) fail('P is only supported for a G04 dwell in this preview.');
      if(codes.includes(4) && (!('P' in map) || map.P<0)) fail('G04 dwell needs a non-negative P value.');
      if(codes.includes(28) && ['I','K','R'].some(k=>k in map)) fail('G28 supports axis addresses only, not arc or rounding words.');
      if(codes.filter(g=>[4,9,28,50].includes(g)).length>1) fail('Multiple Group 00 nonmodal G codes in one block.');
      const effectiveMotion=motionCodes.length?'G'+motionCodes[0]:s.motion;
      const arcWords=['I','K','R'].some(k=>k in map);
      if(arcWords && (codes.some(g=>[4,28,50].includes(g)) || !['G2','G3'].includes(effectiveMotion))) fail('Arc or corner-rounding words require a supported G02/G03 arc.');
      if('R' in map && !hasAxis && !('I' in map||'K' in map)) fail('An R arc needs an endpoint; use I/K for a full circle.');
      if(codes.includes(28) && motionCodes.length) fail('Combine G28 with axis addresses only; explicit motion in this block is not supported.');
      if(invalid) { halted=true;states.push({...s,lineIndex:idx,raw});continue; }
      if(codes.includes(1)) firstG01Seen=true;
      if(codes.includes(20)) s.units='inch';
      if(codes.includes(21)) s.units='mm';
      const unit=s.units==='mm'?1/25.4:1;
      for(const g of codes) {
        if([0,1,2,3].includes(g)) s.motion='G'+g;
        if([98,99].includes(g)) s.feedMode='G'+g;
        if([96,97].includes(g)) s.speedMode='G'+g;
      }
      // G80 cancels canned cycles (Group 09), not ordinary Group 01 interpolation.
      if('F' in map) s.feed=map.F;
      if(codes.includes(50)) s.spindleLimit=map.S;
      else if('S' in map) s.spindle=map.S;
      if(mCodes.includes(3)||mCodes.includes(4)) {s.spindleOn=true;s.spindleDirection=mCodes.includes(3)?'M03':'M04';}
      if(mCodes.includes(5)) s.spindleOn=false;
      if('T' in map) {
        const turret=map.T<100?map.T:Math.floor(map.T/100);
        s.tool=map.T<100?'T'+String(map.T).padStart(2,'0'):String(map.T).padStart(4,'0');
        if(turret && (s.z<=0 || s.x<stockDiameter)) warn(idx,'warning','Tool change while the preview tool point is close to the stock. Verify turret clearance.');
      }
      if(s.speedMode==='G96' && !s.spindleLimit) warn(idx,'warning','G96 constant surface speed has no programmed G50 spindle limit.','css-limit');
      if(s.speedMode==='G97' && s.spindleLimit && s.spindle>s.spindleLimit) warn(idx,'warning',`S${s.spindle} exceeds G50 S${s.spindleLimit}; spindle is limited by G50.`,`speed-limit-${s.spindleLimit}-${s.spindle}`);
      const blockMoves=[];
      const target={x:'X' in map?map.X*unit:s.x+('U' in map?map.U*unit:0),z:'Z' in map?map.Z*unit:s.z+('W' in map?map.W*unit:0)};
      if(codes.includes(28)) {
        const xAxis=('X' in map||'U' in map)||!hasAxis,zAxis=('Z' in map||'W' in map)||!hasAxis;
        if(hasAxis && (Math.abs(target.x-s.x)>EPS || Math.abs(target.z-s.z)>EPS)) blockMoves.push(addMove(target,'G0',idx,raw,{homeReturn:true}));
        if(!hasAxis) {
          // Bare G28 retracts X first, then returns Z on the classroom lathe.
          blockMoves.push(addMove({x:home.x,z:s.z},'G0',idx,raw,{homeReturn:true,referenceReturn:true}));
          blockMoves.push(addMove({x:s.x,z:home.z},'G0',idx,raw,{homeReturn:true,referenceReturn:true}));
        } else {
          blockMoves.push(addMove({x:xAxis?home.x:s.x,z:zAxis?home.z:s.z},'G0',idx,raw,{homeReturn:true,referenceReturn:true}));
        }
        warn(idx,'note',"Preview home may differ from your machine's home position.",'preview-home');
      } else if(hasAxis || (['G2','G3'].includes(s.motion) && ('I' in map||'K' in map))) {
        if(!s.motion) { fail('Axis addresses have no active motion after G80.');halted=true;states.push({...s,lineIndex:idx,raw});continue; }
        let points=null;
        if(['G2','G3'].includes(s.motion)) {
          const start={x:s.x/2,z:s.z},end={x:target.x/2,z:target.z},cw=s.motion==='G2';
          let center=null,sweep=null;
          if('R' in map && ('I' in map||'K' in map)) fail('Arc must use R or I/K, not both.');
          else if('I' in map||'K' in map) {
            center={x:start.x+(map.I||0)*unit,z:start.z+(map.K||0)*unit};
            const r0=Math.hypot(start.x-center.x,start.z-center.z),r1=Math.hypot(end.x-center.x,end.z-center.z);
            if(r0<EPS || Math.abs(r0-r1)>Math.max(0.0001,r0*1e-4)) fail('Arc I/K radii do not match at the start and endpoint. I is a radius offset even when X is diameter.');
            else sweep=sweepFrom(center,start,end,cw);
          } else if('R' in map) { center=arcCenterFromR(start.x,start.z,end.x,end.z,map.R*unit,cw);if(center) sweep=center.sweep;else fail('Arc R cannot connect the endpoints; check diameter X and radius R.'); }
          else fail('G02/G03 arc needs R or I/K.');
          if(invalid) { halted=true;states.push({...s,lineIndex:idx,raw});continue; }
          const radius=Math.hypot(start.x-center.x,start.z-center.z),a0=Math.atan2(start.x-center.x,start.z-center.z);
          const n=Math.max(16,Math.ceil(Math.abs(sweep)/(Math.PI/90)));
          points=Array.from({length:n+1},(_,i)=>({x:2*(center.x+radius*Math.sin(a0+sweep*i/n)),z:center.z+radius*Math.cos(a0+sweep*i/n)}));
          points[0]={x:s.x,z:s.z};points[n]={...target};
        } else if(['I','K','R'].some(k=>k in map)) {fail('I/K/R on a linear move is not supported (chamfer/corner rounding is not expanded).');halted=true;states.push({...s,lineIndex:idx,raw});continue;}
        if(![0,1,2,3].some(g=>seenG.has(g))) warn(idx,'warning','Axis motion before an explicit G00/G01/G02/G03; the preview assumes G00.','motion-default');
        const move=addMove(target,s.motion,idx,raw,{points});blockMoves.push(move);
        if(move.type!=='G0') {
          cutSeen=true;
          if(!s.feed) warn(idx,'error','Feed move has no programmed positive F value.','missing-feed');
          if(!s.spindleOn || !s.spindle) warn(idx,'warning','Feed move without a programmed running spindle and S value.','missing-spindle');
          if(!s.tool || ['0000','T00'].includes(s.tool)) warn(idx,'warning','Feed move without a programmed cutting tool.','missing-tool');
          if(move.start.x>=0 && move.end.x<0) {
            const factor=s.units==='mm'?25.4:1,label=s.units==='mm'?'mm':'in';
            warn(idx,'note',`X${(move.end.x*factor).toFixed(3)} places the tool tip ${(Math.abs(move.end.x)*factor/2).toFixed(3)} ${label} past X0 (the spindle centerline). This can be intentional parting overtravel.`,'negative-x');
          }
        }
      }
      for(const move of blockMoves) {
        const pts=move.points||[move.start,move.end];
        for(let j=1;j<pts.length;j++) {
          if(segmentIntersects(pts[j-1],pts[j],-stockLength-0.5,-stockLength+Math.min(0.2,stockLength),-stockDiameter-0.72,stockDiameter+0.72)) {
            warn(idx,'warning','Tool point enters the schematic chuck/grip region. Check stock stick out and fixture clearance.');break;
          }
        }
        // A reference-return radial retract leaves an existing cut. The original
        // stock rectangle cannot represent that cut, so it is not a collision test.
        const radialHomeRetract=move.referenceReturn && Math.abs(move.end.z-move.start.z)<EPS && move.end.x>=stockDiameter && move.end.x>=move.start.x;
        if(move.type==='G0' && !radialHomeRetract && pts.some((p,j)=>j>0&&segmentIntersects(pts[j-1],p,-stockLength+EPS,-EPS,-stockDiameter+EPS,stockDiameter-EPS)))
          warn(idx,'warning','Rapid path intersects the original stock envelope. Check clearance; removed material and tool shape are not modeled.');
      }
      if(codes.includes(4)) warn(idx,'note','Dwell is shown as one playback block; playback timing is illustrative.','dwell');
      if(mCodes.includes(0)||mCodes.includes(1)) warn(idx,'note','M00/M01 is shown as a pause block (optional stop is assumed enabled).','program-pause');
      if(mCodes.includes(30)||mCodes.includes(2)) {s.spindleOn=false;ended=true;}
      const state={...s,lineIndex:idx,lineNumber:idx+1,raw,mCodes};states.push(state);
      if(words.some(w=>!['O','N'].includes(w.letter))) steps.push({lineIndex:idx,lineNumber:idx+1,raw,state,moves:blockMoves,pause:mCodes.includes(0)||mCodes.includes(1)});
    }
    if(cutSeen) {
      if(!ended&&!halted) warn(lines.length-1,'warning','No M30/M02 program end found.');
    }
    diagnostics.sort((a,b)=>a.lineNumber-b.lineNumber);
    const warnings=diagnostics.map(d=>`Line ${d.lineNumber} · ${d.severity==='error'?'Error':d.severity==='note'?'Note':'Check'}: ${d.message}`);
    return {lines,moves,steps,states,warnings,diagnostics,initialState,units,halted,ended};
  }
  const api={parseProgram,parseWords,stripComments,programUnits,homePosition,arcCenterFromR};
  if(typeof module!=='undefined'&&module.exports) module.exports=api;
  else root.LatheParser=api;
})(typeof globalThis!=='undefined'?globalThis:this);
