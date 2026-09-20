"use strict";

const Utils = {
    sanitize: (str) => {
        if (!str) return '';
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML.replace(/[<>"'{}]/g, '').trim().substring(0, 120);
    },
    getColorKey: (mag) => {
        if (mag >= 5.9) return 'HIGH';
        if (mag >= 3.9) return 'MED';
        return 'LOW';
    },
    getColor: (key) => Config.COLORS[key] || Config.COLORS.LOW,
    calcDistance: (lat1, lon1, lat2, lon2) => {
        const R = 6371;
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLon = (lon2 - lon1) * Math.PI / 180;
        const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    },
    formatDate: (timestamp, full = false) => {
        const date = new Date(timestamp);
        const options = { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' };
        if (full) options.year = 'numeric';
        return date.toLocaleString('es-MX', options);
    },
    normalizeQuake: (feature) => {
        const props = feature.properties;
        const coords = feature.geometry.coordinates;
        
        let timestamp = props.time;
        if (typeof timestamp === 'string') {
            timestamp = new Date(timestamp).getTime();
        }
        
        const mag = props.mag || 0;
        const depth = coords[2] || (props.depth || 0);
        const colorKey = Utils.getColorKey(mag);
        
        const place = props.place || props.flynn_region || 'Ubicación desconocida';
        
        return {
            id: feature.id || props.unid,
            mag: mag,
            place: place,
            time: timestamp,
            url: props.url || `https://www.emsc-csem.org/Earthquake/earthquake.php?id=${feature.id}`,
            lng: coords[0],
            lat: coords[1],
            depth: depth,
            tsunami: props.tsunami === 1,
            colorKey: colorKey,
            color: Utils.getColor(colorKey),
            label: mag.toFixed(1),
            isHigh: mag >= Config.ALERT.HIGH_THRESHOLD,
            timeStr: Utils.formatDate(timestamp),
            types: props.types || '',
            detailUrl: props.detail || '',
            distance: null,
            felt: props.felt || 0,
            cdi: props.cdi || 0
        };
    },
    timeAgo: (timestamp) => {
        if (!timestamp) return '';
        const diffSec = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
        if (diffSec < 60) return 'justo ahora';
        const diffMin = Math.floor(diffSec / 60);
        if (diffMin < 60) return `hace ${diffMin} min`;
        const diffH = Math.floor(diffMin / 60);
        return `hace ${diffH} h`;
    },
    formatDistance: (km) => {
        if (Config.DISTANCE_UNIT === 'mi') {
            return `${Math.round(km * 0.621371)} mi`;
        }
        return `${Math.round(km)} km`;
    },
    showToast: (msg, duration = 3000) => {
        const el = document.getElementById('toast');
        if (!el) return;
        el.textContent = msg;
        el.setAttribute('role', 'alert');
        el.setAttribute('aria-live', 'polite');
        el.classList.add('show');
        clearTimeout(Store.timers.toast);
        Store.timers.toast = setTimeout(() => el.classList.remove('show'), duration);
    },
    announceToScreenReader: (message) => {
        let el = document.getElementById('sr-announcer');
        if (!el) {
            el = document.createElement('div');
            el.id = 'sr-announcer';
            el.setAttribute('aria-live', 'assertive');
            el.setAttribute('aria-atomic', 'true');
            el.className = 'sr-only';
            el.style.cssText = 'position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0;';
            document.body.appendChild(el);
        }
        el.textContent = message;
        setTimeout(() => el.textContent = '', 1000);
    }
};

/* SERVICIO DE MAPA */
const MapService = {
    instance: null,
    baseLayer: null,
    init: () => {
        if (!document.getElementById('map')) return;
        MapService.instance = L.map('map', {
            center: Config.MAP.DEFAULT_CENTER,
            zoom: Config.MAP.DEFAULT_ZOOM,
            minZoom: Config.MAP.MIN_ZOOM,
            maxZoom: Config.MAP.MAX_ZOOM,
            zoomControl: false,
            maxBounds: L.latLngBounds([-85, -180], [85, 180]),
            preferCanvas: true
        });
        MapService.updateTheme(document.documentElement.getAttribute('data-theme') || 'dark');
    },
    updateTheme: (theme) => {
        if (!MapService.instance) return;
        if (MapService.baseLayer) {
            MapService.instance.removeLayer(MapService.baseLayer);
        }
        const isLight = theme === 'light';
        const url = isLight ? Config.MAP.TILE_LIGHT : Config.MAP.TILE_DARK;
        MapService.baseLayer = L.tileLayer(url, {
            attribution: isLight ? Config.MAP.ATTRIBUTION : Config.MAP.ATTRIBUTION_DARK,
            maxZoom: 19,
            crossOrigin: true
        });
        MapService.baseLayer.addTo(MapService.instance);
        setTimeout(() => MapService.instance.invalidateSize(), 100);
    },
    syncMarkers: (quakes, visibleQuakes) => {
        if (!MapService.instance) return;
        const map = MapService.instance;
        const currentIds = new Set();
        const visibleIds = new Set((visibleQuakes || quakes).map(eq => eq.id));
        const pending = [];
        
        quakes.forEach(eq => {
            currentIds.add(eq.id);
            const shouldBeVisible = visibleIds.has(eq.id);
            if (Store.markers[eq.id]) {
                const marker = Store.markers[eq.id];
                const wasVisible = map.hasLayer(marker);
                if (wasVisible !== shouldBeVisible) {
                    if (shouldBeVisible) marker.addTo(map);
                    else map.removeLayer(marker);
                }
                if (typeof UIService.createPopupContent === 'function') {
                    marker.getPopup()?.setContent(() => UIService.createPopupContent(eq));
                }
            } else {
                pending.push({ eq, shouldBeVisible });
            }
        });
        
        const batchSize = 30; 
        let i = 0;
        const addBatch = () => {
            const slice = pending.slice(i, i + batchSize);
            slice.forEach(({ eq, shouldBeVisible }) => {
                const r = Math.max(eq.mag * 3, 5);
                const marker = L.circleMarker([eq.lat, eq.lng], {
                    radius: r,
                    fillColor: eq.color,
                    color: eq.tsunami ? Config.COLORS.TSUNAMI_BORDER : 'rgba(0,0,0,0.6)',
                    weight: eq.tsunami ? 1.5 : 1,
                    fillOpacity: 0.85,
                    className: 'quake-marker'
                });
                
                marker.bindPopup(() => UIService.createPopupContent(eq), { maxWidth: 280, closeButton: true });
                
                marker.on('popupopen', () => {
                    marker.setStyle({ radius: r * 1.2 });
                    Utils.announceToScreenReader(`Sismo M${eq.label} en ${eq.place}`);
                });
                marker.on('popupclose', () => {
                    marker.setStyle({ radius: r });
                });
                marker.on('click', () => UIService.flyToQuake(eq));
                
                Store.markers[eq.id] = marker;
                if (shouldBeVisible) {
                    marker.addTo(map);
                }
            });
            i += batchSize;
            if (i < pending.length) {
                (window.requestIdleCallback || window.requestAnimationFrame)(addBatch);
            }
        };
        if (pending.length > 0) addBatch();
        
        for (let id in Store.markers) {
            if (!currentIds.has(id)) {
                if (map.hasLayer(Store.markers[id])) {
                    map.removeLayer(Store.markers[id]);
                }
                delete Store.markers[id];
            }
        }
    },
    flyTo: (eq) => {
        if (!MapService.instance) return;
        MapService.instance.flyTo([eq.lat, eq.lng], 7, { animate: true, duration: 1.5, easeLinearity: 0.25 });
        setTimeout(() => {
            const m = Store.markers[eq.id];
            if (m) {
                m.openPopup();
                m.getElement()?.focus();
            }
        }, 1400);
    },
    toggleShakeMap: async function(detailUrl) {
        if (Store.shakeMapOverlay) {
            this.removeShakeMap();
        } else {
            await this.loadShakeMap(detailUrl);
        }
        if (MapService.instance) {
            MapService.instance.eachLayer(layer => {
                if (layer.isPopupOpen && layer.isPopupOpen()) {
                    layer.getPopup().update();
                }
            });
        }
    },
    loadShakeMap: async function(detailUrl) {
        if (!MapService.instance) return;
        const map = MapService.instance;
        if (Store.shakeMapOverlay) {
            map.removeLayer(Store.shakeMapOverlay);
            Store.shakeMapOverlay = null;
        }
        Utils.showToast('Cargando Mapa de Sacudimiento...');
        try {
            const res = await fetch(detailUrl);
            const data = await res.json();
            const products = data.properties?.products;
            if (!products || !products.shakemap) {
                Utils.showToast('No hay ShakeMap disponible para este sismo');
                return;
            }
            const shakemap = products.shakemap[0];
            const contents = shakemap.contents || {};
            const props = shakemap.properties || {};
            let imageUrl = contents['download/overlay.png']?.url || contents['download/intensity.jpg']?.url;
            if (!imageUrl) {
                for (const key in contents) {
                    if (key.endsWith('.png') || key.endsWith('.jpg')) {
                        imageUrl = contents[key].url;
                        break;
                    }
                }
            }
            if (!imageUrl) {
                Utils.showToast('Imagen del ShakeMap no encontrada');
                return;
            }
            const minLat = props['minimum-latitude'];
            const maxLat = props['maximum-latitude'];
            const minLng = props['minimum-longitude'];
            const maxLng = props['maximum-longitude'];
            if (minLat === undefined || maxLat === undefined) {
                Utils.showToast('Coordenadas del ShakeMap no disponibles');
                return;
            }
            const bounds = L.latLngBounds([minLat, minLng], [maxLat, maxLng]);
            const overlay = L.imageOverlay(imageUrl, bounds, { opacity: 0.85, interactive: true });
            overlay.addTo(map);
            Store.shakeMapOverlay = overlay;
            map.fitBounds(bounds, { padding: [50, 50], maxZoom: 9 });
            Utils.showToast('ShakeMap cargado');
        } catch (err) {
            console.error('[ShakeMap] Error:', err);
            Utils.showToast('Error al cargar ShakeMap');
        }
    },
    removeShakeMap: function() {
        if (Store.shakeMapOverlay && MapService.instance) {
            MapService.instance.removeLayer(Store.shakeMapOverlay);
            Store.shakeMapOverlay = null;
            Utils.showToast('ShakeMap oculto');
        }
    },
    searchCity: async function(query) {
        const safeQuery = Utils.sanitize(query);
        if (!safeQuery) return null;
        Utils.showToast('Buscando ciudad…');
        try {
            const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(safeQuery)}`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const results = await res.json();
            if (!results.length) {
                Utils.showToast(`No se encontró "${safeQuery}"`);
                return null;
            }
            const { lat, lon, display_name } = results[0];
            const coords = { lat: parseFloat(lat), lng: parseFloat(lon), name: display_name.split(',')[0] };
            if (MapService.instance) {
                MapService.instance.flyTo([coords.lat, coords.lng], 9, { animate: true, duration: 1.5 });
            }
            return coords;
        } catch (err) {
            console.error('[MapService] Error de geocodificación:', err);
            Utils.showToast('Error al buscar la ciudad');
            return null;
        }
    },
    searchAddress: async function(query) {
        const raw = Utils.sanitize(query);
        if (!raw) return [];
        const parts = raw.split(',').map(p => p.trim()).filter(Boolean);
        const stripNum = s => s.replace(/\s*(#|no\.?|núm\.?|num\.?)?\s*\d+\s*[a-z]?$/i, '').trim();

        const attempts = [{ q: raw, precise: true }];
        if (parts.length > 2) attempts.push({ q: [parts[0], ...parts.slice(2)].join(', '), precise: true });
        const street = stripNum(parts[0]);
        if (parts.length > 1 && street && street !== parts[0]) {
            attempts.push({ q: [street, ...parts.slice(2)].join(', '), precise: false });
        }
        attempts.push({ q: parts.slice(parts.length > 2 ? 2 : 1).join(', '), precise: false });

        Utils.showToast('Buscando dirección…');
        const seen = new Set();
        let first = true;
        try {
            for (const a of attempts) {
                if (!a.q || seen.has(a.q)) continue;
                seen.add(a.q);
                if (!first) await new Promise(r => setTimeout(r, 1100));
                first = false;
                const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&accept-language=es&q=${encodeURIComponent(a.q)}`;
                const res = await fetch(url);
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const results = await res.json();
                if (results.length) {
                    return results.map(r => ({
                        lat: parseFloat(r.lat),
                        lng: parseFloat(r.lon),
                        label: r.display_name,
                        precise: a.precise
                    }));
                }
            }
            return [];
        } catch (err) {
            console.error('[MapService] Error de geocodificación:', err);
            Utils.showToast('Error al buscar la dirección');
            return [];
        }
    }
};

/* SERVICIO DE UI */
const UIService = {
    _filters: {
        all: () => true,
        red: (eq) => eq.mag >= 5.9,
        orange: (eq) => eq.mag >= 3.9 && eq.mag < 5.9,
        green: (eq) => eq.mag < 3.9
    },
    shouldShow: (eq) => (UIService._filters[Store.filter] || (() => true))(eq),
    getVisibleQuakes: () => Store.quakes.filter(UIService.shouldShow),
    refreshView: () => {
        const visible = UIService.getVisibleQuakes();
        MapService.syncMarkers(Store.quakes, visible);
        UIService.renderCards(visible);
    },
    initDelegation: () => {
        const container = document.getElementById('cards');
        if (!container) return;
        container.addEventListener('click', (e) => {
            const tsBadge = e.target.closest('.ts-badge');
            if (tsBadge) {
                e.stopPropagation();
                TsunamiService.show(tsBadge.dataset.id);
                return;
            }
            const card = e.target.closest('.eq-card');
            if (card) {
                const eq = Store.quakes.find(q => q.id === card.dataset.id);
                if (eq) UIService.flyToQuake(eq);
            }
        });
        container.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            const card = e.target.closest('.eq-card');
            if (!card) return;
            e.preventDefault();
            const eq = Store.quakes.find(q => q.id === card.dataset.id);
            if (eq) UIService.flyToQuake(eq);
        });
    },
    shareQuake: (eq) => {
        const text = `[SISMAP] Sismo M${eq.label} registrado en:\nUbicación: ${eq.place}\nProfundidad: ${eq.depth.toFixed(0)} km\nMás info: ${eq.url || 'SisMap'}`;
        if (navigator.share) {
            navigator.share({ title: `Sismo M${eq.label} - SisMap`, text: text }).catch(() => {});
        } else {
            navigator.clipboard.writeText(text).then(() => {
                Utils.showToast(' Información copiada al portapapeles');
            }).catch(() => {
                Utils.showToast('No se pudo compartir');
            });
        }
    },
    createPopupContent: (eq) => {
        const fecha = Utils.formatDate(eq.time, true);
        const depthLbl = eq.depth < 70 ? 'superficial' : eq.depth < 300 ? 'intermedia' : 'profunda';
        const tsAlert = eq.tsunami ? `<div class="ts-popup-alert"><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i> ALERTA DE TSUNAMI</div>` : '';
        
        const shareBtn = `<button class="eq-popup-link eq-popup-action" onclick="UIService.shareQuake(Store.quakes.find(q => q.id === '${eq.id}'))"><img src="./assets/iconoApp.png" alt="" style="width:16px;height:16px;vertical-align:middle;margin-right:6px;">Compartir</button>`;
        const shakeMapBtn = (eq.types && eq.types.includes('shakemap')) ? `<button class="eq-popup-link eq-popup-action eq-popup-shakemap" onclick="MapService.toggleShakeMap('${eq.detailUrl}')"><img src="./assets/iconoApp.png" alt="" style="width:16px;height:16px;vertical-align:middle;margin-right:6px;">ShakeMap</button>` : '';

        const feltHtml = eq.felt > 0 ? `
            <div class="eq-popup-item" style="grid-column: span 2; background: rgba(59, 130, 246, 0.1); border: 1px solid rgba(59, 130, 246, 0.2);">
                <div class="eq-popup-label" style="color: var(--accent);"><i class="fa-solid fa-users"></i> REPORTE DE LA COMUNIDAD</div>
                <div class="eq-popup-value" style="font-size: 13px; margin-top: 4px;">Sentido por ${eq.felt} persona(s) <span style="font-size: 11px; font-weight: normal; color: var(--muted);">(Intensidad máx: ${eq.cdi.toFixed(1)})</span></div>
            </div>
        ` : '';

        return `
            <div class="eq-popup" role="article" aria-label="Detalles del sismo">
                <div class="eq-popup-header">
                    <div class="eq-popup-mag-row">
                        <span class="eq-popup-mag" style="color:${eq.color}" aria-label="Magnitud ${eq.label}">${eq.label}</span>
                        <span class="eq-popup-mag-label">Magnitud</span>
                    </div>
                    <div class="eq-popup-place">${eq.place}</div>
                </div>
                <div class="eq-popup-grid">
                    <div class="eq-popup-item">
                        <div class="eq-popup-label">HORA</div>
                        <div class="eq-popup-value">${fecha}</div>
                    </div>
                    <div class="eq-popup-item">
                        <div class="eq-popup-label">PROFUNDIDAD</div>
                        <div class="eq-popup-value">${eq.depth.toFixed(0)} km</div>
                        <div class="eq-popup-sub">${depthLbl}</div>
                    </div>
                    ${feltHtml}
                </div>
                ${eq.url ? `<a href="${eq.url}" target="_blank" rel="noopener noreferrer" class="eq-popup-link" style="display:block;text-align:center;margin-bottom:4px;color:var(--accent);font-size:12px;font-weight:600;">Ver detalles oficiales</a>` : ''}
                <div style="display:flex;gap:6px;">
                    ${shareBtn}
                    ${shakeMapBtn}
                </div>
                ${tsAlert}
            </div>
        `;
    },
    buildCard: (eq) => {
        const colorMap = { HIGH: 'r', MED: 'o', LOW: 'g' };
        const wrapper = document.createElement('div');
        
        const distBadge = Store.userLocation && eq.distance ? `<span class="dist-badge" aria-label="A ${Utils.formatDistance(eq.distance)}">${Utils.formatDistance(eq.distance)}</span>` : '';
        const tsBadge = eq.tsunami ? `<span class="ts-badge" data-id="${eq.id}" role="alert"> Tsunami</span>` : '';
        const feltBadge = eq.felt > 0 ? `<span title="Sentido por ${eq.felt} personas" style="display:inline-flex; align-items:center; gap:4px; font-size:10px; color:var(--accent); background:rgba(59,130,246,0.1); padding:2px 6px; border-radius:10px; margin-left:6px;"><i class="fa-solid fa-users"></i> ${eq.felt}</span>` : '';

        wrapper.innerHTML = `
            <div class="eq-card c${colorMap[eq.colorKey] || 'g'}" data-id="${eq.id}" role="button" tabindex="0" aria-label="Sismo magnitud ${eq.label} en ${eq.place}">
                <div class="eq-icon" aria-hidden="true"><i class="fa-solid fa-wave-square"></i></div>
                <div class="eq-content">
                    <div class="eq-place">${eq.place} ${distBadge} ${feltBadge}</div>
                    <div class="eq-meta">
                        <span><i class="fa-regular fa-clock" aria-hidden="true"></i> ${eq.timeStr}</span>
                        <span><i class="fa-solid fa-ruler-combined" aria-hidden="true"></i> ${eq.depth.toFixed(0)} km</span>
                    </div>
                    ${tsBadge}
                </div>
                <div class="eq-mag">
                    <div class="mag-val" aria-label="Magnitud ${eq.label}">${eq.label}</div>
                    <div class="mag-lbl">Mag</div>
                </div>
            </div>
        `;
        return wrapper.firstElementChild;
    },
    renderCards: (visibleQuakes) => {
        const container = document.getElementById('cards');
        const countEl = document.getElementById('count-text');
        if (!container) return;
        const filtered = visibleQuakes || UIService.getVisibleQuakes();
        if (countEl) {
            countEl.textContent = `${filtered.length} de ${Store.quakes.length} terremotos`;
        }
        
        if (filtered.length === 0) {
            container.innerHTML = `
                <div class="empty-state" role="status">
                    <div class="empty-icon"><i class="fa-solid fa-magnifying-glass"></i></div>
                    <div class="empty-title">Sin resultados</div>
                </div>
            `;
            return;
        }

        const filteredIds = new Set(filtered.map(eq => eq.id));
        Array.from(container.children).forEach(node => {
            if (node.classList.contains('empty-state')) {
                node.remove();
            } else if (node.dataset.id && !filteredIds.has(node.dataset.id)) {
                node.remove();
            }
        });

        const fragment = document.createDocumentFragment();
        
        filtered.forEach((eq, index) => {
            let card = container.querySelector(`[data-id="${eq.id}"]`);
            if (!card) {
                card = UIService.buildCard(eq);
                card.style.animationDelay = `${Math.min(index, 10) * 20}ms`;
                fragment.appendChild(card);
            } else {
                card.style.order = index;
            }
        });
        
        if (fragment.childNodes.length > 0) {
            container.appendChild(fragment);
        }
    },
    flyToQuake: (eq) => {
        BottomSheet.collapse();
        MapService.flyTo(eq);
    },
    setFilter: (filterType) => {
        Store.filter = filterType;
        document.querySelectorAll('.fbtn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.filter === filterType);
        });
        UIService.refreshView();
    }
};

/* SERVICIO DE SPINNER DE CARGA INICIAL */
const SpinnerService = {
    hidden: false,
    hide: () => {
        if (SpinnerService.hidden) return;
        SpinnerService.hidden = true;
        const el = document.getElementById('spinner');
        if (!el) return;
        el.classList.add('hidden');
        setTimeout(() => { el.style.display = 'none'; }, 300);
    }
};

/* SERVICIO DE DATOS */
const DataService = {
    loadCachedFirst: async () => {
        try {
            const cached = await DBService.getQuakes();
            if (!cached.length || Store.quakes.length) return false;
            
            const sorted = cached.sort((a, b) => b.time - a.time).slice(0, 100);
            if (Store.userLocation) {
                sorted.forEach(eq => {
                    eq.distance = Utils.calcDistance(Store.userLocation.lat, Store.userLocation.lng, eq.lat, eq.lng);
                });
            }
            Store.quakes = sorted;
            Store.knownIds = {};
            sorted.forEach(q => Store.knownIds[q.id] = true);
            
            UIService.refreshView();
            SpinnerService.hide();
            return true;
        } catch (err) {
            console.warn('[DataService] No se pudo precargar caché:', err);
            return false;
        }
    },

    fetchWithRetry: async (url, retries = Config.MAX_RETRY_ATTEMPTS, delay = Config.RETRY_DELAY) => {
        for (let i = 0; i < retries; i++) {
            try {
                const response = await fetch(url, {
                    method: 'GET',
                    headers: { 'Accept': 'application/json' },
                    signal: AbortSignal.timeout(10000)
                });
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
                }
                return await response.json();
            } catch (error) {
                if (i === retries - 1) throw error;
                const backoffDelay = delay * Math.pow(2, i);
                await new Promise(resolve => setTimeout(resolve, backoffDelay));
            }
        }
    },
    fetchQuakes: async () => {
        try {
            const [res1, res2] = await Promise.allSettled([
                DataService.fetchWithRetry(Config.API_URL),
                DataService.fetchWithRetry(Config.API_URL_2)
            ]);

            let features = [];
            if (res1.status === 'fulfilled' && res1.value.features) features = features.concat(res1.value.features);
            if (res2.status === 'fulfilled' && res2.value.features) features = features.concat(res2.value.features);

            const uniqueQuakes = new Map();
            features.forEach(f => {
                const normalized = Utils.normalizeQuake(f);
                if (!uniqueQuakes.has(normalized.id)) {
                    uniqueQuakes.set(normalized.id, normalized);
                }
            });

            const newQuakes = Array.from(uniqueQuakes.values())
                .sort((a, b) => b.time - a.time)
                .slice(0, 150);
                
            if (Store.userLocation) {
                newQuakes.forEach(eq => {
                    eq.distance = Utils.calcDistance(Store.userLocation.lat, Store.userLocation.lng, eq.lat, eq.lng);
                });
            }
            
            // Limpiar y guardar SIEMPRE en la base de datos local para tener los datos más frescos offline
            try {
                await DBService.clearQuakes();
                await DBService.saveQuakes(newQuakes);
            } catch (err) {
                console.warn('[DB] Error al guardar para modo offline:', err);
            }
            
            if (!Store.isFirstLoad) {
                DataService.checkForAlerts(newQuakes);
            } else {
                const existingTsunami = newQuakes.find(q => q.tsunami);
                if (existingTsunami) {
                    setTimeout(() => AlertService.show(existingTsunami, true, false), 2000);
                }
                Store.isFirstLoad = false;
            }
            
            Store.knownIds = {};
            newQuakes.forEach(q => Store.knownIds[q.id] = true);
            Store.quakes = newQuakes;
            Store.lastFetchTime = Date.now();
            
            UIService.refreshView();
            
            if (Store.userLocation) LocationService.checkNearby();
            FavoritesService.checkNearby();
            
            Store.retryCount = 0;
        } catch (error) {
            console.error("[DataService] Error crítico:", error);
            ConnectionService.requestBackgroundSync();
        } finally {
            ConnectionService.render();
            SpinnerService.hide();
        }
    },
    checkForAlerts: (newQuakes) => {
        if (Store.userLocation) return; // El GPS se encarga de esto en LocationService
        
        const novelty = newQuakes.filter(q => !Store.knownIds[q.id]);
        if (novelty.length > 0) {
            novelty.sort((a, b) => b.mag - a.mag);
            const biggest = novelty[0];
            if (biggest.mag >= 4.0 || biggest.tsunami) {
                AlertService.show(biggest, biggest.tsunami, false);
            }
        }
    },
    startAutoRefresh: () => {
        let countdown = Config.REFRESH_INTERVAL;
        const el = document.getElementById('next-update');
        clearInterval(Store.timers.refresh);
        const updateCountdown = () => {
            countdown--;
            if (el) {
                el.innerHTML = countdown > 0
                    ? `<i class="fa-solid fa-rotate-right" aria-hidden="true"></i> ${countdown}s`
                    : `<i class="fa-solid fa-rotate-right fa-spin" aria-hidden="true"></i> ...`;
            }
            if (countdown <= 0) {
                countdown = Config.REFRESH_INTERVAL;
                DataService.fetchQuakes();
            } else {
                ConnectionService.render();
            }
        };
        Store.timers.refresh = setInterval(updateCountdown, 1000);
    },
    fetchActiveTsunamiAlerts: async () => {
        try {
            const res = await fetch('https://api.weather.gov/alerts/active?event=Tsunami%20Warning,Tsunami%20Watch,Tsunami%20Advisory');
            const data = await res.json();
            if (data.features && data.features.length > 0) {
                const firstAlert = data.features[0].properties;
                if (firstAlert.severity === 'Extreme' || firstAlert.severity === 'Severe') {
                    const fakeQuake = {
                        id: 'tsunami-alert-' + Date.now(),
                        label: '!',
                        place: firstAlert.areaDesc || 'Zona Costera',
                        depth: 0,
                        tsunami: true
                    };
                    AlertService.show(fakeQuake, true, false);
                }
            }
        } catch (err) {
            console.warn('No se pudieron verificar alertas de tsunami NOAA');
        }
    }
};

/* SERVICIO DE CLIMA */
const WeatherService = {
    currentData: null,
    dailyData: null,
    weatherCodes: {
        0: 'Cielo despejado', 1: 'Mayormente despejado', 2: 'Parcialmente nublado', 3: 'Nublado',
        45: 'Niebla', 48: 'Niebla escarchada', 51: 'Llovizna ligera', 53: 'Llovizna moderada', 55: 'Llovizna densa',
        61: 'Lluvia ligera', 63: 'Lluvia moderada', 65: 'Lluvia fuerte', 71: 'Nieve ligera', 73: 'Nieve moderada',
        75: 'Nieve fuerte', 95: 'Tormenta eléctrica'
    },
    getIcon: (code) => {
        if (code <= 1) return 'fa-sun';
        if (code <= 3) return 'fa-cloud-sun';
        if (code === 45 || code === 48) return 'fa-smog';
        if (code >= 51 && code <= 67) return 'fa-cloud-rain';
        if (code >= 71 && code <= 77) return 'fa-snowflake';
        if (code >= 95) return 'fa-cloud-bolt';
        return 'fa-cloud';
    },
    fetchLocalWeather: async (lat, lng) => {
        try {
            const url = `${Config.WEATHER_API}?latitude=${lat}&longitude=${lng}&current_weather=true&daily=weathercode,temperature_2m_max,temperature_2m_min&timezone=auto`;
            const res = await fetch(url);
            const data = await res.json();
            
            if (data.current_weather) {
                WeatherService.currentData = data.current_weather; 
                WeatherService.dailyData = data.daily;
                WeatherService.render(data.current_weather);
            }
        } catch (err) {
            console.warn('[WeatherService] Error al obtener el clima:', err);
        }
    },
    render: (weather) => {
        let weatherEl = document.getElementById('weather-widget');
        if (!weatherEl) {
            weatherEl = document.createElement('button'); 
            weatherEl.id = 'weather-widget';
            weatherEl.setAttribute('aria-label', 'Ver detalles del clima');
            weatherEl.style.cssText = 'cursor: pointer; display:flex; align-items:center; gap:6px; font-size:14px; font-weight:700; color:var(--text); background:var(--card); padding:8px 12px; border-radius:18px; border:1px solid var(--border); margin-left: auto; margin-right: 12px; transition: all 0.2s ease;';
            
            weatherEl.onclick = () => WeatherService.showDetails();
            
            const headerActions = document.querySelector('.header-actions');
            if (headerActions) {
                headerActions.parentNode.insertBefore(weatherEl, headerActions);
            }
        }
        
        weatherEl.innerHTML = `
            <i class="fa-solid fa-temperature-half" style="color:var(--accent)"></i> 
            ${Math.round(weather.temperature)}°C
        `;
    },
    showDetails: () => {
        if (!WeatherService.currentData) return;
        const weather = WeatherService.currentData;
        const daily = WeatherService.dailyData;
        const modal = document.getElementById('weather-modal');
        if (!modal) return;
        
        const desc = WeatherService.weatherCodes[weather.weathercode] || 'Condiciones variables';
        
        let weeklyHtml = '';
        if (daily && daily.time) {
            weeklyHtml = `<div style="margin-top: 24px; text-align: left; width: 100%;">
                <div style="font-size: 11px; color: var(--muted); text-transform: uppercase; margin-bottom: 12px; font-weight: 700;">Pronóstico de la semana</div>
                <style>.week-scroll::-webkit-scrollbar { display: none; }</style>
                <div class="week-scroll" style="display: flex; flex-direction: row; gap: 10px; overflow-x: auto; padding-bottom: 8px; scrollbar-width: none;">`;
            
            for (let i = 0; i < daily.time.length; i++) {
                const date = new Date(daily.time[i] + 'T00:00:00');
                const dayName = i === 0 ? 'Hoy' : date.toLocaleDateString('es-ES', { weekday: 'short', timeZone: 'UTC' });
                const max = Math.round(daily.temperature_2m_max[i]);
                const min = Math.round(daily.temperature_2m_min[i]);
                const iconClass = WeatherService.getIcon(daily.weathercode[i]);

                weeklyHtml += `
                    <div style="display: flex; flex-direction: column; align-items: center; padding: 12px 8px; background: var(--bg); border-radius: 12px; border: 1px solid var(--border); min-width: 68px; flex-shrink: 0; gap: 8px;">
                        <div style="font-size: 13px; font-weight: 600; text-transform: capitalize; color: var(--text);">${dayName}</div>
                        <div style="color: var(--accent); font-size: 18px;"><i class="fa-solid ${iconClass}"></i></div>
                        <div style="display: flex; flex-direction: column; align-items: center; gap: 2px; font-family: var(--font-mono);">
                            <span style="font-size: 14px; font-weight: 700; color: var(--text);">${max}°</span> 
                            <span style="font-size: 12px; font-weight: 600; color: var(--muted);">${min}°</span>
                        </div>
                    </div>`;
            }
            weeklyHtml += `</div></div>`;
        }
        
        modal.innerHTML = `
            <div class="set-box" style="max-width: 360px; width: 100%;">
                <div class="set-head">
                    <div class="set-title">
                        <i class="fa-solid fa-cloud-sun" aria-hidden="true"></i> Clima Local
                    </div>
                    <button class="set-close" onclick="WeatherService.close()" aria-label="Cerrar modal"><i class="fa-solid fa-xmark"></i></button>
                </div>
                <div class="set-body" style="padding: 24px; text-align: center; overflow-x: hidden;">
                    <div style="font-size: 52px; font-weight: 800; color: var(--text); font-family: var(--font-mono); line-height: 1;">
                        ${Math.round(weather.temperature)}°C
                    </div>
                    <div style="font-size: 15px; font-weight: 600; color: var(--accent); margin-top: 8px; margin-bottom: 24px; text-transform: uppercase; letter-spacing: 0.5px;">
                        ${desc}
                    </div>
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; text-align: left;">
                        <div style="background: var(--bg); padding: 12px; border-radius: 8px; border: 1px solid var(--border);">
                            <div style="font-size: 11px; color: var(--muted); text-transform: uppercase; margin-bottom: 4px; font-weight: 600;">Viento</div>
                            <div style="font-size: 14px; font-weight: 700; color: var(--text);"><i class="fa-solid fa-wind" style="color: var(--muted)"></i> ${weather.windspeed} km/h</div>
                        </div>
                        <div style="background: var(--bg); padding: 12px; border-radius: 8px; border: 1px solid var(--border);">
                            <div style="font-size: 11px; color: var(--muted); text-transform: uppercase; margin-bottom: 4px; font-weight: 600;">Dirección</div>
                            <div style="font-size: 14px; font-weight: 700; color: var(--text);"><i class="fa-regular fa-compass" style="color: var(--muted)"></i> ${weather.winddirection}°</div>
                        </div>
                    </div>
                    ${weeklyHtml}
                </div>
            </div>
        `;
        modal.classList.add('open');
    },
    close: () => {
        const modal = document.getElementById('weather-modal');
        if (modal) modal.classList.remove('open');
    }
};

/* SERVICIO DE ALERTAS (CORREGIDO AUDIO, VIBRACIÓN E ÍCONO) */
const AlertService = {
    sounds: {},
    pool: {},
    vibrateInterval: null,
    init: () => {
        Object.entries(Config.AUDIO).forEach(([key, url]) => {
            const audio = new Audio(url);
            audio.preload = 'auto';
            AlertService.pool[key] = audio;
        });
    },
    _config: {
        tsunami: {
            class: 'ts-alert', eyebrow: 'ALERTA DE TSUNAMI',
            title: '¡Potencial tsunami detectado!', sound: 'TSUNAMI',
            duration: 15000, 
            detail: '<i class="fa-solid fa-person-running"></i> Trazar ruta de evacuación',
            action: (eq) => EvacuationService.drawRoute(eq.lat, eq.lng),
            notify: 'ALERTA TSUNAMI', fullscreen: true
        },
        emergency: { 
            class: 'eq-alert', 
            eyebrow: (eq) => eq.zoneName ? `¡PELIGRO CERCA DE ${eq.zoneName.toUpperCase()}!` : '¡TERREMOTO MUY CERCA!',
            title: (eq) => `M ${eq.label} a ${Utils.formatDistance(eq.distance)}`, sound: 'NEARBY',
            duration: 0, 
            detail: '<i class="fa-solid fa-person-running"></i> Trazar ruta de evacuación',
            action: (eq) => EvacuationService.drawRoute(eq.lat, eq.lng),
            notify: (eq) => eq.zoneName ? `Sismo cerca de ${eq.zoneName}` : 'Sismo Cercano',
            fullscreen: true
        },
        standard: { 
            class: 'eq-alert', eyebrow: 'SISMO DETECTADO',
            title: (eq) => `Magnitud M ${eq.label}`, 
            sound: 'notify',
            duration: 8000, detail: 'Ver en mapa →',
            action: (eq) => UIService.flyToQuake(eq), notify: 'Sismo Fuerte', fullscreen: false
        }
    },
    play: (type, loop = false, duration = 0) => {
    AlertService.stopAll(); 
    if (!Config.SOUND_ENABLED) return;
    
    const audio = AlertService.pool[type] || AlertService.pool.EARTHQUAKE;
    if (!audio) return;

    audio.currentTime = 0;
    audio.volume = 1.0; 
    audio.loop = loop;
    
    audio.play().catch(e => console.warn('[Audio] bloqueado por el navegador', e));
    AlertService.sounds[type] = audio;

    if (navigator.vibrate) {
        clearInterval(AlertService.vibrateInterval);
        if (loop) {
            // Alarma de Emergencia: Vibración fuerte y en bucle
            navigator.vibrate([1000, 500, 1000, 500, 2000]); 
            AlertService.vibrateInterval = setInterval(() => {
                navigator.vibrate([1000, 500, 1000, 500, 2000]);
            }, 5000);
        } else {
            // Notificación Estándar: Vibración corta y discreta
            navigator.vibrate([200, 100, 200]);
        }
    }

    if (duration > 0) setTimeout(() => AlertService.stop(type), duration);
},
    stop: (type) => {
        if (AlertService.sounds[type]) {
            AlertService.sounds[type].pause();
            AlertService.sounds[type].currentTime = 0;
        }
    },
    stopAll: () => {
        Object.keys(AlertService.pool).forEach(k => AlertService.stop(k));
        if (navigator.vibrate) {
            clearInterval(AlertService.vibrateInterval);
            navigator.vibrate(0);
        }
    },
    show: (eq, isTsunami, isEmergency) => {
        if (!isTsunami && !isEmergency && eq.mag < 4.0) return; 
        
        AlertService.stopAll();
        const banner = document.getElementById('alert-banner');
        if (!banner) return;
        
        const cfg = AlertService._config[isTsunami ? 'tsunami' : isEmergency ? 'emergency' : 'standard'];
        
        banner.className = `${cfg.class} show ${cfg.fullscreen ? 'fullscreen-alert' : ''}`;
        document.getElementById('ab-icon-wrap').innerHTML = isTsunami ? ICONS.tsunami : ICONS.earthquake;
        document.getElementById('ab-eyebrow').textContent = typeof cfg.eyebrow === 'function' ? cfg.eyebrow(eq) : cfg.eyebrow;
        document.getElementById('ab-title').textContent = typeof cfg.title === 'function' ? cfg.title(eq) : cfg.title;
        document.getElementById('ab-msg').textContent = `${eq.place} · Prof. ${eq.depth.toFixed(0)} km`;
        
        const detEl = document.getElementById('ab-detail');
        detEl.innerHTML = cfg.detail; 
        detEl.onclick = () => { cfg.action(eq); AlertService.hide(); };
        
        if (cfg.fullscreen) {
            AlertService.play(cfg.sound, true, 0); 
        } else {
            Store.timers.alert = setTimeout(() => AlertService.hide(), 8000);
            AlertService.play(cfg.sound, false, 8000);
        }
        
        if ('Notification' in window && Notification.permission === 'granted') {
            const notifyText = typeof cfg.notify === 'function' ? cfg.notify(eq) : cfg.notify;
            const vibratePattern = isTsunami ? [800, 400, 800, 400, 800, 1000, 2000] : [300, 150, 300, 150, 300];
            
            navigator.serviceWorker.ready.then(reg => {
                reg.showNotification(notifyText, {
                    body: `${eq.place}\nMagnitud: ${eq.label} - Prof: ${eq.depth.toFixed(0)} km`,
                    icon: './assets/iconoApp.png',
                    vibrate: vibratePattern,
                    requireInteraction: true,
                    tag: isTsunami ? 'tsunami-critical' : 'quake-alert',
                    renotify: true 
                });
            }).catch(() => {
                new Notification(notifyText, { body: eq.place, icon: './assets/iconoApp.png', requireInteraction: true, vibrate: vibratePattern });
            });
        }
        
        Utils.announceToScreenReader(isTsunami ? 'Alerta de tsunami' : `Sismo magnitud ${eq.label} en ${eq.place}`);
    },
    hide: () => {
        const banner = document.getElementById('alert-banner');
        if (banner) {
            banner.classList.remove('show');
            banner.removeAttribute('role');
            banner.removeAttribute('aria-live');
        }
        AlertService.stopAll();
    }
};

/* SERVICIO DE RUTAS DE EVACUACIÓN (OSRM) - MULTIRUTA NATIVA */
const EvacuationService = {
    routeLayers: [],
    calculateSafePoint: (userLat, userLng, eqLat, eqLng) => {
        const dy = userLat - eqLat;
        const dx = userLng - eqLng;
        const angle = Math.atan2(dy, dx);
        const distanceDeg = 3 / 111.32; 
        return {
            lat: userLat + Math.sin(angle) * distanceDeg,
            lng: userLng + Math.cos(angle) * distanceDeg
        };
    },
    drawRoute: async (eqLat, eqLng) => {
        if (!Store.userLocation) {
            Utils.showToast('Se requiere tu ubicación GPS para trazar rutas de evacuación');
            return;
        }
        Utils.showToast('Calculando opciones de rutas seguras...');
        
        const start = Store.userLocation;
        const end = EvacuationService.calculateSafePoint(start.lat, start.lng, eqLat, eqLng);
        
        EvacuationService.routeLayers.forEach(layer => {
            if (MapService.instance) MapService.instance.removeLayer(layer);
        });
        EvacuationService.routeLayers = [];
        
        const routeStyles = [
            { color: '#3b82f6', weight: 8, opacity: 1, dashArray: '10, 12' }, 
            { color: '#10b981', weight: 5, opacity: 0.9, dashArray: '5, 8' }, 
            { color: '#f59e0b', weight: 5, opacity: 0.9, dashArray: '5, 8' }  
        ];

        try {
            const res = await fetch(`https://router.project-osrm.org/route/v1/foot/${start.lng},${start.lat};${end.lng},${end.lat}?alternatives=3&geometries=geojson`);
            const data = await res.json();
            
            if (data.routes && data.routes.length > 0) {
                let validBounds = new L.latLngBounds();

                data.routes.forEach((route, index) => {
                    if (index >= routeStyles.length) return; 
                    
                    const routeCoords = route.geometry.coordinates.map(c => [c[1], c[0]]);
                    const style = routeStyles[index];
                    
                    const layer = L.polyline(routeCoords, {
                        color: style.color, 
                        weight: style.weight, 
                        opacity: style.opacity,
                        dashArray: style.dashArray, 
                        lineCap: 'round'
                    }).addTo(MapService.instance);
                    
                    EvacuationService.routeLayers.push(layer);
                    validBounds.extend(layer.getBounds());
                });

                MapService.instance.fitBounds(validBounds, { padding: [40, 40] });
                TsunamiService.close();
                BottomSheet.collapse();
                Utils.showToast(`Se trazaron ${data.routes.length} opciones de evacuación.`, 6000);
            } else {
                Utils.showToast('No se encontraron rutas peatonales seguras');
            }
        } catch (err) {
            console.warn('[Evacuation] Error:', err);
            Utils.showToast('No se pudo establecer conexión con el servidor de rutas');
        }
    }
};

/* SERVICIO DE ZONAS FAVORITAS */
const FavoritesService = {
    load: async () => {
        try {
            const saved = await DBService.getSetting('favoriteZones');
            Store.favoriteZones = Array.isArray(saved) ? saved : [];
        } catch (err) {
            Store.favoriteZones = [];
        }
        FavoritesService.render();
    },
    persist: async () => {
        try {
            await DBService.saveSetting('favoriteZones', Store.favoriteZones);
        } catch (err) {
            Utils.showToast('No se pudo guardar la zona favorita');
        }
    },
    pending: [],
    pendingQuery: '',
    esc: (v) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    add: async (name, lat, lng, address = '', precise = false) => {
        const zone = { id: crypto.randomUUID?.() || Date.now().toString(), name, lat, lng, address, precise, synced: false };
        Store.favoriteZones.push(zone);
        await FavoritesService.persist();
        FavoritesService.render();
        Utils.showToast(`"${name}" agregada a zonas favoritas`);
        return zone;
    },
    remove: async (id) => {
        const zone = Store.favoriteZones.find(z => z.id === id);
        Store.favoriteZones = Store.favoriteZones.filter(z => z.id !== id);
        await FavoritesService.persist();
        FavoritesService.render();
        if (zone) Utils.showToast(`"${zone.name}" eliminada`);
    },
    flyTo: (id) => {
        const zone = Store.favoriteZones.find(z => z.id === id);
        if (!zone || !MapService.instance) return;
        const zoom = zone.address ? (zone.precise ? 17 : 13) : 9;
        MapService.instance.flyTo([zone.lat, zone.lng], zoom, { animate: true, duration: 1.5 });
        SettingsService.close();
    },
    searchAndAdd: async () => {
        const rawQuery = document.getElementById('fav-search-city')?.value;
        const query = Utils.sanitize(rawQuery);
        if (!query) return Utils.showToast('Escribe una dirección o ciudad válida');
        
        const results = await MapService.searchAddress(query);
        if (!results.length) return Utils.showToast(`No se encontró "${query}"`);
        
        FavoritesService.pending = results;
        FavoritesService.pendingQuery = query;
        if (results.length === 1 && results[0].precise) {
            await FavoritesService.pick(0);
        } else {
            FavoritesService.renderResults();
        }
    },
    renderResults: () => {
        const box = document.getElementById('fav-results');
        if (!box) return;
        const list = FavoritesService.pending;
        if (!list.length) { box.innerHTML = ''; return; }
        const note = list[0].precise ? 'Elige la ubicación correcta:' : 'Ubicaciones aproximadas. Elige una:';
        box.innerHTML = `<p class="fav-results-note">${note}</p>` + list.map((r, i) => `
            <button type="button" class="fav-result" onclick="FavoritesService.pick(${i})">
                <i class="fa-solid fa-location-dot" aria-hidden="true"></i> ${FavoritesService.esc(r.label)}
            </button>`).join('');
    },
    pick: async (i) => {
        const r = FavoritesService.pending[i];
        if (!r) return;
        const rawName = document.getElementById('fav-search-name')?.value;
        const nameInput = Utils.sanitize(rawName);
        const addrInputEl = document.getElementById('fav-search-city');
        const fallbackName = FavoritesService.pendingQuery.split(',')[0].trim() || r.label.split(',')[0];
        
        const zone = await FavoritesService.add(nameInput || fallbackName, r.lat, r.lng, r.label, r.precise);
        if (!r.precise) Utils.showToast('Ubicación aproximada');
        FavoritesService.pending = [];
        FavoritesService.renderResults();
        
        const nameEl = document.getElementById('fav-search-name');
        if (nameEl) nameEl.value = '';
        if (addrInputEl) addrInputEl.value = '';
        FavoritesService.flyTo(zone.id);
    },
    render: () => {
        const list = document.getElementById('fav-zones-list');
        if (list) {
            if (Store.favoriteZones.length === 0) {
                list.innerHTML = '<p class="fav-empty">Sin zonas guardadas todavía.</p>';
            } else {
                list.innerHTML = Store.favoriteZones.map(z => `
                    <div class="fav-zone-row">
                        <button class="fav-zone-name" onclick="FavoritesService.flyTo('${z.id}')" title="Ir al mapa">
                            <i class="fa-solid fa-location-dot" aria-hidden="true"></i>
                            <span class="fav-zone-text">
                                <span class="fav-zone-title">${FavoritesService.esc(z.name)}</span>
                                ${z.address ? `<small>${FavoritesService.esc(z.address)}</small>` : ''}
                            </span>
                        </button>
                        <button class="fav-zone-remove" onclick="FavoritesService.remove('${z.id}')" aria-label="Eliminar">
                            <i class="fa-solid fa-trash"></i>
                        </button>
                    </div>`).join('');
            }
        }
        FavoritesService.renderMapMarkers();
    },
    renderMapMarkers: () => {
        if (!MapService.instance) return;
        if (!Store.favoriteMarkersLayer) Store.favoriteMarkersLayer = L.layerGroup().addTo(MapService.instance);
        Store.favoriteMarkersLayer.clearLayers();
        Store.favoriteZones.forEach(zone => {
            const marker = L.marker([zone.lat, zone.lng], {
                icon: L.divIcon({
                    className: '',
                    html: `<div class="fav-marker"><i class="fa-solid fa-star" aria-hidden="true"></i></div>`,
                    iconSize: [30, 30], iconAnchor: [15, 30], popupAnchor: [0, -28]
                })
            });
            marker.bindPopup(`
                <strong>${FavoritesService.esc(zone.name)}</strong><br>
                <span style="font-size:12px;color:var(--muted)">${zone.address ? FavoritesService.esc(zone.address) : 'Zona favorita'}</span><br>
                <button class="eq-popup-link eq-popup-action" onclick="FavoritesService.remove('${zone.id}')">
                    <i class="fa-solid fa-trash" aria-hidden="true"></i> Quitar de favoritas
                </button>
            `);
            Store.favoriteMarkersLayer.addLayer(marker);
        });
    },
    checkNearby: () => {
        if (!Store.favoriteZones.length) return;
        Store.favoriteZones.forEach((zone, idx) => {
            const unnotified = Store.quakes.filter(eq => !Store.notifiedNearby[`${zone.id}:${eq.id}`]);
            if (unnotified.length === 0) return;

            unnotified.forEach(eq => Store.notifiedNearby[`${zone.id}:${eq.id}`] = true);
            const emergencies = unnotified.filter(eq => Utils.calcDistance(zone.lat, zone.lng, eq.lat, eq.lng) <= 400);
            
            if (emergencies.length > 0) {
                emergencies.sort((a, b) => b.mag - a.mag);
                const strongest = emergencies[0];
                const dist = Utils.calcDistance(zone.lat, zone.lng, strongest.lat, strongest.lng);
                const eqForAlert = { ...strongest, distance: dist, zoneName: zone.name };
                setTimeout(() => AlertService.show(eqForAlert, false, true), 1500 + idx * 2000);
            }
        });
    }
};

/* SERVICIO DE GEOLOCALIZACIÓN */
const LocationService = {
    locate: () => {
        if (Store.isLocating || !navigator.geolocation) {
            Utils.showToast('Geolocalización no disponible');
            return;
        }
        Store.isLocating = true;
        Utils.showToast('Obteniendo ubicación…');
        navigator.geolocation.getCurrentPosition(
            (pos) => {
                const { latitude: lat, longitude: lng, accuracy } = pos.coords;
                Store.userLocation = { lat, lng };
                Store.quakes.forEach(eq => { eq.distance = Utils.calcDistance(lat, lng, eq.lat, eq.lng); });
                LocationService.renderUserMarker(lat, lng, accuracy);
                if (MapService.instance) MapService.instance.flyTo([lat, lng], 9, { animate: true, duration: 1.5 });
                UIService.refreshView();
                LocationService.checkNearby();
                WeatherService.fetchLocalWeather(lat, lng);
                Store.isLocating = false;
                Utils.showToast(`Ubicación encontrada`);
                Utils.announceToScreenReader('Ubicación actualizada');
            },
            (err) => {
                Store.isLocating = false;
                Utils.showToast('Error al obtener ubicación');
            },
            { enableHighAccuracy: true, timeout: 10000, maximumAge: 300000 }
        );
    },
    renderUserMarker: (lat, lng, acc) => {
        if (!MapService.instance) return;
        const map = MapService.instance;
        if (Store.userMarker) map.removeLayer(Store.userMarker);
        if (Store.userAccuracyCircle) map.removeLayer(Store.userAccuracyCircle);
        Store.userAccuracyCircle = L.circle([lat, lng], {
            radius: Math.max(acc, 30), color: '#032b5c', fillColor: '#60a5fa', fillOpacity: 0.1, weight: 1
        }).addTo(map);
        Store.userMarker = L.marker([lat, lng], {
            icon: L.divIcon({
                className: '', html: '<div class="pulse" role="img" aria-label="Tu ubicación"></div>',
                iconSize: [16, 16], iconAnchor: [8, 8]
            }), keyboard: false
        }).addTo(map);
    },
    checkNearby: () => {
        if (!Store.userLocation) return;
        const unnotified = Store.quakes.filter(eq => !Store.notifiedNearby[eq.id]);
        if (unnotified.length === 0) return;

        unnotified.forEach(eq => Store.notifiedNearby[eq.id] = true);

        const emergencies = unnotified.filter(eq => eq.distance !== null && eq.distance <= 400);
        const standards = unnotified.filter(eq => (eq.distance === null || eq.distance > 400) && eq.mag >= 4.0);

        if (emergencies.length > 0) {
            emergencies.sort((a, b) => b.mag - a.mag); 
            setTimeout(() => { AlertService.show(emergencies[0], emergencies[0].tsunami, true); }, 1500);
        } else if (standards.length > 0) {
            standards.sort((a, b) => b.mag - a.mag); 
            setTimeout(() => { AlertService.show(standards[0], standards[0].tsunami, false); }, 1500);
        }
    }
};

/* SERVICIO DE TSUNAMI */
const TsunamiService = {
    show: (id) => {
        const eq = Store.quakes.find(q => q.id === id);
        if (!eq) return;
        const modal = document.getElementById('tsunami-modal');
        if (!modal) return;
        modal.innerHTML = TsunamiService.render(eq);
        modal.classList.add('open');
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');
        requestAnimationFrame(() => modal.querySelector('.tsm-close')?.focus());
    },
    render: (eq) => `
        <div class="tsm-box">
            <div class="tsm-head">
                <div class="tsm-title">
                    <i class="fa-solid fa-house-tsunami" aria-hidden="true"></i> Boletín de Alerta
                </div>
                <button class="tsm-close" onclick="TsunamiService.close()" aria-label="Cerrar modal"><i class="fa-solid fa-xmark"></i></button>
            </div>
            <div class="tsm-body">
                <div class="tsm-warn" role="alert">
                    <i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i>
                    <div><strong>ALERTA ACTIVA:</strong> Potencial tsunamigénico. Evacúe a zonas altas de inmediato.</div>
                </div>
                <div class="tsm-section">
                    <h3>Datos del Evento</h3>
                    <div class="tsm-grid">
                        <div class="tsm-item"><div class="tsm-label">Magnitud</div><div class="tsm-val" style="color:${eq.color}">M ${eq.label}</div></div>
                        <div class="tsm-item"><div class="tsm-label">Profundidad</div><div class="tsm-val">${eq.depth.toFixed(0)} km</div></div>
                    </div>
                </div>
                <div class="tsm-actions">
                    <button class="tsm-btn" style="background: var(--red); color: white; border-color: var(--red);" onclick="EvacuationService.drawRoute(${eq.lat}, ${eq.lng})">
                        <i class="fa-solid fa-person-running"></i> Trazar Evacuación
                    </button>
                    ${eq.url ? `<a href="${eq.url}" target="_blank" rel="noopener noreferrer" class="tsm-btn danger">Ver Detalles</a>` : ''}
                </div>
            </div>
        </div>
    `,
    close: () => {
        const modal = document.getElementById('tsunami-modal');
        if (modal) { modal.classList.remove('open'); modal.removeAttribute('role'); modal.removeAttribute('aria-modal'); }
    }
};

/* BOTTOM SHEET */
const BottomSheet = {
    state: 'collapsed',
    init: () => {
        const sheet = document.getElementById('bottom-sheet');
        const handle = document.getElementById('sheet-handle');
        if (!sheet || !handle) return;
        let startY, currentY, pendingFrame = null;
        handle.addEventListener('touchstart', e => { startY = e.touches[0].clientY; sheet.style.transition = 'none'; }, { passive: true });
        handle.addEventListener('touchmove', e => {
            currentY = e.touches[0].clientY;
            const diff = startY - currentY;
            const clamped = Math.max(-window.innerHeight * 0.75, Math.min(0, diff));
            if (!pendingFrame) pendingFrame = requestAnimationFrame(() => { sheet.style.transform = `translateY(${clamped}px)`; pendingFrame = null; });
        }, { passive: true });
        handle.addEventListener('touchend', () => {
            sheet.style.transition = 'transform 0.3s';
            const y = parseInt(sheet.style.transform.replace(/[^\d-]/g, '')) || 0;
            const h = window.innerHeight;
            BottomSheet.set(y < -h * 0.5 ? 'expanded' : y < -h * 0.2 ? 'half' : 'collapsed');
        });
        document.getElementById('sheet-header')?.addEventListener('click', e => { if (!e.target.closest('button')) BottomSheet.toggle(); });
        document.addEventListener('keydown', e => { if (e.key === 'Escape') BottomSheet.collapse(); });
        document.addEventListener('pointerdown', e => { if (BottomSheet.state !== 'collapsed' && !sheet.contains(e.target)) BottomSheet.collapse(); });
    },
    toggle: () => BottomSheet.set(BottomSheet.state === 'collapsed' ? 'expanded' : 'collapsed'),
    collapse: () => BottomSheet.set('collapsed'),
    set: (state) => {
        const sheet = document.getElementById('bottom-sheet');
        if (!sheet) return;
        BottomSheet.state = state;
        sheet.className = `bottom-sheet ${state}`;
        const icon = document.getElementById('chevron-icon');
        if (icon) icon.style.transform = state === 'collapsed' ? 'rotate(180deg)' : 'rotate(0)';
        setTimeout(() => MapService.instance?.invalidateSize(), 300);
    }
};

/* SERVICIO DE AJUSTES DEL USUARIO */
const SettingsService = {
    KEY: 'userPrefs',
    DEFAULTS: { soundEnabled: true }, 
    load: async () => {
        let prefs = SettingsService.DEFAULTS;
        try {
            const saved = await DBService.getSetting(SettingsService.KEY);
            if (saved) prefs = { ...SettingsService.DEFAULTS, ...saved };
        } catch (err) {}
        SettingsService.apply(prefs);
        SettingsService.populateForm(prefs);
    },
    apply: (prefs) => {
        Config.SOUND_ENABLED = prefs.soundEnabled;
    },
    populateForm: (prefs) => {
        const sound = document.getElementById('set-sound');
        if (sound) sound.checked = prefs.soundEnabled;
    },
    save: async (patch) => {
        const merged = { soundEnabled: Config.SOUND_ENABLED, ...patch };
        SettingsService.apply(merged);
        try { await DBService.saveSetting(SettingsService.KEY, merged); Utils.showToast('Ajustes guardados'); } 
        catch (err) { Utils.showToast('No se pudo guardar el ajuste'); }
    },
    open: () => document.getElementById('settings-modal')?.classList.add('open'),
    close: () => document.getElementById('settings-modal')?.classList.remove('open')
};

/* SERVICIO DE CONEXIÓN */
const ConnectionService = {
    init: () => {
        Store.isOnline = navigator.onLine;
        ConnectionService.render();
        window.addEventListener('online', () => {
            Store.isOnline = true;
            ConnectionService.render();
            Utils.showToast('Conexión restablecida, actualizando…');
            DataService.fetchQuakes();
        });
        window.addEventListener('offline', () => {
            Store.isOnline = false;
            ConnectionService.render();
            Utils.showToast('Sin conexión. Mostrando datos guardados.');
        });
    },
    render: () => {
        const el = document.getElementById('conn-status');
        const txt = document.getElementById('conn-status-text');
        if (!el || !txt) return;
        el.classList.toggle('online', Store.isOnline);
        el.classList.toggle('offline', !Store.isOnline);
        const icon = el.querySelector('i');
        if (icon) icon.className = Store.isOnline ? 'fa-solid fa-wifi' : 'fa-solid fa-wifi-slash';
        txt.textContent = !Store.isOnline ? 'Sin conexión' : (Store.lastFetchTime ? `Actualizado ${Utils.timeAgo(Store.lastFetchTime)}` : 'En línea');
    },
    requestBackgroundSync: async () => {
        try {
            if ('serviceWorker' in navigator && 'SyncManager' in window) {
                const reg = await navigator.serviceWorker.ready;
                await reg.sync.register('sync-earthquakes');
            }
        } catch (err) {}
    }
};

/* INICIALIZACIÓN OPTIMIZADA DE CARGA RÁPIDA */
document.addEventListener('DOMContentLoaded', async () => {
    MapService.init();
    BottomSheet.init();
    UIService.initDelegation();
    await DBService.init?.().catch(err => console.warn('[DB] Error:', err));
    
    const hasCache = await DataService.loadCachedFirst();
    if (hasCache) SpinnerService.hide();

    setTimeout(() => {
        if (!SpinnerService.hidden) {
            SpinnerService.hide();
            Utils.showToast('La red está lenta. Mostrando mapa base.');
        }
    }, 8000);

    setTimeout(() => {
        DataService.fetchQuakes();
        DataService.startAutoRefresh();
        DataService.fetchActiveTsunamiAlerts(); 
        
        ConnectionService.init();
        SettingsService.load().catch(() => {});
        FavoritesService.load().catch(() => {});
        AlertService.init();
        
        if ('Notification' in window && Notification.permission === 'default') {
            Notification.requestPermission();
        }
    }, 150); 

    Object.assign(window, {
        toggleTheme: () => {
            const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
            document.documentElement.setAttribute('data-theme', next);
            localStorage.setItem('theme', next);
            MapService.updateTheme(next);
        },
        locateMe: LocationService.locate,
        setFilter: UIService.setFilter,
        hideAlert: AlertService.hide,
        toggleSheet: BottomSheet.toggle,
        toggleFilters: () => document.getElementById('navbar')?.classList.toggle('show'),
    });
    
    window.addEventListener('pagehide', () => {
        Object.values(Store.timers).forEach(timer => timer && clearTimeout(timer));
        AlertService.stopAll();
    });
});