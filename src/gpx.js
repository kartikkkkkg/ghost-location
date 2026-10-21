// Minimal GPX 1.1 build/parse for route exchange. Parsing is intentionally
// regex-based: it runs in the renderer (no DOM dependency) and in tests.
const escXml = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function buildGpx({ name = 'Roam route', coordinates = [], waypoints = [] } = {}) {
  const wpts = waypoints.map(p => `  <wpt lat="${Number(p.latitude)}" lon="${Number(p.longitude)}"><name>${escXml(p.label || '')}</name></wpt>`).join('\n');
  const trkpts = coordinates.map(([lon, lat]) => `    <trkpt lat="${Number(lat)}" lon="${Number(lon)}"></trkpt>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Roam" xmlns="http://www.topografix.com/GPX/1/1">\n  <metadata><name>${escXml(name)}</name></metadata>\n${wpts}\n  <trk><name>${escXml(name)}</name><trkseg>\n${trkpts}\n  </trkseg></trk>\n</gpx>\n`;
}

function collect(tag, source) {
  const out = [];
  const tagPattern = new RegExp(`<${tag}\\b([^>]*)>`, 'gi');
  let match;
  while ((match = tagPattern.exec(source))) {
    const lat = /\blat="([\d.eE+-]+)"/.exec(match[1])?.[1];
    const lon = /\blon="([\d.eE+-]+)"/.exec(match[1])?.[1];
    if (lat != null && lon != null) {
      const point = [Number(lon), Number(lat)];
      if (Number.isFinite(point[0]) && Number.isFinite(point[1])) out.push(point);
    }
  }
  return out;
}

export function parseGpx(source) {
  if (typeof source !== 'string' || !source.includes('<')) return [];
  for (const tag of ['trkpt', 'rtept', 'wpt']) {
    const points = collect(tag, source);
    if (points.length >= 2) return points;
  }
  return [];
}
