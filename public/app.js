import {
  MAX_POINTS,
  DEFAULT_AVOID,
  idxLabel,
  buildMapsUrls,
  decodePolyline,
  nearestLegIndex,
} from './lib.js';

const $ = (sel) => document.querySelector(sel);
const TOKEN_KEY = 'routePlanner.editToken';

function storageGet(key) {
  try {
    return localStorage.getItem(key) || '';
  } catch {
    return '';
  }
}
function storageSet(key, value) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    /* storage unavailable: token just won't persist */
  }
}

const state = {
  id: null,
  name: '',
  notes: '',
  points: [],
  avoid: { ...DEFAULT_AVOID },
  canEdit: false,
  dirty: false,
  fitNext: false,
  token: storageGet(TOKEN_KEY),
  route: null, // last computed route preview: { path, legs, distanceMeters, seconds }
};

let config = null;
let map = null;
let AdvancedMarkerElement = null;
let markers = [];
let routeLine = null;
let routeAbort = null;
let routeTimer = null;

/* ---------- small helpers ---------- */

function status(message, kind = '') {
  const el = $('#status');
  el.textContent = message;
  el.dataset.kind = kind;
}

async function api(path, { method = 'GET', body } = {}) {
  const headers = {};
  if (state.token) headers['X-Edit-Token'] = state.token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function pointLabel(i) {
  const p = state.points[i];
  if (p.label) return p.label;
  if (i === 0) return 'Start';
  if (i === state.points.length - 1) return 'Destination';
  return `Stop ${idxLabel(i)}`;
}

function toLatLng(p) {
  return typeof p.lat === 'function' ? { lat: p.lat(), lng: p.lng() } : { lat: p.lat, lng: p.lng };
}

/* ---------- Google Maps loading ---------- */

function loadMaps(key) {
  return new Promise((resolve, reject) => {
    window.__gmapsReady = resolve;
    window.gm_authFailure = () =>
      status('Google rejected the API key. Check its restrictions, enabled APIs, and billing.', 'error');
    const s = document.createElement('script');
    s.src =
      'https://maps.googleapis.com/maps/api/js?key=' +
      encodeURIComponent(key) +
      '&v=weekly&loading=async&callback=__gmapsReady';
    s.async = true;
    s.onerror = () => reject(new Error('Could not load Google Maps.'));
    document.head.appendChild(s);
  });
}

async function initMap() {
  const { Map } = await google.maps.importLibrary('maps');
  ({ AdvancedMarkerElement } = await google.maps.importLibrary('marker'));
  map = new Map($('#map'), {
    center: { lat: 39.5, lng: -98.35 },
    zoom: 4,
    mapId: config.mapId,
    clickableIcons: false,
    streetViewControl: false,
    fullscreenControl: false,
    gestureHandling: 'greedy',
  });
  map.addListener('click', (e) => {
    if (!state.canEdit) return;
    addPoint({ lat: e.latLng.lat(), lng: e.latLng.lng(), label: '' });
  });
}

async function initSearch() {
  try {
    const { PlaceAutocompleteElement } = await google.maps.importLibrary('places');
    const ac = new PlaceAutocompleteElement({});
    ac.setAttribute('placeholder', 'Search for an address or place');
    const onSelect = async (ev) => {
      try {
        const place = ev.placePrediction ? ev.placePrediction.toPlace() : ev.place;
        await place.fetchFields({ fields: ['location', 'displayName'] });
        addPoint({
          lat: place.location.lat(),
          lng: place.location.lng(),
          label: (place.displayName || '').slice(0, 80),
        });
        map.panTo(place.location);
      } catch (e) {
        status('Could not add that place: ' + e.message, 'error');
      }
    };
    ac.addEventListener('gmp-select', onSelect);
    ac.addEventListener('gmp-placeselect', onSelect); // older API versions
    $('#search').appendChild(ac);
  } catch {
    $('#search').textContent = 'Place search is unavailable (enable Places API (New) on your key). You can still click the map.';
  }
}

/* ---------- Routes API preview ---------- */

async function computeRoute(points, avoid, signal) {
  const wp = (p) => ({ location: { latLng: { latitude: p.lat, longitude: p.lng } } });
  const body = {
    origin: wp(points[0]),
    destination: wp(points[points.length - 1]),
    intermediates: points.slice(1, -1).map(wp),
    travelMode: 'DRIVE',
    routingPreference: 'TRAFFIC_UNAWARE',
    routeModifiers: {
      avoidHighways: Boolean(avoid.highways),
      avoidTolls: Boolean(avoid.tolls),
      avoidFerries: Boolean(avoid.ferries),
    },
    units: 'IMPERIAL',
  };
  const res = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': config.mapsKey,
      'X-Goog-FieldMask':
        'routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline,routes.legs.polyline.encodedPolyline',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error?.message || `Routes API error (${res.status})`);
  }
  const data = await res.json();
  const r = data.routes && data.routes[0];
  if (!r) throw new Error('Google found no drivable route between these points with the current options.');
  return {
    distanceMeters: r.distanceMeters || 0,
    seconds: parseInt(r.duration, 10) || 0,
    path: decodePolyline(r.polyline.encodedPolyline),
    legs: (r.legs || []).map((l) => decodePolyline(l.polyline.encodedPolyline)),
  };
}

function scheduleRoute() {
  clearTimeout(routeTimer);
  routeTimer = setTimeout(updateRoute, 500);
}

function clearLine() {
  if (routeLine) routeLine.setMap(null);
  routeLine = null;
  state.route = null;
}

async function updateRoute() {
  if (routeAbort) routeAbort.abort();
  if (state.points.length < 2) {
    clearLine();
    $('#summary').textContent = state.points.length
      ? 'Add a second point to see the route.'
      : state.canEdit
        ? 'Click the map or search for a place to start.'
        : '';
    status('');
    return;
  }
  const mine = new AbortController();
  routeAbort = mine;
  status('Calculating route…');
  try {
    const r = await computeRoute(state.points, state.avoid, mine.signal);
    if (mine.signal.aborted) return;
    state.route = r;
    drawLine(r);
    const miles = r.distanceMeters / 1609.344;
    const mins = Math.max(1, Math.round(r.seconds / 60));
    $('#summary').textContent = `${miles.toFixed(1)} mi · about ${mins} min (without traffic)`;
    status('');
  } catch (e) {
    if (e.name === 'AbortError') return;
    clearLine();
    $('#summary').textContent = '';
    status(e.message, 'error');
  }
}

function drawLine(r) {
  if (routeLine) routeLine.setMap(null);
  routeLine = new google.maps.Polyline({
    map,
    path: r.path,
    strokeColor: '#1a73e8',
    strokeOpacity: 0.85,
    strokeWeight: 6,
    clickable: state.canEdit,
    zIndex: 1,
  });
  routeLine.addListener('click', (e) => {
    if (!state.canEdit || !state.route) return;
    const clicked = { lat: e.latLng.lat(), lng: e.latLng.lng() };
    const leg = nearestLegIndex(state.route.legs, clicked);
    const at = leg < 0 ? state.points.length - 1 : leg + 1;
    insertPoint(at, { ...clicked, label: '' });
  });
  if (state.fitNext) {
    state.fitNext = false;
    const bounds = new google.maps.LatLngBounds();
    r.path.forEach((p) => bounds.extend(p));
    map.fitBounds(bounds, 48);
  }
}

/* ---------- points ---------- */

function insertPoint(index, point) {
  if (state.points.length >= MAX_POINTS) {
    status(`A route can have at most ${MAX_POINTS} points.`, 'error');
    return;
  }
  const isFirst = state.points.length === 0;
  state.points.splice(index, 0, point);
  changed(true);
  if (isFirst && map) {
    // The map starts zoomed out; jump in on the first point so the next click is precise.
    map.panTo({ lat: point.lat, lng: point.lng });
    if ((map.getZoom() || 0) < 11) map.setZoom(11); // roughly 30-40 miles across
  }
}

function addPoint(point) {
  insertPoint(state.points.length, point);
}

function removePoint(i) {
  state.points.splice(i, 1);
  changed(true);
}

function movePoint(i, delta) {
  const j = i + delta;
  if (j < 0 || j >= state.points.length) return;
  [state.points[i], state.points[j]] = [state.points[j], state.points[i]];
  changed(true);
}

function changed(structural) {
  state.dirty = true;
  renderPoints();
  renderLinks();
  if (structural) renderMarkers();
  updateButtons();
  scheduleRoute();
}

/* ---------- rendering ---------- */

function renderMarkers() {
  markers.forEach((m) => {
    m.map = null;
  });
  markers = state.points.map((p, i) => {
    const el = document.createElement('div');
    el.className = 'pin' + (i === 0 ? ' start' : i === state.points.length - 1 ? ' end' : '');
    el.textContent = idxLabel(i);
    el.title = pointLabel(i);
    const marker = new AdvancedMarkerElement({
      map,
      position: { lat: p.lat, lng: p.lng },
      content: el,
      gmpDraggable: state.canEdit,
      zIndex: 10,
    });
    marker.addListener('dragend', () => {
      const pos = toLatLng(marker.position);
      state.points[i].lat = Math.round(pos.lat * 1e6) / 1e6;
      state.points[i].lng = Math.round(pos.lng * 1e6) / 1e6;
      changed(false);
    });
    el.addEventListener('dblclick', (ev) => {
      ev.stopPropagation();
      if (state.canEdit) removePoint(i);
    });
    return marker;
  });
}

function renderPoints() {
  const list = $('#points');
  list.replaceChildren();
  if (!state.points.length) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = 'No points yet.';
    list.appendChild(li);
    return;
  }
  state.points.forEach((p, i) => {
    const li = document.createElement('li');
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = idxLabel(i);
    li.appendChild(badge);

    if (state.canEdit) {
      const input = document.createElement('input');
      input.type = 'text';
      input.maxLength = 80;
      input.value = p.label || '';
      input.placeholder = pointLabel(i);
      input.setAttribute('aria-label', `Label for point ${idxLabel(i)}`);
      input.addEventListener('input', () => {
        state.points[i].label = input.value;
        state.dirty = true;
        updateButtons();
      });
      li.appendChild(input);
      const mk = (text, title, fn, disabled) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'mini';
        b.textContent = text;
        b.title = title;
        b.setAttribute('aria-label', `${title} (point ${idxLabel(i)})`);
        b.disabled = Boolean(disabled);
        b.addEventListener('click', fn);
        li.appendChild(b);
      };
      mk('↑', 'Move up', () => movePoint(i, -1), i === 0);
      mk('↓', 'Move down', () => movePoint(i, 1), i === state.points.length - 1);
      mk('✕', 'Remove', () => removePoint(i));
    } else {
      const span = document.createElement('span');
      span.className = 'label';
      span.textContent = pointLabel(i);
      li.appendChild(span);
    }
    list.appendChild(li);
  });
}

function renderLinks() {
  const box = $('#links');
  box.replaceChildren();
  const legs = buildMapsUrls(state.points);
  if (!legs.length) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = 'A route needs at least a start and a destination.';
    box.appendChild(p);
    return;
  }
  legs.forEach((leg, n) => {
    const a = document.createElement('a');
    a.className = 'btn primary';
    a.href = leg.url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent =
      legs.length === 1
        ? 'Open in Google Maps'
        : `Part ${n + 1} of ${legs.length}: ${idxLabel(leg.from)} → ${idxLabel(leg.to)}`;
    box.appendChild(a);
  });
  if (legs.length > 1) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent =
      'Google Maps links hold at most 9 stops, so this route is split. Start the next part where the previous one ends.';
    box.appendChild(p);
  }
}

function renderHeader() {
  $('#title').textContent = state.name || 'Untitled route';
  $('#notes-view').textContent = state.notes || '';
  $('#name').value = state.name;
  $('#notes').value = state.notes;
  $('#avoid-highways').checked = state.avoid.highways;
  $('#avoid-tolls').checked = state.avoid.tolls;
  $('#avoid-ferries').checked = state.avoid.ferries;
}

function showShare() {
  const box = $('#share');
  if (!state.id) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  $('#share-url').value = `${location.origin}/?r=${state.id}&view=1`;
}

function updateButtons() {
  $('#save').disabled = !state.canEdit || state.points.length < 2 || !$('#name').value.trim();
  $('#save-new').disabled = $('#save').disabled || !state.id;
  $('#delete').disabled = !state.id;
  $('#reverse').disabled = state.points.length < 2;
  $('#mode').textContent = state.canEdit ? (state.dirty ? 'Editor · unsaved changes' : 'Editor') : 'Viewer';
}

function renderAll() {
  renderHeader();
  renderPoints();
  renderLinks();
  renderMarkers();
  showShare();
  updateButtons();
  document.body.classList.toggle('can-edit', state.canEdit);
}

function renderSaved(routes) {
  const ul = $('#saved');
  ul.replaceChildren();
  if (!routes.length) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = 'Nothing saved yet.';
    ul.appendChild(li);
    return;
  }
  routes.forEach((r) => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = `${r.name || 'Untitled'} (${r.points ?? '?'} points)`;
    b.addEventListener('click', () => {
      if (state.dirty && !confirm('Discard unsaved changes?')) return;
      loadRoute(r.id).catch((e) => status(e.message, 'error'));
    });
    li.appendChild(b);
    ul.appendChild(li);
  });
}

/* ---------- loading, saving ---------- */

async function loadRoute(id) {
  const r = await api(`/api/routes/${encodeURIComponent(id)}`);
  state.id = r.id;
  state.name = r.name;
  state.notes = r.notes || '';
  state.points = r.points.map((p) => ({ ...p }));
  state.avoid = { ...DEFAULT_AVOID, ...r.avoid };
  state.dirty = false;
  state.fitNext = true;
  const params = new URLSearchParams(location.search);
  params.set('r', r.id);
  history.replaceState(null, '', `?${params}`);
  renderAll();
  updateRoute();
}

function resetRoute() {
  state.id = null;
  state.name = '';
  state.notes = '';
  state.points = [];
  state.avoid = { ...DEFAULT_AVOID };
  state.dirty = false;
  clearLine();
  history.replaceState(null, '', location.pathname);
  renderAll();
  updateRoute();
}

async function refreshSaved() {
  if (!state.canEdit) return;
  const { routes } = await api('/api/routes');
  renderSaved(routes);
}

async function save(asNew) {
  state.name = $('#name').value.trim();
  state.notes = $('#notes').value;
  const body = { name: state.name, notes: state.notes, points: state.points, avoid: state.avoid };
  try {
    const route =
      asNew || !state.id
        ? await api('/api/routes', { method: 'POST', body })
        : await api(`/api/routes/${state.id}`, { method: 'PUT', body });
    state.id = route.id;
    state.dirty = false;
    history.replaceState(null, '', `?r=${route.id}`);
    showShare();
    updateButtons();
    $('#title').textContent = state.name;
    await refreshSaved();
    status('Saved.', 'ok');
  } catch (e) {
    status('Save failed: ' + e.message, 'error');
  }
}

async function deleteRoute() {
  if (!state.id || !confirm('Delete this saved route? This cannot be undone.')) return;
  try {
    await api(`/api/routes/${state.id}`, { method: 'DELETE' });
    resetRoute();
    await refreshSaved();
    status('Deleted.', 'ok');
  } catch (e) {
    status('Delete failed: ' + e.message, 'error');
  }
}

/* ---------- access ---------- */

async function refreshAccess({ forceView = false } = {}) {
  state.canEdit = false;
  if (state.token && !forceView && config.editingEnabled) {
    try {
      const { routes } = await api('/api/routes');
      state.canEdit = true;
      renderSaved(routes);
    } catch (e) {
      if (e.status === 401) {
        state.token = '';
        storageSet(TOKEN_KEY, '');
        status('That edit token was not accepted.', 'error');
      }
    }
  }
  document.body.classList.toggle('can-edit', state.canEdit);
  $('#sec-access').hidden = forceView;
  $('#lock').hidden = !state.canEdit;
  $('#unlock').hidden = state.canEdit;
  updateButtons();
}

/* ---------- wiring ---------- */

function bindUi() {
  $('#name').addEventListener('input', () => {
    state.name = $('#name').value;
    state.dirty = true;
    updateButtons();
  });
  $('#notes').addEventListener('input', () => {
    state.notes = $('#notes').value;
    state.dirty = true;
    updateButtons();
  });
  [['highways', '#avoid-highways'], ['tolls', '#avoid-tolls'], ['ferries', '#avoid-ferries']].forEach(
    ([key, sel]) =>
      $(sel).addEventListener('change', (e) => {
        state.avoid[key] = e.target.checked;
        changed(false);
      }),
  );
  $('#reverse').addEventListener('click', () => {
    state.points.reverse();
    changed(true);
  });
  $('#new').addEventListener('click', () => {
    if (state.dirty && !confirm('Discard unsaved changes?')) return;
    resetRoute();
  });
  $('#save').addEventListener('click', () => save(false));
  $('#save-new').addEventListener('click', () => save(true));
  $('#delete').addEventListener('click', deleteRoute);
  $('#copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('#share-url').value);
      status('Link copied.', 'ok');
    } catch {
      $('#share-url').select();
      status('Press Ctrl/Cmd+C to copy the link.');
    }
  });
  $('#unlock').addEventListener('click', async () => {
    state.token = $('#token').value.trim();
    storageSet(TOKEN_KEY, state.token);
    $('#token').value = '';
    await refreshAccess();
    renderAll();
    if (state.canEdit) status('Editing unlocked.', 'ok');
    else if (!config.editingEnabled) status('Editing is disabled: no EDIT_TOKEN is set on the server.', 'error');
  });
  $('#lock').addEventListener('click', async () => {
    state.token = '';
    storageSet(TOKEN_KEY, '');
    await refreshAccess();
    renderAll();
  });
  window.addEventListener('beforeunload', (e) => {
    if (state.canEdit && state.dirty) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
}

async function boot() {
  try {
    config = await api('/api/config');
  } catch (e) {
    status('Could not load configuration: ' + e.message, 'error');
    return;
  }
  if (!config.mapsKey) {
    status('The server has no GOOGLE_MAPS_API_KEY secret configured.', 'error');
    return;
  }
  try {
    await loadMaps(config.mapsKey);
    await initMap();
  } catch (e) {
    status(e.message, 'error');
    return;
  }
  bindUi();
  const params = new URLSearchParams(location.search);
  await refreshAccess({ forceView: params.get('view') === '1' });
  renderAll();
  initSearch();
  const id = params.get('r');
  if (id) {
    try {
      await loadRoute(id);
    } catch (e) {
      status(e.message === 'Not found' ? 'That route no longer exists.' : e.message, 'error');
    }
  } else {
    updateRoute();
  }
}

boot();
