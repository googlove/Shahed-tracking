/* Небо — клієнтська логіка. Без збірки, чистий ES2019+ для будь-якого браузера. */

(() => {
  "use strict";

  // ------------------------------------------------------------- стан
  const state = {
    tracks: new Map(),      // id -> track object
    oblasts: [],            // [{name, lat, lng}]
    typeDefaults: {},       // {shahed: {label, speed_kmh}, ...}
    openDetailId: null,
    pickMode: null,         // null | 'launch' | { trackId }
  };

  const markers = new Map();       // id -> L.Marker
  const pathLayers = new Map();    // id -> L.LayerGroup (траєкторія)
  const oblastLayers = new Map();  // id -> L.LayerGroup (мітки областей)
  let tempLaunchMarker = null;

  // ------------------------------------------------------------- DOM
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const connDot = $("#connDot");
  const activeCountEl = $("#activeCount");
  const tabCountEl = $("#tabCount");
  const addForm = $("#addForm");
  const trackListEl = $("#trackList");
  const emptyStateEl = $("#emptyState");
  const oblastGridAdd = $("#oblastGrid");
  const callsignInput = $("#callsign");
  const detailTemplate = $("#trackDetailTemplate");

  $$(".type-choice__icon").forEach((el) => {
    el.innerHTML = SkyIcons.glyph(el.dataset.icon);
  });

  // ------------------------------------------------------------- утиліти
  function haversineKm(lat1, lng1, lat2, lng2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  function destPoint(lat, lng, bearingDeg, distanceKm) {
    const R = 6371;
    const brng = bearingDeg * Math.PI / 180;
    const lat1 = lat * Math.PI / 180, lng1 = lng * Math.PI / 180;
    const lat2 = Math.asin(
      Math.sin(lat1) * Math.cos(distanceKm / R) +
      Math.cos(lat1) * Math.sin(distanceKm / R) * Math.cos(brng)
    );
    const lng2 = lng1 + Math.atan2(
      Math.sin(brng) * Math.sin(distanceKm / R) * Math.cos(lat1),
      Math.cos(distanceKm / R) - Math.sin(lat1) * Math.sin(lat2)
    );
    return [lat2 * 180 / Math.PI, lng2 * 180 / Math.PI];
  }

  function fmtMinutes(mins) {
    if (!Number.isFinite(mins) || mins < 0) return "—";
    if (mins < 60) return `~${Math.round(mins)} хв`;
    const h = Math.floor(mins / 60), m = Math.round(mins % 60);
    return `~${h} год ${m} хв`;
  }

  function elapsedSince(iso) {
    if (!iso) return "—";
    const mins = (Date.now() - new Date(iso).getTime()) / 60000;
    if (mins < 1) return "щойно";
    return fmtMinutes(mins) + " тому";
  }

  function formatDT(iso) {
    if (!iso) return "—";
    try {
      return new Date(iso).toLocaleString("uk-UA", {
        day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
      });
    } catch { return iso; }
  }

  function nowForInput() {
    const d = new Date();
    d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
    return d.toISOString().slice(0, 16);
  }

  function statusLabel(s) {
    return { active: "У польоті", downed: "Збито", impact: "Влучання / падіння", lost: "Втрачено спостереження" }[s] || s;
  }

  // ------------------------------------------------------------- API
  async function api(path, options) {
    const res = await fetch(path, {
      headers: { "Content-Type": "application/json" },
      ...options,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Помилка запиту (${res.status})`);
    }
    return res.json();
  }

  const getMeta = () => api("/api/meta");
  const getTracks = () => api("/api/tracks");
  const createTrack = (payload) => api("/api/tracks", { method: "POST", body: JSON.stringify(payload) });
  const patchTrack = (id, payload) => api(`/api/tracks/${id}`, { method: "PATCH", body: JSON.stringify(payload) });
  const addNote = (id, payload) => api(`/api/tracks/${id}/note`, { method: "POST", body: JSON.stringify(payload) });
  const deleteTrack = (id) => api(`/api/tracks/${id}`, { method: "DELETE" });

  // ------------------------------------------------------------- мапа
  const map = L.map("map", { zoomControl: true, attributionControl: true })
    .setView([49.0, 31.5], 6);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 18,
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);

  map.on("click", (e) => {
    if (state.pickMode === "launch") {
      $("#launchLat").value = e.latlng.lat.toFixed(4);
      $("#launchLng").value = e.latlng.lng.toFixed(4);
      if (tempLaunchMarker) map.removeLayer(tempLaunchMarker);
      tempLaunchMarker = L.circleMarker(e.latlng, {
        radius: 6, color: "#D98E3B", fillColor: "#D98E3B", fillOpacity: 0.8,
      }).addTo(map);
      exitPickMode();
    } else if (state.pickMode && state.pickMode.trackId) {
      const id = state.pickMode.trackId;
      exitPickMode();
      patchTrack(id, { current_lat: +e.latlng.lat.toFixed(4), current_lng: +e.latlng.lng.toFixed(4) })
        .catch(showError);
    }
  });

  function enterPickMode(mode, btn) {
    state.pickMode = mode;
    document.body.classList.add("is-picking-location");
    if (btn) btn.classList.add("is-picking");
  }
  function exitPickMode() {
    state.pickMode = null;
    document.body.classList.remove("is-picking-location");
    $$(".btn-ghost.is-picking").forEach((b) => b.classList.remove("is-picking"));
  }

  function showError(err) {
    console.error(err);
    alert(err.message || "Щось пішло не так");
  }

  // Будь-яке поле, введене користувачем (позивний, назва точки пуску,
  // текст поправки), рендериться лише через цю функцію, якщо вставляється
  // через innerHTML/Leaflet tooltip — інакше це відкритий вектор для XSS
  // у спільній системі без входу в акаунт.
  function escapeHtml(s) {
    const d = document.createElement("div");
    d.textContent = s ?? "";
    return d.innerHTML;
  }

  // ------------------------------------------------------------- рендер: мапа
  function upsertMarker(track) {
    const icon = L.divIcon({
      html: SkyIcons.markerHtml(track.type, track.direction_deg, track.status),
      className: "",
      iconSize: [34, 34],
      iconAnchor: [17, 17],
    });
    let marker = markers.get(track.id);
    const pos = [track.current_lat, track.current_lng];
    if (marker) {
      marker.setLatLng(pos);
      marker.setIcon(icon);
    } else {
      marker = L.marker(pos, { icon }).addTo(map);
      marker.on("click", () => {
        switchTab("list");
        openDetail(track.id, true);
      });
      markers.set(track.id, marker);
    }
    marker.bindTooltip(
      `${escapeHtml(SkyIcons.label(track.type))} — ${escapeHtml(statusLabel(track.status))}`,
      { direction: "top", offset: [0, -16] }
    );

    upsertPathLayers(track);
    upsertOblastLayer(track);
  }

  function upsertPathLayers(track) {
    const prev = pathLayers.get(track.id);
    if (prev) map.removeLayer(prev);
    if (track.launch_lat == null) return;

    const color = SkyIcons.color(track.type);
    const group = L.layerGroup();

    L.polyline(
      [[track.launch_lat, track.launch_lng], [track.current_lat, track.current_lng]],
      { color, weight: 2, opacity: 0.85 }
    ).addTo(group);

    L.circleMarker([track.launch_lat, track.launch_lng], {
      radius: 4, color, fillColor: color, fillOpacity: 1,
    }).bindTooltip(`Пуск: ${escapeHtml(track.launch_name || "не вказано")}`).addTo(group);

    if (track.status === "active" && Number.isFinite(track.direction_deg)) {
      const lookahead = Math.max(60, Math.min(300, (track.speed_kmh || 180) * 1.2));
      const dest = destPoint(track.current_lat, track.current_lng, track.direction_deg, lookahead);
      L.polyline([[track.current_lat, track.current_lng], dest], {
        color, weight: 2, opacity: 0.45, dashArray: "6 7",
      }).addTo(group);
    }

    group.addTo(map);
    pathLayers.set(track.id, group);
  }

  function upsertOblastLayer(track) {
    const prev = oblastLayers.get(track.id);
    if (prev) map.removeLayer(prev);
    const names = track.predicted_oblasts || [];
    if (!names.length) return;

    const group = L.layerGroup();
    names.forEach((name) => {
      const ob = state.oblasts.find((o) => o.name === name);
      if (!ob) return;
      L.marker([ob.lat, ob.lng], {
        icon: L.divIcon({ className: "", html: `<div class="oblast-marker"></div>`, iconSize: [14, 14], iconAnchor: [7, 7] }),
      }).bindTooltip(name, { permanent: false }).addTo(group);
    });
    group.addTo(map);
    oblastLayers.set(track.id, group);
  }

  function removeTrackVisuals(id) {
    if (markers.has(id)) { map.removeLayer(markers.get(id)); markers.delete(id); }
    if (pathLayers.has(id)) { map.removeLayer(pathLayers.get(id)); pathLayers.delete(id); }
    if (oblastLayers.has(id)) { map.removeLayer(oblastLayers.get(id)); oblastLayers.delete(id); }
  }

  // ------------------------------------------------------------- рендер: область-чекбокси
  function renderOblastGrid(container, selected) {
    const sel = new Set(selected || []);
    container.innerHTML = state.oblasts.map((o) => `
      <label>
        <input type="checkbox" value="${o.name}" ${sel.has(o.name) ? "checked" : ""}>
        <span>${o.name}</span>
      </label>
    `).join("");
  }

  // ------------------------------------------------------------- рендер: список
  function renderList() {
    const tracks = Array.from(state.tracks.values())
      .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));

    const activeCount = tracks.filter((t) => t.status === "active").length;
    activeCountEl.textContent = activeCount;
    tabCountEl.textContent = `(${activeCount})`;
    emptyStateEl.hidden = tracks.length > 0;

    const openId = state.openDetailId;
    trackListEl.innerHTML = "";
    tracks.forEach((t) => {
      trackListEl.appendChild(buildRow(t));
      if (openId === t.id) {
        trackListEl.appendChild(buildDetail(t));
      }
    });
  }

  function buildRow(t) {
    const row = document.createElement("div");
    row.className = "track-row" + (state.openDetailId === t.id ? " is-open" : "");
    row.dataset.id = t.id;
    row.style.setProperty("--type-color", SkyIcons.color(t.type));

    const oblasts = t.predicted_oblasts || [];
    const oblastText = oblasts.length
      ? (oblasts.length > 2 ? `${oblasts.slice(0, 2).join(", ")} +${oblasts.length - 2}` : oblasts.join(", "))
      : "область не вказана";

    const title = escapeHtml(t.label || SkyIcons.label(t.type)) +
      (t.launch_name ? " · " + escapeHtml(t.launch_name) : "");
    const safeStatus = escapeHtml(t.status);

    row.innerHTML = `
      <div class="track-row__icon">${SkyIcons.glyph(t.type)}</div>
      <div class="track-row__body">
        <div class="track-row__title">${title}</div>
        <div class="track-row__meta">${Math.round(t.direction_deg || 0)}° · ${t.speed_kmh || "?"} км/год · ${elapsedSince(t.launched_at)} · ${escapeHtml(oblastText)}</div>
      </div>
      <span class="track-row__status" data-status="${safeStatus}">${escapeHtml(statusLabel(t.status))}</span>
    `;
    row.addEventListener("click", () => openDetail(t.id));
    return row;
  }

  function buildDetail(t) {
    const frag = detailTemplate.content.cloneNode(true);
    const root = frag.querySelector(".track-detail");
    root.style.setProperty("--type-color", SkyIcons.color(t.type));
    root.querySelector(".track-detail__title").textContent =
      `${t.label || SkyIcons.label(t.type)}${t.launch_name ? " · " + t.launch_name : ""}`;
    root.querySelector(".track-detail__meta").textContent =
      `Пуск: ${formatDT(t.launched_at)} · Оновлено: ${formatDT(t.updated_at)} · Внесено: ${t.created_by || "Анонім"}`;

    const statusSel = root.querySelector('[data-field="status"]');
    statusSel.value = t.status;
    statusSel.addEventListener("change", () => {
      patchTrack(t.id, { status: statusSel.value }).catch(showError);
    });

    const curLat = root.querySelector('[data-field="current_lat"]');
    const curLng = root.querySelector('[data-field="current_lng"]');
    curLat.value = t.current_lat ?? "";
    curLng.value = t.current_lng ?? "";
    const commitPos = () => {
      const lat = parseFloat(curLat.value), lng = parseFloat(curLng.value);
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        patchTrack(t.id, { current_lat: lat, current_lng: lng }).catch(showError);
      }
    };
    curLat.addEventListener("change", commitPos);
    curLng.addEventListener("change", commitPos);

    root.querySelector('[data-action="pick-current"]').addEventListener("click", (e) => {
      enterPickMode({ trackId: t.id }, e.currentTarget);
    });

    const dirRange = root.querySelector('[data-field="direction_deg"]');
    const dirLabel = root.querySelector('[data-field="direction_deg_label"]');
    const dirArrow = root.querySelector('[data-field="direction_arrow"]');
    dirRange.value = t.direction_deg || 0;
    dirLabel.textContent = `${Math.round(t.direction_deg || 0)}°`;
    dirArrow.style.transform = `rotate(${t.direction_deg || 0}deg)`;
    dirRange.addEventListener("input", () => {
      dirLabel.textContent = `${dirRange.value}°`;
      dirArrow.style.transform = `rotate(${dirRange.value}deg)`;
    });
    dirRange.addEventListener("change", () => {
      patchTrack(t.id, { direction_deg: +dirRange.value }).catch(showError);
    });

    const oblastGrid = root.querySelector('[data-field="oblast_grid"]');
    renderOblastGrid(oblastGrid, t.predicted_oblasts);
    oblastGrid.addEventListener("change", () => {
      const chosen = $$('input[type=checkbox]:checked', oblastGrid).map((i) => i.value);
      patchTrack(t.id, { predicted_oblasts: chosen }).catch(showError);
    });

    const noteInput = root.querySelector('[data-field="new_note"]');
    root.querySelector('[data-action="add-note"]').addEventListener("click", () => {
      const text = noteInput.value.trim();
      if (!text) return;
      addNote(t.id, { text, author: callsignInput.value.trim() || "Анонім" })
        .then(() => { noteInput.value = ""; })
        .catch(showError);
    });

    const notesLog = root.querySelector('[data-field="notes_log"]');
    notesLog.innerHTML = (t.notes_log || []).map((n) => `
      <div class="note-item">
        <span class="note-item__meta">${escapeHtml(n.author)} · ${formatDT(n.ts)}</span>
        ${escapeHtml(n.text)}
      </div>
    `).join("") || `<p class="hint">Поправок ще немає.</p>`;

    root.querySelector('[data-action="delete"]').addEventListener("click", () => {
      if (confirm("Прибрати цю ціль зі спільної мапи?")) {
        deleteTrack(t.id).catch(showError);
      }
    });

    return frag;
  }

  function openDetail(id, focusMap) {
    state.openDetailId = state.openDetailId === id ? null : id;
    renderList();
    if (state.openDetailId && focusMap) {
      const t = state.tracks.get(id);
      if (t) map.panTo([t.current_lat, t.current_lng]);
    }
    if (state.openDetailId) {
      const row = $(`.track-row[data-id="${id}"]`);
      row?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }

  // ------------------------------------------------------------- застосування змін стану
  function applyTrack(track) {
    state.tracks.set(track.id, track);
    upsertMarker(track);
    renderList();
  }
  function applyDelete(id) {
    state.tracks.delete(id);
    if (state.openDetailId === id) state.openDetailId = null;
    removeTrackVisuals(id);
    renderList();
  }

  // ------------------------------------------------------------- вкладки
  function switchTab(name) {
    $$(".deck__tab").forEach((b) => b.classList.toggle("is-active", b.dataset.tab === name));
    $$(".panel").forEach((p) => p.classList.toggle("is-active", p.dataset.panel === name));
  }
  $$(".deck__tab").forEach((btn) => btn.addEventListener("click", () => switchTab(btn.dataset.tab)));

  // ------------------------------------------------------------- форма додавання
  $$('input[name="type"]').forEach((r) => r.addEventListener("change", () => {
    const type = r.value;
    const def = state.typeDefaults[type];
    if (def) $("#speed").value = def.speed_kmh;
    $("#ballisticHint").hidden = type !== "ballistic";
  }));

  const dirRangeAdd = $("#direction");
  const dirValueAdd = $("#dirValue");
  const dirArrowAdd = $("#dirArrow");
  dirRangeAdd.addEventListener("input", () => {
    dirValueAdd.textContent = `${dirRangeAdd.value}°`;
    dirArrowAdd.style.transform = `rotate(${dirRangeAdd.value}deg)`;
  });

  $("#pickLaunchBtn").addEventListener("click", (e) => enterPickMode("launch", e.currentTarget));

  callsignInput.value = localStorage.getItem("sky_callsign") || "";
  callsignInput.addEventListener("change", () => {
    localStorage.setItem("sky_callsign", callsignInput.value.trim());
  });

  $("#launchedAt").value = nowForInput();

  addForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const lat = parseFloat($("#launchLat").value);
    const lng = parseFloat($("#launchLng").value);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      alert("Вкажіть точку пуску — введіть координати або клікніть на мапу.");
      return;
    }
    const type = $('input[name="type"]:checked').value;
    const oblasts = $$('input[type=checkbox]:checked', oblastGridAdd).map((i) => i.value);
    const launchedAtLocal = $("#launchedAt").value;

    const payload = {
      type,
      launch_lat: lat,
      launch_lng: lng,
      launch_name: $("#launchName").value.trim(),
      direction_deg: +dirRangeAdd.value,
      speed_kmh: +$("#speed").value || undefined,
      launched_at: launchedAtLocal ? new Date(launchedAtLocal).toISOString() : undefined,
      current_lat: lat,
      current_lng: lng,
      predicted_oblasts: oblasts,
      note: $("#note").value.trim(),
      created_by: callsignInput.value.trim() || "Анонім",
    };

    try {
      await createTrack(payload);
      addForm.reset();
      $("#launchedAt").value = nowForInput();
      $("#dirValue").textContent = "0°";
      dirArrowAdd.style.transform = "rotate(0deg)";
      renderOblastGrid(oblastGridAdd, []);
      if (tempLaunchMarker) { map.removeLayer(tempLaunchMarker); tempLaunchMarker = null; }
      switchTab("list");
    } catch (err) {
      showError(err);
    }
  });

  // ------------------------------------------------------------- WebSocket
  const socket = io();
  socket.on("connect", () => connDot.classList.add("is-live"));
  socket.on("disconnect", () => connDot.classList.remove("is-live"));
  socket.on("track_created", applyTrack);
  socket.on("track_updated", applyTrack);
  socket.on("track_deleted", (d) => applyDelete(d.id));

  // ------------------------------------------------------------- запуск
  async function init() {
    try {
      const meta = await getMeta();
      state.oblasts = meta.oblasts;
      state.typeDefaults = meta.type_defaults;
      renderOblastGrid(oblastGridAdd, []);

      const tracks = await getTracks();
      tracks.forEach((t) => { state.tracks.set(t.id, t); upsertMarker(t); });
      renderList();
    } catch (err) {
      showError(err);
    }
  }

  init();
})();
