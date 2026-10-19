// Aircraft tracking: look up aircraft by callsign, registration, ICAO hex or type; worldwide military and
// emergency traffic; large business jets; cargo-hub activity; flight routes and photos.
// Sources: adsb.lol and airplanes.live (open community ADS-B networks), planespotters.net (photos).
'use strict';

module.exports = ({ cached, get, mapAircraft, req }) => {
  const fail = (msg, status = 502) => { const e = new Error(msg); e.status = status; return e; };
  async function mapLimit(items, n, fn) {
    const out = new Array(items.length); let i = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
    return out;
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  // adsb.lol rate-limits bursts (HTTP 429), so requests from this instance are spaced out
  let nextSlot = 0;
  const pace = async () => { const now = Date.now(), at = Math.max(now, nextSlot); nextSlot = at + 350; if (at > now) await sleep(at - now); };
  // Both networks expose the same readsb-style v2 API; only the squawk path differs.
  const NETS = [['adsb.lol', 'https://api.adsb.lol/v2'], ['airplanes.live', 'https://api.airplanes.live/v2']];
  async function feed(path, ttl = 10e3) {
    return cached('air:' + path, ttl, async () => {
      const errs = [];
      for (const [src, base] of NETS) {
        const url = base + (src === 'airplanes.live' ? path.replace(/^\/sqk\//, '/squawk/') : path);
        try {
          let r;
          for (let k = 0; k < 3; k++) {
            if (src === 'adsb.lol') await pace();
            r = await get(url, { Accept: 'application/json' }, 10000);
            if (r.status !== 429) break;
            await sleep(1200 * (k + 1));
          }
          if (!r.ok) throw new Error(`${src} ${r.status}`);
          const j = await r.json();
          return { src, t: j.now || Date.now(), ac: (j.ac || j.aircraft || []).filter(a => a.t !== 'TWR' && !/^C/.test(a.category || '')).map(mapAircraft) };
        } catch (e) { errs.push(e.message); }
      }
      throw fail('Aircraft data unavailable: ' + errs.join('; '));
    });
  }
  const merge = lists => {
    const m = new Map();
    for (const l of lists) for (const a of l) if (!m.has(a.hex)) m.set(a.hex, a);
    return [...m.values()];
  };

  // ------------------------------------------------------------ search: callsign, registration, hex or type
  async function air(p) {
    const q = req(p, 'q').toUpperCase().replace(/\s+/g, '');
    if (!/^[A-Z0-9-]{2,10}$/.test(q)) throw fail('Enter a callsign (UAL123), registration (N12345), ICAO hex (a1b2c3) or type code (B748)', 400);
    const paths = [];
    if (/^[0-9A-F]{6}$/.test(q)) paths.push('/hex/' + q.toLowerCase());
    if (/^[A-Z0-9]{2,8}$/.test(q)) paths.push('/callsign/' + q);
    if (/^[A-Z0-9-]{2,10}$/.test(q)) paths.push('/reg/' + q);
    if (/^[A-Z][A-Z0-9]{1,3}$/.test(q)) paths.push('/type/' + q);
    const res = await Promise.allSettled(paths.map(x => feed(x, 15e3)));
    const okd = res.filter(r => r.status === 'fulfilled').map(r => r.value);
    if (!okd.length) throw res[0].reason;
    return { q, src: okd[0].src, ac: merge(okd.map(r => r.ac)).slice(0, 500) };
  }

  // ------------------------------------------------------------ positions for tracked aircraft
  async function airhex(p) {
    const ids = [...new Set((p.get('hex') || '').toLowerCase().split(',').map(s => s.trim()).filter(s => /^~?[0-9a-f]{6}$/.test(s)))].slice(0, 30);
    if (!ids.length) throw fail('missing ?hex=', 400);
    const res = await mapLimit(ids, 4, id => feed('/hex/' + id, 8e3).then(r => r, () => null));
    const okd = res.filter(Boolean);
    if (!okd.length) throw fail('Aircraft data unavailable');
    return { src: okd[0].src, ac: merge(okd.map(r => r.ac)) };
  }

  // ------------------------------------------------------------ worldwide military aircraft
  const airmil = () => feed('/mil', 20e3);

  // ------------------------------------------------------------ emergency squawks
  const SQUAWKS = { 7500: 'Unlawful interference (hijack)', 7600: 'Radio failure', 7700: 'General emergency' };
  async function airsq() {
    const res = await Promise.allSettled(Object.keys(SQUAWKS).map(c => feed('/sqk/' + c, 20e3)));
    const okd = res.filter(r => r.status === 'fulfilled').map(r => r.value);
    if (!okd.length) throw res[0].reason;
    return { src: okd[0].src, codes: SQUAWKS, ac: merge(okd.map(r => r.ac)) };
  }

  // ------------------------------------------------------------ large-cabin business jets in the air worldwide
  const BIZ = { GLF6: 'Gulfstream G650', GA7C: 'Gulfstream G700', GA8C: 'Gulfstream G800', GLF5: 'Gulfstream G550', GA6C: 'Gulfstream G600', GLF4: 'Gulfstream IV',
    GL7T: 'Bombardier Global 7500', GLEX: 'Bombardier Global 6000', GL5T: 'Bombardier Global 5000', FA7X: 'Dassault Falcon 7X', FA8X: 'Dassault Falcon 8X',
    CL35: 'Challenger 350', C700: 'Citation Longitude', C68A: 'Citation Latitude' };
  async function airbiz() {
    return cached('air:biz', 120e3, async () => {
      const res = await mapLimit(Object.keys(BIZ), 2, t => feed('/type/' + t, 120e3).then(r => r, () => null));
      const okd = res.filter(Boolean);
      if (!okd.length) throw fail('Aircraft data unavailable');
      const missing = Object.keys(BIZ).filter((t, i) => !res[i]);
      return { src: okd[0].src, types: BIZ, missing, ac: merge(okd.map(r => r.ac)) };
    });
  }

  // ------------------------------------------------------------ cargo hub activity
  // [code, name, lat, lon]
  const HUBS = [
    ['MEM', 'Memphis — FedEx World Hub', 35.042, -89.977], ['SDF', 'Louisville — UPS Worldport', 38.174, -85.736],
    ['CVG', 'Cincinnati — Amazon Air & DHL hub', 39.049, -84.668], ['IND', 'Indianapolis — FedEx', 39.717, -86.294],
    ['ONT', 'Ontario, CA — UPS West', 34.056, -117.601], ['ANC', 'Anchorage — transpacific cargo', 61.174, -149.996],
    ['LEJ', 'Leipzig — DHL Europe hub', 51.424, 12.236], ['CGN', 'Cologne — UPS Europe hub', 50.866, 7.143],
    ['HKG', 'Hong Kong — Air Hong Kong, DHL, FedEx, UPS', 22.308, 113.918], ['PVG', 'Shanghai Pudong — China Cargo, FedEx, UPS', 31.143, 121.805],
  ];
  // ICAO designators of all-cargo operators (passenger airlines' freighters share their passenger callsigns, so they are not counted)
  const CARGO_OPS = { FDX: 'FedEx', UPS: 'UPS', GTI: 'Atlas', ATN: 'ATI (Amazon)', ABX: 'ABX (Amazon/DHL)', CKS: 'Kalitta', CLX: 'Cargolux', BCS: 'DHL (EAT)', DHK: 'DHL UK',
    BOX: 'AeroLogic', DAE: 'DHL Aero Expreso', GEC: 'Lufthansa Cargo', PAC: 'Polar', WGN: 'Western Global', SCX: 'Sun Country (Amazon)', AJT: 'Amerijet', NCA: 'Nippon Cargo',
    CKK: 'China Cargo', CAO: 'Air China Cargo', CSS: 'SF Airlines', CSH: 'Shanghai Airlines Cargo', YZR: 'Yangtze River Express', ABW: 'AirBridgeCargo', MPH: 'Martinair Cargo',
    AHK: 'Air Hong Kong', SQC: 'Singapore Airlines Cargo', MSX: 'Egyptair Cargo', TPA: 'Avianca Cargo', LCO: 'LATAM Cargo', KYE: 'Sky Lease Cargo', NAC: 'Northern Air Cargo' };
  const opOf = cs => (cs || '').slice(0, 3);
  async function airhubs() {
    return cached('air:hubs', 120e3, async () => {
      let src = null;
      const hubs = await mapLimit(HUBS, 2, async ([code, name, lat, lon]) => {
        try {
          const r = await feed(`/point/${lat}/${lon}/30`, 120e3);
          src = src || r.src;
          const ops = {};
          let cargo = 0, gnd = 0, arr = 0, dep = 0;
          for (const a of r.ac) {
            const op = opOf(a.cs);
            if (CARGO_OPS[op]) { cargo++; ops[op] = (ops[op] || 0) + 1; }
            if (a.gnd) gnd++;
            else if ((a.alt ?? 99999) < 12000) { if ((a.vr ?? 0) < -300) arr++; else if ((a.vr ?? 0) > 300) dep++; }
          }
          return { code, name, lat, lon, total: r.ac.length, cargo, gnd, arr, dep, ops };
        } catch (e) { return { code, name, lat, lon, err: e.message }; }
      });
      if (!hubs.some(h => !h.err)) throw fail('Aircraft data unavailable: ' + hubs[0].err);
      return { src, radiusNm: 30, ops: CARGO_OPS, hubs };
    });
  }

  // ------------------------------------------------------------ flight routes (origin/destination by callsign)
  const routeCache = new Map(); // callsign -> { t, v } (v null = no route known)
  async function airroute(p) {
    const planes = (p.get('cs') || '').split(',').map(x => x.split(':')).filter(([cs]) => /^[A-Z0-9]{3,8}$/i.test(cs || '')).slice(0, 25)
      .map(([cs, lat, lon]) => ({ callsign: cs.toUpperCase(), lat: Number(lat) || 0, lng: Number(lon) || 0 }));
    if (!planes.length) throw fail('missing ?cs=CALLSIGN:lat:lon', 400);
    const fresh = cs => { const h = routeCache.get(cs); return h && Date.now() - h.t < 30 * 60e3; };
    const need = planes.filter(x => !fresh(x.callsign));
    if (need.length) {
      const r = await fetch('https://api.adsb.lol/api/0/routeset', {
        method: 'POST', body: JSON.stringify({ planes: need }), signal: AbortSignal.timeout(10000),
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      });
      if (!r.ok) throw fail('adsb.lol routes ' + r.status);
      const res = await r.json();
      need.forEach(x => routeCache.set(x.callsign, { t: Date.now(), v: null }));
      for (const x of Array.isArray(res) ? res : []) {
        if (!x || !x.callsign || !routeCache.has(x.callsign)) continue;
        routeCache.set(x.callsign, { t: Date.now(), v: {
          route: x._airport_codes_iata || x.airport_codes || '', plausible: x.plausible !== 0 && x.plausible !== false,
          airports: (x._airports || []).map(a => ({ iata: a.iata, icao: a.icao, name: a.name, city: a.location, cc: a.countryiso2, lat: a.lat, lon: a.lon })),
        } });
      }
      if (routeCache.size > 5000) routeCache.clear();
    }
    const routes = {};
    for (const x of planes) { const v = routeCache.get(x.callsign)?.v; if (v && v.route && v.route !== 'unknown') routes[x.callsign] = v; }
    return { src: 'adsb.lol route database', routes };
  }

  // ------------------------------------------------------------ aircraft photo
  async function airphoto(p) {
    const hex = (p.get('hex') || '').toLowerCase();
    if (!/^[0-9a-f]{6}$/.test(hex)) throw fail('missing ?hex=', 400);
    return cached('photo:' + hex, 24 * 3600e3, async () => {
      const r = await get('https://api.planespotters.net/pub/photos/hex/' + hex, { Accept: 'application/json' }, 10000);
      if (!r.ok) throw fail('planespotters ' + r.status);
      const ph = (await r.json()).photos?.[0];
      return ph ? { src: ph.thumbnail?.src, large: ph.thumbnail_large?.src, link: ph.link, by: ph.photographer } : { src: null };
    });
  }

  return { air, airhex, airmil, airsq, airbiz, airhubs, airroute, airphoto };
};
