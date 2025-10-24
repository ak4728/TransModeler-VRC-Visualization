// Day.js plugin
dayjs.extend(window.dayjs_plugin_customParseFormat);

// ------- State -------
const state = {
  dfSegments: [],                 // [{direction, segment, sensor_id, location}]
  sensorsByDir: { NB: [], SB: [] },
  scenarios: [],                  // [{id, label, file}]
  activations: new Map(),         // label -> rows
  links: new Map(),               // label -> link rows
  corridors: new Map(),           // label -> corridor rows
  combinedLinks: [],              // tidy combined
  combinedCorr: [],               // tidy corridor combined
};

let scenarioCounter = 0;

// ------- Utils -------
const $  = sel => document.querySelector(sel);
const $$ = sel => Array.from(document.querySelectorAll(sel));
const log = (msg) => { const el = $('#status'); el.textContent += "\n" + msg; el.scrollTop = el.scrollHeight; };
const setStatus = (msg) => { $('#status').textContent = msg; };

function cleanName(name){
  const s = String(name ?? '').replace(/\s+/g,' ').trim().toLowerCase();
  return s.replace(/[^\w/+\-]+/g,'_').replace(/[\/+\-]/g,'_').replace(/_+/g,'_').replace(/^_|_$/g,'');
}

function parseTimeToDate(str){
  if(!str) return null;
  const s = String(str).trim();
  let d = dayjs(s, 'h:mm:ss A', true);
  if(!d.isValid()) d = dayjs(s, 'h:mm A', true);
  if(!d.isValid()) d = dayjs(s);
  if(!d.isValid()) return null;
  const h = d.hour(), m = d.minute(), sec = d.second();
  return new Date(1900,0,1,h,m,sec);
}

function hourLocal(date){ return date ? date.getHours() : null; }
function secondsDiff(a,b){ return (b - a) / 1000; }

function quantile(arr, q){
  const v = arr.filter(x=>Number.isFinite(x)).slice().sort((a,b)=>a-b);
  if(v.length === 0) return NaN;
  const pos = (v.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  return v[base] + (v[base+1] !== undefined ? rest*(v[base+1]-v[base]) : 0);
}

function median(arr){ return quantile(arr, 0.5); }

function floor15min(date){
  const ms = date.getTime();
  const fifteen = 15 * 60 * 1000;
  const floored = Math.floor(ms / fifteen) * fifteen;
  return new Date(floored);
}

function downloadCSV(name, rows){
  if(!rows || rows.length===0){ alert('No rows to download'); return; }
  const cols = Object.keys(rows[0]);
  const quoted = (v)=>{
    if(v==null) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g,'""') + '"' : s;
  };
  const csv = [cols.join(',')].concat(rows.map(r=>cols.map(c=>quoted(r[c])).join(','))).join('\n');
  const blob = new Blob([csv], {type:'text/csv'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
}

// ------- File readers -------
async function readFileAsArrayBuffer(file){
  return new Promise((res, rej)=>{ const fr = new FileReader(); fr.onload = ()=>res(fr.result); fr.onerror = rej; fr.readAsArrayBuffer(file); });
}
async function readFileAsText(file){
  return new Promise((res, rej)=>{ const fr = new FileReader(); fr.onload = ()=>res(fr.result); fr.onerror = rej; fr.readAsText(file); });
}

async function parseExcelToAOA(file){
  const ab = await readFileAsArrayBuffer(file);
  const wb = XLSX.read(ab, {type:'array'});
  const wsname = wb.SheetNames[0];
  const ws = wb.Sheets[wsname];
  return XLSX.utils.sheet_to_json(ws, {header:1, raw:false, defval:''});
}

async function parseCSVToAOA(file){
  const text = await readFileAsText(file);
  const out = Papa.parse(text, {header:false, skipEmptyLines:false});
  return out.data.map(row => row.map(c => c==null ? '' : String(c)));
}

async function parseAnyToAOA(file){
  const name = file.name.toLowerCase();
  if(name.endsWith('.csv') || name.endsWith('.txt')) return parseCSVToAOA(file);
  return parseExcelToAOA(file);
}

// ------- Parsers (domain specific) -------
async function loadSegmentCatalog(file){
  const aoa = await parseAnyToAOA(file);
  const rows = aoa.filter(r => (r||[]).some(c => String(c).trim()!==''));
  if(rows.length < 2) throw new Error('Segment catalog appears empty');

  // Parse all rows - columns: Direction, Segment Number, Segment Placement, Sensor ID, Location
  const rawData = rows.slice(1).map(r => ({
    direction: String(r[0] ?? '').trim(),
    segment: r[1]!=='' ? Number(r[1]) : null,
    placement: String(r[2] ?? '').trim().toLowerCase(),
    sensor_id: r[3]!=='' ? Number(r[3]) : null,
    location: String(r[4] ?? '').trim()
  })).filter(x => Number.isFinite(x.sensor_id));

  // Forward-fill blank Direction cells
  let lastDir = '';
  for (const x of rawData) {
    if (x.direction && x.direction.trim() !== '') { 
      lastDir = x.direction; 
    } else { 
      x.direction = lastDir; 
    }
  }

  // Normalize direction
  rawData.forEach(x => { 
    x.direction = x.direction.trim().toLowerCase().replace(/^\w/, c=>c.toUpperCase()); 
  });

 // Build segment assignments from ALL rows
  const sensorByDirMap = new Map(); // key: "direction|sensor_id"
  
  // First: add all rows that have explicit segment numbers
  for(const row of rawData){
    if(row.segment !== null){
      const key = `${row.direction}|${row.sensor_id}`;
      sensorByDirMap.set(key, {
        direction: row.direction,
        segment: row.segment,
        sensor_id: row.sensor_id,
        location: row.location,
        placement: row.placement
      });
    }
  }
  
  // Second: for End rows without segments, assign the segment from the matching Start row
  // Group by direction
  const nbRows = rawData.filter(d => d.direction.toLowerCase() === 'northbound');
  const sbRows = rawData.filter(d => d.direction.toLowerCase() === 'southbound');
  
  // For each End row without segment, look for the previous segment
  for(let i = 0; i < nbRows.length; i++){
    const row = nbRows[i];
    if(row.placement === 'end' && row.segment === null){
      // Look backward for the most recent Start with a segment
      for(let j = i - 1; j >= 0; j--){
        if(nbRows[j].segment !== null && nbRows[j].placement === 'start'){
          const key = `${row.direction}|${row.sensor_id}`;
          if(!sensorByDirMap.has(key)){
            sensorByDirMap.set(key, {
              direction: row.direction,
              segment: nbRows[j].segment,
              sensor_id: row.sensor_id,
              location: row.location,
              placement: row.placement
            });
          }
          break;
        }
      }
    }
  }
  
  for(let i = 0; i < sbRows.length; i++){
    const row = sbRows[i];
    if(row.placement === 'end' && row.segment === null){
      for(let j = i - 1; j >= 0; j--){
        if(sbRows[j].segment !== null && sbRows[j].placement === 'start'){
          const key = `${row.direction}|${row.sensor_id}`;
          if(!sensorByDirMap.has(key)){
            sensorByDirMap.set(key, {
              direction: row.direction,
              segment: sbRows[j].segment,
              sensor_id: row.sensor_id,
              location: row.location,
              placement: row.placement
            });
          }
          break;
        }
      }
    }
  }
  
  const data = Array.from(sensorByDirMap.values());




  data.sort((a,b)=>{
    if(a.direction!==b.direction) return a.direction.localeCompare(b.direction);
    return (a.segment??0) - (b.segment??0);
  });

  // Build orders for corridor processing
  const nb = data.filter(d=>d.direction.toLowerCase()==='northbound')
    .sort((a,b)=>a.segment-b.segment)
    .map(d=>d.sensor_id);
  const sb = data.filter(d=>d.direction.toLowerCase()==='southbound')
    .sort((a,b)=>b.segment-a.segment)
    .map(d=>d.sensor_id);

  const uniqueNB = [...new Set(nb)];
  const uniqueSB = [...new Set(sb)];

  state.dfSegments = data;
  state.sensorsByDir = { NB: uniqueNB, SB: uniqueSB };

  return data;
}


// VRC Sensor Report reader
async function readVRCSensorReport(file){
  const raw = await parseAnyToAOA(file);
  
  // Ensure raw is an array
  if(!Array.isArray(raw) || raw.length === 0){
    throw new Error('Failed to parse file or file is empty');
  }

  // Find block starts
  const starts = [];
  for(let i=0;i<raw.length;i++){
    const row = raw[i];
    if(!Array.isArray(row)) continue;
    const c0 = String((row||[])[0] ?? '').trim();
    if(/^sensor\s+id\s+\d+/i.test(c0)) starts.push(i);
  }
  starts.push(raw.length);

  const blocks = [];

  for(let bi=0; bi<starts.length-1; bi++){
    const start = starts[bi];
    const end = starts[bi+1];

    const startRow = raw[start];
    if(!Array.isArray(startRow)) continue;
    
    const m = String(startRow[0]).match(/sensor(?:\s+id)?\s*:?\s*(\d+)/i);
    if(!m) continue;
    const sensor_id = Number(m[1]);

    // Header is next non-empty row
    let headerRow = start + 1;
    while(headerRow < end && Array.isArray(raw[headerRow]) && raw[headerRow].every(c => String(c).trim() === '')) {
      headerRow++;
    }
    if(headerRow >= end || !Array.isArray(raw[headerRow])) continue;

    const cols = (raw[headerRow]||[]).map(cleanName);

    // Data starts after header, skip summary rows
    const body = raw.slice(headerRow+1, end).filter(r => {
      if(!Array.isArray(r)) return false;
      const row = r || [];
      const firstCol = String(row[0] ?? '').trim().toLowerCase();
      return row.some(c => String(c).trim() !== '') && !firstCol.startsWith('summary');
    });

    if(!body.length) continue;
    for(const row of body){
      if(!Array.isArray(row)) continue;
      const rec = { sensor_id };
      for(let ci=0; ci<cols.length; ci++){
        rec[cols[ci]] = row[ci] ?? '';
      }
      blocks.push(rec);
    }
  }

  // Normalize activations
  const act = blocks.map(r=>({...r}));
  for(const r of act){
    // Handle Vehicle ID - keep as STRING (Python behavior)
    if(r.hasOwnProperty('vehicle_id')){
      let s = String(r.vehicle_id).replace(/[^\d]/g,'');
      s = s.replace(/^0+/,'');
      r.vehicle_id = s || null;
    }
    
    if(r.hasOwnProperty('speed_(mph)')){ r.speed_mph = Number(r['speed_(mph)']); delete r['speed_(mph)']; }
    if(r.hasOwnProperty('speed')){ r.speed_mph = Number(r.speed); delete r.speed; }
    if(r.hasOwnProperty('occup_ants')){ r.occupants = r['occup_ants']; delete r['occup_ants']; }
    r.sensor_id = Number(r.sensor_id);

    if(!r.ts){
      const t = r.time ?? r.Time ?? '';
      const d = parseTimeToDate(t);
      r.ts = d;
    } else if(!(r.ts instanceof Date)) {
      r.ts = parseTimeToDate(r.ts);
    }

    if(r.transit!=null) r.transit = Number(r.transit);
    if(r.truck!=null) r.truck = Number(r.truck);
  }

  return { activations: act.filter(r=>r.sensor_id && r.ts instanceof Date), summary: [] };
}

function buildOrders(){
  const nb = state.dfSegments.filter(d=>d.direction.toLowerCase()==='northbound')
    .sort((a,b)=>a.segment-b.segment)
    .map(d=>d.sensor_id);
  const sb = state.dfSegments.filter(d=>d.direction.toLowerCase()==='southbound')
    .sort((a,b)=>b.segment-a.segment)
    .map(d=>d.sensor_id);
  return { NB: nb, SB: sb };
}

function posIndex(direction, sensor_id, orders){
  if(direction.toLowerCase()==='northbound'){
    const i = orders.NB.indexOf(sensor_id); return i>=0 ? i : null;
  } else if(direction.toLowerCase()==='southbound'){
    const i = orders.SB.indexOf(sensor_id); return i>=0 ? i : null;
  }
  return null;
}

function computeLinkAndCorridor(activations, vehicleFilter, dfSegments){
  const orders = buildOrders();

  // Vehicle filter
  let act = activations.filter(r=>r.vehicle_id && r.ts instanceof Date);
  if(vehicleFilter==='transit'){
    act = act.filter(r=>r.transit && Number(r.transit)===1);
  } else if(vehicleFilter==='trucks'){
    act = act.filter(r=>r.truck && Number(r.truck)===1);
  }

  // Attach direction, segment, location via sensor_id
  const metaBySensor = new Map();
  for(const row of dfSegments){ metaBySensor.set(Number(row.sensor_id), row); }
  act = act.map(r=>{
    const m = metaBySensor.get(Number(r.sensor_id));
    return { ...r, direction: m?.direction, segment: m?.segment, location: m?.location };
  }).filter(r=>r.direction && Number.isFinite(r.segment));

  // path_pos
  const orders2 = buildOrders();
  act = act.map(r => ({...r, path_pos: posIndex(r.direction, Number(r.sensor_id), orders2)}))
           .filter(r => r.path_pos!=null);

  // Sort and dedupe first hit per vehicle-direction-sensor
  act.sort((a,b)=>{
    if(a.vehicle_id!==b.vehicle_id) return (a.vehicle_id||'').localeCompare(b.vehicle_id||'');
    if(a.direction!==b.direction) return a.direction.localeCompare(b.direction);
    if(a.path_pos!==b.path_pos) return a.path_pos - b.path_pos;
    return a.ts - b.ts;
  });

  const keySeen = new Set();
  const dedup = [];
  for(const r of act){
    const k = `${r.vehicle_id}|${r.direction}|${r.sensor_id}`;
    if(!keySeen.has(k)){ keySeen.add(k); dedup.push(r); }
  }

  // Compute next_* within vehicle_id + direction
  const groups = new Map();
  for(const r of dedup){
    const k = `${r.vehicle_id}|${r.direction}`;
    if(!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  for(const arr of groups.values())
    arr.sort((a,b)=> a.path_pos===b.path_pos ? a.ts-b.ts : a.path_pos-b.path_pos);

  const links = [];

  for(const [, arr] of groups){
    if(arr.length===0) continue;
    for(let i=0;i<arr.length-1;i++){
      const a = arr[i], b = arr[i+1];
      if((b.path_pos - a.path_pos) === 1){
        const tt = secondsDiff(a.ts, b.ts);
        if(tt>0){
          // Python: link_segment = max(from_segment, to_segment)
const link_segment = a.segment;

          links.push({
            vehicle_id: a.vehicle_id, 
            direction: a.direction,
            link_segment,  // Use max for proper labeling
            from_segment: a.segment, 
            to_segment: b.segment,
            from_sensor_id: a.sensor_id, 
            to_sensor_id: b.sensor_id,
            depart_ts: a.ts, 
            arrive_ts: b.ts, 
            travel_time_s: tt
          });
        }
      }
    }
  }

  const corridor = [];
  for(const [, arr] of groups){
    const first = arr[0], last = arr[arr.length-1];
    if(!first || !last) continue;
    if(last.path_pos > first.path_pos){
      const tt = secondsDiff(first.ts, last.ts);
      if(tt>0){
        corridor.push({
          vehicle_id:first.vehicle_id, 
          direction:first.direction,
          from_segment:first.segment, 
          to_segment:last.segment,
          from_sensor_id:first.sensor_id, 
          to_sensor_id:last.sensor_id,
          depart_ts:first.ts, 
          arrive_ts:last.ts, 
          corridor_tt_s:tt
        });
      }
    }
  }

  return { link_tt: links, corridor_tt: corridor };
}

function extractFullCorridorRuns(activations, dfSegments, vehicleFilter, startHour=14, endHour=18, strict=false){
  let act = activations.filter(r=>r.vehicle_id && r.ts instanceof Date && hourLocal(r.ts)>=startHour && hourLocal(r.ts)<endHour);

  if(vehicleFilter==='transit'){
    act = act.filter(r=>r.transit && Number(r.transit)===1);
  } else if(vehicleFilter==='trucks'){
    act = act.filter(r=>r.truck && Number(r.truck)===1);
  }

  // Attach meta
  const metaBySensor = new Map();
  for(const row of dfSegments){ 
    if(!metaBySensor.has(Number(row.sensor_id))){
      metaBySensor.set(Number(row.sensor_id), row); 
    }
  }
  act = act.map(r=>{
    const m = metaBySensor.get(Number(r.sensor_id));
    return { ...r, direction: m?.direction, segment: m?.segment, location: m?.location };
  }).filter(r=>r.direction && Number.isFinite(r.segment));

  // Sort by vehicle, dir, ts
  act.sort((a,b)=>{
    if(a.vehicle_id!==b.vehicle_id) return (a.vehicle_id||'').localeCompare(b.vehicle_id||'');
    if(a.direction!==b.direction) return a.direction.localeCompare(b.direction);
    return a.ts - b.ts;
  });

  // Group vehicle + direction
  const groups = new Map();
  for(const r of act){ 
    const k = `${r.vehicle_id}|${r.direction}`; 
    if(!groups.has(k)) groups.set(k, []); 
    groups.get(k).push(r); 
  }

  // Orders
  const orders = buildOrders();

  const rows = [];
  for(const [, g] of groups){
    if(g.length===0) continue;
    const dir = String(g[0].direction).trim();
    const order = dir.toLowerCase()==='northbound' ? orders.NB : orders.SB;
    const first_id = order[0];
    const last_id  = order[order.length-1];

    // First hit per sensor in time order
    const seen = new Set();
    const seq = [];
    for(const r of g){
      if(!seen.has(r.sensor_id)){ seen.add(r.sensor_id); seq.push(r.sensor_id); }
    }

    let ok = false;
    if(strict){ 
      ok = seq.length===order.length && seq.every((sid, i)=>sid===order[i]); 
    } else { 
      ok = seq.includes(first_id) && seq.includes(last_id) && seq.indexOf(first_id) < seq.indexOf(last_id); 
    }
    if(!ok) continue;

    const depart_ts = g.find(r=>r.sensor_id===first_id)?.ts;
    const arrive_ts = [...g].reverse().find(r=>r.sensor_id===last_id)?.ts;
    if(!(depart_ts && arrive_ts) || arrive_ts<=depart_ts) continue;

    const tt = secondsDiff(depart_ts, arrive_ts);
    rows.push({
      vehicle_id: g[0].vehicle_id,
      direction: dir,
      depart_ts, 
      arrive_ts,
      corridor_tt_s: tt,
      visited_count: seq.length,
      visited_sensors: seq,
      bin_15min: floor15min(depart_ts),
      corridor_tt_min: tt/60
    });
  }
  return rows;
}

// Builders
function buildCombinedLinks(linksByScenario, startHour, endHour){
  const frames = [];
  for(const [label, rows] of linksByScenario){
    for(const r of rows){
      const h = hourLocal(r.depart_ts);
      if(h>=startHour && h<endHour){
        frames.push({
          scenario: label,
          direction: r.direction,
          segment: r.link_segment || r.from_segment,  // Prefer link_segment
          bin_15min: floor15min(r.depart_ts),
          depart_ts: r.depart_ts,
          arrive_ts: r.arrive_ts,
          travel_time_s: r.travel_time_s,
          vehicle_id: r.vehicle_id
        });
      }
    }
  }
  return frames;
}

function buildCombinedCorridor(runsByScenario){
  const out = [];
  for(const [label, rows] of runsByScenario){
    for(const r of rows){ out.push({ ...r, scenario: label }); }
  }
  return out;
}

// -------- Aggregations --------
function groupBy(arr, keys){
  const map = new Map();
  for(const r of arr){
    const k = keys.map(k=>String(r[k])).join('|');
    if(!map.has(k)) map.set(k, []);
    map.get(k).push(r);
  }
  return map;
}

function segmentSummary(combined){
  const g = groupBy(combined, ['scenario','direction','segment']);
  const rows = [];
  for(const [, arr] of g){
    const tt = arr.map(r=>r.travel_time_s);
    rows.push({
      scenario: arr[0].scenario,
      direction: arr[0].direction,
      segment: arr[0].segment,
      n: tt.length,
      mean_min: (tt.reduce((a,b)=>a+b,0)/tt.length)/60,
      median_min: median(tt)/60,
      p10_min: quantile(tt,0.10)/60,
      p90_min: quantile(tt,0.90)/60,
    });
  }
  rows.sort((a,b)=> a.direction===b.direction ? a.segment-b.segment : a.direction.localeCompare(b.direction));
  return rows;
}

function corridorSummary(combinedCorr){
  const g = groupBy(combinedCorr, ['scenario','direction']);
  const rows = [];
  for(const [, arr] of g){
    const tt = arr.map(r=>r.corridor_tt_s);
    rows.push({
      scenario: arr[0].scenario,
      direction: arr[0].direction,
      n: tt.length,
      mean_min: (tt.reduce((a,b)=>a+b,0)/tt.length)/60,
      median_min: median(tt)/60,
      p10_min: quantile(tt,0.10)/60,
      p90_min: quantile(tt,0.90)/60,
    });
  }
  rows.sort((a,b)=> a.scenario===b.scenario ? a.direction.localeCompare(b.direction) : a.scenario.localeCompare(b.scenario));
  return rows;
}

function fifteenMinMedians(combined){
  const g = groupBy(combined, ['scenario','direction','segment','bin_15min']);
  const rows = [];
  for(const [, arr] of g){
    const tt = arr.map(r=>r.travel_time_s);
    rows.push({
      scenario: arr[0].scenario,
      direction: arr[0].direction,
      segment: arr[0].segment,
      bin_15min: arr[0].bin_15min,
      median_tt_min: median(tt)/60,
    });
  }
  rows.sort((a,b)=> a.bin_15min - b.bin_15min);
  return rows;
}

function corridor15MinMedians(combinedCorr){
  const g = groupBy(combinedCorr, ['scenario','direction','bin_15min']);
  const rows = [];
  for(const [, arr] of g){
    const tt = arr.map(r=>r.corridor_tt_s);
    rows.push({
      scenario: arr[0].scenario,
      direction: arr[0].direction,
      bin_15min: arr[0].bin_15min,
      median_tt_min: median(tt)/60,
    });
  }
  rows.sort((a,b)=> a.bin_15min - b.bin_15min);
  return rows;
}

// --------- Plots ---------
function renderBarBySegment(){
  const dir = $('#directionPick').value;
  const summ = segmentSummary(state.combinedLinks).filter(r=>r.direction.toLowerCase()===dir.toLowerCase());
  if(summ.length===0){ Plotly.purge('plotBarSeg'); return; }
  const segs = Array.from(new Set(summ.map(r=>r.segment))).sort((a,b)=>a-b);
  const scenarios = Array.from(new Set(summ.map(r=>r.scenario))).sort();
  const traces = [];
  for(const sc of scenarios){
    const y = segs.map(s => {
      const row = summ.find(r=>r.segment===s && r.scenario===sc);
      return row ? row.median_min : null;
    });
    traces.push({ type:'bar', name: sc, x: segs.map(String), y });
  }
  const layout = {
    barmode:'group',
    title: `${dir} — Median link travel time by segment (2–5 PM)`,
    xaxis:{ title:'Segment (upstream)' }, 
    yaxis:{ title:'Median travel time (min)' },
    margin:{t:40,r:10,b:50,l:50}, 
    paper_bgcolor:'rgba(0,0,0,0)', 
    plot_bgcolor:'rgba(0,0,0,0)', 
    font:{color:'#e2e8f0'}
  };
  Plotly.newPlot('plotBarSeg', traces, layout, {displayModeBar:true, responsive:true});
}

function renderBoxBySegment(){
  const dir = $('#directionPick').value;
  const df = state.combinedLinks.filter(r=>r.direction.toLowerCase()===dir.toLowerCase());
  if(df.length===0){ Plotly.purge('plotBoxSeg'); return; }
  
  const segs = Array.from(new Set(df.map(r=>r.segment))).sort((a,b)=>a-b);
  const scenarios = Array.from(new Set(df.map(r=>r.scenario))).sort();
  
  // Helper to calculate IQR bounds
  function getIQRBounds(values){
    const q1 = quantile(values, 0.25);
    const q3 = quantile(values, 0.75);
    const iqr = q3 - q1;
    return {
      lower: q1 - 1.5 * iqr,
      upper: q3 + 1.5 * iqr
    };
  }
  
  // Calculate y-axis range based on IQR whiskers across all data
  const allY = df.map(r=>r.travel_time_s/60);
  const bounds = getIQRBounds(allY);
  // Not needed const ymax = Math.ceil(bounds.upper * 1.1); // 10% padding above upper whisker
  // Round up to nearest 2 minutes for cleaner scale
  const ymax = Math.ceil(bounds.upper * 1.2 / 2) * 2;
  
  const traces = [];
  for(const sc of scenarios){
    const x = [], y = [];
    for(const s of segs){
      const vals = df.filter(r=>r.segment===s && r.scenario===sc).map(r=>r.travel_time_s/60);
      if(vals.length){ 
        // Filter to include only values within IQR bounds for this segment
        const segBounds = getIQRBounds(vals);
        for(const v of vals){ 
          if(v >= segBounds.lower && v <= segBounds.upper){
            x.push(String(s)); 
            y.push(v); 
          }
        }
      }
    }
    traces.push({ type:'box', name: sc, x, y, boxpoints:false });
  }
  
  const layout = { 
    boxmode:'group', 
    title:`${dir} — Link travel times by segment (2–5 PM)`, 
    xaxis:{ title:'Segment' }, 
    yaxis:{ 
      title:'Travel time (min)',
      range: [0, ymax]
    }, 
    margin:{t:40,r:10,b:50,l:50}, 
    paper_bgcolor:'rgba(0,0,0,0)', 
    plot_bgcolor:'rgba(0,0,0,0)', 
    font:{color:'#e2e8f0'} 
  };
  Plotly.newPlot('plotBoxSeg', traces, layout, {displayModeBar:true, responsive:true});
}

function renderSegmentTimeSeries(){
  const dir = $('#directionPick').value;
  const seg = Number($('#segmentPick').value);
  const ts = fifteenMinMedians(state.combinedLinks).filter(r=>r.direction.toLowerCase()===dir.toLowerCase() && r.segment===seg);
  if(ts.length===0){ Plotly.purge('plotTsSeg'); return; }
  const scenarios = Array.from(new Set(ts.map(r=>r.scenario))).sort();
  const traces = scenarios.map(sc => ({
    type:'scatter', mode:'lines+markers', name: sc,
    x: ts.filter(r=>r.scenario===sc).map(r=>r.bin_15min),
    y: ts.filter(r=>r.scenario===sc).map(r=>r.median_tt_min)
  }));
  const layout = { 
    title:`${dir} — Segment ${seg}: 15-min median travel time`, 
    xaxis:{ title:'Time' }, 
    yaxis:{ title:'Median travel time (min)' }, 
    margin:{t:40,r:10,b:50,l:50}, 
    paper_bgcolor:'rgba(0,0,0,0)', 
    plot_bgcolor:'rgba(0,0,0,0)', 
    font:{color:'#e2e8f0'} 
  };
  Plotly.newPlot('plotTsSeg', traces, layout, {displayModeBar:true, responsive:true});
}

function renderCorridorBox(){
  const dir = $('#directionPick').value;
  const df = state.combinedCorr.filter(r=>r.direction.toLowerCase()===dir.toLowerCase());
  if(df.length===0){ Plotly.purge('plotBoxCorr'); return; }
  const scenarios = Array.from(new Set(df.map(r=>r.scenario))).sort();
  const traces = scenarios.map(sc => ({
    type:'box', name:sc,
    x: Array(df.filter(r=>r.scenario===sc).length).fill(sc),
    y: df.filter(r=>r.scenario===sc).map(r=>r.corridor_tt_min)
  }));
  const layout = { 
    boxmode:'group', 
    title:`${dir} — Corridor travel times (2–5 PM)`, 
    xaxis:{ title:'Scenario' }, 
    yaxis:{ title:'Travel time (min)' }, 
    margin:{t:40,r:10,b:50,l:50}, 
    paper_bgcolor:'rgba(0,0,0,0)', 
    plot_bgcolor:'rgba(0,0,0,0)', 
    font:{color:'#e2e8f0'} 
  };
  Plotly.newPlot('plotBoxCorr', traces, layout, {displayModeBar:true, responsive:true});
}

function renderCorridorTimeSeries(){
  const dir = $('#directionPick').value;
  const ts = corridor15MinMedians(state.combinedCorr).filter(r=>r.direction.toLowerCase()===dir.toLowerCase());
  if(ts.length===0){ Plotly.purge('plotTsCorr'); return; }
  const scenarios = Array.from(new Set(ts.map(r=>r.scenario))).sort();
  const traces = scenarios.map(sc => ({
    type:'scatter', mode:'lines+markers', name: sc,
    x: ts.filter(r=>r.scenario===sc).map(r=>r.bin_15min),
    y: ts.filter(r=>r.scenario===sc).map(r=>r.median_tt_min)
  }));
  const layout = { 
    title:`${dir} — Corridor 15-min median travel time`, 
    xaxis:{ title:'Time' }, 
    yaxis:{ title:'Median travel time (min)' }, 
    margin:{t:40,r:10,b:50,l:50}, 
    paper_bgcolor:'rgba(0,0,0,0)', 
    plot_bgcolor:'rgba(0,0,0,0)', 
    font:{color:'#e2e8f0'} 
  };
  Plotly.newPlot('plotTsCorr', traces, layout, {displayModeBar:true, responsive:true});
}

function renderCorridorBar(){
  const dir = $('#directionPick').value;
  const summ = corridorSummary(state.combinedCorr);
  const df = summ.filter(r=>r.direction.toLowerCase()===dir.toLowerCase());
  
  if(df.length===0){ Plotly.purge('plotBarCorr'); return; }
  
  // Sort by scenario for consistent ordering
  df.sort((a,b)=>a.scenario.localeCompare(b.scenario));
  
  const scenarios = df.map(d=>d.scenario);
  const y = df.map(d=>d.mean_min);
  
  // Use Plotly's default color scheme (matches other charts automatically)
  const traces = df.map((d, i) => ({
    type: 'bar',
    name: d.scenario,
    x: [d.scenario],
    y: [d.mean_min],
    error_y: {
      type: 'data',
      symmetric: false,
      array: [d.p90_min - d.mean_min],
      arrayminus: [d.mean_min - d.p10_min]
    },
    text: [d.mean_min.toFixed(1)],
    textposition: 'outside',
    textfont: { color: '#e2e8f0' }
    // No marker.color - let Plotly assign colors automatically
  }));
  
  const layout = {
    title: `${dir} — Mean corridor travel time (2–5 PM)`,
    xaxis: { title: 'Scenario' },
    yaxis: { title: 'Mean travel time (min)' },
    margin: {t:40, r:120, b:60, l:50}, // Increased right margin for legend
    paper_bgcolor: 'rgba(0,0,0,0)',
    plot_bgcolor: 'rgba(0,0,0,0)',
    font: {color:'#e2e8f0'},
    showlegend: true,
    legend: { 
      x: 1.02,      // Position outside plot area
      xanchor: 'left',
      y: 1,
      yanchor: 'top'
    }
  };
  
  Plotly.newPlot('plotBarCorr', traces, layout, {displayModeBar:true, responsive:true});
}

function renderSummaryTable(){
  const rows = corridorSummary(state.combinedCorr);
  const host = $('#summaryTable');
  host.innerHTML = '';
  if(rows.length===0) return;
  const table = document.createElement('table');
  const thead = document.createElement('thead');
  thead.innerHTML = `<tr><th>Scenario</th><th>Direction</th><th>n</th><th>Mean (min)</th><th>Median (min)</th><th>P10 (min)</th><th>P90 (min)</th></tr>`;
  const tbody = document.createElement('tbody');
  for(const r of rows){
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${r.scenario}</td><td>${r.direction}</td><td>${r.n}</td><td>${r.mean_min.toFixed(2)}</td><td>${r.median_min.toFixed(2)}</td><td>${r.p10_min.toFixed(2)}</td><td>${r.p90_min.toFixed(2)}</td>`;
    tbody.appendChild(tr);
  }
  table.appendChild(thead); 
  table.appendChild(tbody); 
  host.appendChild(table);
}

function refreshSegmentPicker(){
  const dir = $('#directionPick').value;
  const segs = Array.from(new Set(state.combinedLinks.filter(r=>r.direction.toLowerCase()===dir.toLowerCase()).map(r=>r.segment))).sort((a,b)=>a-b);
  const sel = $('#segmentPick');
  sel.innerHTML = '';
  for(const s of segs){ 
    const opt = document.createElement('option'); 
    opt.value = s; 
    opt.textContent = s; 
    sel.appendChild(opt); 
  }
}

function renderAll(){
  refreshSegmentPicker();
  renderBarBySegment();
  renderBoxBySegment();
  renderSegmentTimeSeries();
  renderCorridorBox();
  renderCorridorTimeSeries();
  renderCorridorBar();  
  renderSummaryTable();
}

// ------- UI wiring -------
function addScenarioRow(){
  scenarioCounter += 1;
  const container = document.createElement('div');
  container.className = 'scenario';
  container.innerHTML = `
    <div class="scenario-row">
      <div class="col">
        <label>Scenario label</label>
        <input type="text" value="Scenario ${scenarioCounter}" />
      </div>
      <div class="col">
        <label>File (CSV or Excel)</label>
        <input type="file" accept=".csv,.txt,.xlsx,.xls" />
      </div>
    </div>
    <div class="row" style="justify-content:flex-end; gap:6px;">
      <button class="ghost" data-act="remove">Remove</button>
    </div>`;
  $('#scenarios').appendChild(container);
}

// Init with three scenario rows
addScenarioRow(); 
addScenarioRow(); 
addScenarioRow();

$('#addScenario').addEventListener('click', addScenarioRow);
$('#scenarios').addEventListener('click', (e)=>{
  if(e.target.matches('button[data-act="remove"]')){ 
    e.target.closest('.scenario').remove(); 
  }
});

// Properly resize plots when switching tabs
function resizePlotByPanel(id){
  const graphId =
    id === 'barSeg' ? 'plotBarSeg' :
    id === 'boxSeg' ? 'plotBoxSeg' :
    id === 'tsSeg'  ? 'plotTsSeg'  :
    id === 'boxCorr'? 'plotBoxCorr':
    id === 'tsCorr' ? 'plotTsCorr' :
    id === 'barCorr'? 'plotBarCorr': 
    null;
  if(graphId){
    const el = document.getElementById(graphId);
    if(el) Plotly.Plots.resize(el);
  }
}

$$('.tab').forEach(tab=>{
  tab.addEventListener('click', ()=>{
    $$('.tab').forEach(t=>t.classList.remove('active'));
    tab.classList.add('active');
    const id = tab.dataset.tab;
    $$('.panel').forEach(p=>p.classList.remove('active'));
    $('#'+id).classList.add('active');
    setTimeout(()=>resizePlotByPanel(id), 100);
  });
});  // <--- ADD THIS LINE

$('#directionPick').addEventListener('change', ()=>{ renderAll(); });
$('#segmentPick').addEventListener('change', ()=>{ renderSegmentTimeSeries(); });

$('#dlCombined').addEventListener('click', ()=> downloadCSV('combined_links.csv', state.combinedLinks.map(r=>({
  scenario:r.scenario, 
  direction:r.direction, 
  segment:r.segment,
  bin_15min: new Date(r.bin_15min).toISOString(),
  depart_ts: new Date(r.depart_ts).toISOString(),
  arrive_ts: new Date(r.arrive_ts).toISOString(),
  travel_time_s:r.travel_time_s, 
  vehicle_id:r.vehicle_id
}))));

$('#dlCorridor').addEventListener('click', ()=> downloadCSV('combined_corridor.csv', state.combinedCorr.map(r=>({
  scenario:r.scenario, 
  direction:r.direction,
  depart_ts: new Date(r.depart_ts).toISOString(),
  arrive_ts: new Date(r.arrive_ts).toISOString(),
  corridor_tt_s:r.corridor_tt_s,
  visited_count:r.visited_count,
  visited_sensors: (r.visited_sensors||[]).join('|'),
  bin_15min: new Date(r.bin_15min).toISOString(),
  corridor_tt_min:r.corridor_tt_min
}))));

$('#run').addEventListener('click', async ()=>{
  try{
    setStatus('Parsing segment catalog...');
    state.dfSegments = []; 
    state.activations.clear(); 
    state.links.clear(); 
    state.corridors.clear();
    state.combinedLinks = []; 
    state.combinedCorr = [];

    const segFile = $('#segmentFile').files[0];
    if(!segFile) throw new Error('Please choose a segment catalog file');
    await loadSegmentCatalog(segFile);
    log(' ✓ Segment catalog loaded.');
console.log('Segments found:', state.dfSegments.filter(d => d.direction.toLowerCase() === 'northbound').map(d => ({seg: d.segment, sensor: d.sensor_id})));
console.log('NB order:', state.sensorsByDir.NB);


const scenarioNodes = $$('#scenarios .scenario');
    if(scenarioNodes.length===0) throw new Error('Add at least one scenario');
    const vf = $('#vehicleFilter').value;
    const strict = $('#strictMatch').value === 'true';
    const startH = Number($('#startHour').value)||14;
    const endH = Number($('#endHour').value)||18;

    const runsByScenario = new Map();

    for(let i=0;i<scenarioNodes.length;i++){
      const node = scenarioNodes[i];
      const label = node.querySelector('input[type="text"]').value.trim() || `Scenario ${i+1}`;
      const file = node.querySelector('input[type="file"]').files[0];
      if(!file){ log(` • ${label}: no file selected, skipping.`); continue; }

      setStatus(`Reading VRC report for ${label}...`);
      const {activations} = await readVRCSensorReport(file);
      state.activations.set(label, activations);
      log(` ✓ ${label}: activations ${activations.length.toLocaleString()}`);

      const {link_tt, corridor_tt} = computeLinkAndCorridor(activations, vf, state.dfSegments);
      state.links.set(label, link_tt);
      log(`   ↳ links: ${link_tt.length.toLocaleString()}`);

      const fullRuns = extractFullCorridorRuns(activations, state.dfSegments, vf, startH, endH, strict);
      state.corridors.set(label, fullRuns);
      runsByScenario.set(label, fullRuns);
      log(`   ↳ corridor runs: ${fullRuns.length.toLocaleString()}`);
    }

    state.combinedLinks = buildCombinedLinks(state.links, startH, endH);
    state.combinedCorr  = buildCombinedCorridor(runsByScenario);

    $('#dlCombined').disabled = state.combinedLinks.length===0;
    $('#dlCorridor').disabled = state.combinedCorr.length===0;

    setStatus(`Done. Links: ${state.combinedLinks.length.toLocaleString()}  Corridor rows: ${state.combinedCorr.length.toLocaleString()}`);

    renderAll();
  } catch(err){
    console.error(err);
    setStatus('Error: ' + err.message);
  }
});