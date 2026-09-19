const Utils = {
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
            distance: null
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
        const batchSize = 20;
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
                if (typeof UIService.createPopupContent === 'function') {
                    marker.bindPopup(() => UIService.createPopupContent(eq), { maxWidth: 280, closeButton: true });
                }
                marker.on('popupopen', () => {
                    marker.setStyle({ radius: r * 1.2 });
                    Utils.announceToScreenReader(`Sismo M${eq.label} en ${eq.place}`);
                });
                marker.on('popupclose', () => {
                    marker.setStyle({ radius: r });
                });
                marker.on('click', () => {
                    UIService.flyToQuake(eq);
                });
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
        if (!query || !query.trim()) return null;
        Utils.showToast('Buscando ciudad…');
        try {
            const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(query.trim())}`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const results = await res.json();
            if (!results.length) {
                Utils.showToast(`No se encontró "${query}"`);
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
        const raw = (query || '').trim();
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
        const tsAlert = eq.tsunami ? `
            <div class="ts-popup-alert">
                <i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i> 
                ALERTA DE TSUNAMI
            </div>` : '';
        
        const shareBtn = `
  <button class="eq-popup-link eq-popup-action" onclick="UIService.shareQuake(Store.quakes.find(q => q.id === '${eq.id}'))">
        <img src="./assets/iconoApp.png" alt="" style="width:16px;height:16px;vertical-align:middle;margin-right:6px;">
        Compartir este sismo
    </button>
        `;

        const hasShakeMap = eq.types && eq.types.includes('shakemap');
        const shakeMapBtn = hasShakeMap ? `
              <button class="eq-popup-link eq-popup-action eq-popup-shakemap" onclick="MapService.toggleShakeMap('${eq.detailUrl}')">
        <img src="./assets/iconoApp.png" alt="" style="width:16px;height:16px;vertical-align:middle;margin-right:6px;">
        Ver Mapa de Sacudimiento
    </button>
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
                </div>
                ${eq.url ? `<a href="${eq.url}" target="_blank" rel="noopener noreferrer" class="eq-popup-link">Ver detalles oficiales</a>` : ''}
                ${shareBtn}
                ${shakeMapBtn}
                ${tsAlert}
            </div>
        `;
    },
    buildCard: (eq) => {
        const colorMap = { HIGH: 'r', MED: 'o', LOW: 'g' };
        const wrapper = document.createElement('div');
        const distBadge = Store.userLocation && eq.distance
            ? `<span class="dist-badge" aria-label="A ${Utils.formatDistance(eq.distance)}">${Utils.formatDistance(eq.distance)}</span>`
            : '';
        const tsBadge = eq.tsunami
            ? `<span class="ts-badge" data-id="${eq.id}" role="alert"> Tsunami</span>`
            : '';
        wrapper.innerHTML = `
            <div class="eq-card c${colorMap[eq.colorKey] || 'g'}" data-id="${eq.id}" role="button" tabindex="0" aria-label="Sismo magnitud ${eq.label} en ${eq.place}">
                <div class="eq-icon" aria-hidden="true"><i class="fa-solid fa-wave-square"></i></div>
                <div class="eq-content">
                    <div class="eq-place">${eq.place} ${distBadge}</div>
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
            countEl.setAttribute('aria-live', 'polite');
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
        [...container.children].forEach(node => {
            if (!node.dataset || !filteredIds.has(node.dataset.id)) {
                node.remove();
            }
        });
        filtered.forEach((eq, index) => {
            let card = container.querySelector(`[data-id="${eq.id}"]`);
            if (!card) {
                card = UIService.buildCard(eq);
                card.style.animationDelay = `${index * 25}ms`;
                container.appendChild(card);
            }
            card.style.order = index;
        });
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
            if (!cached.length || Store.quakes.length) return;
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
            Utils.showToast('Mostrando datos guardados mientras se actualiza…');
        } catch (err) {
            console.warn('[DataService] No se pudo precargar caché:', err);
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
                console.warn(`[DataService] Intento ${i + 1} fallido. Reintentando en ${backoffDelay}ms...`);
                await new Promise(resolve => {
                    Store.timers.retry = setTimeout(resolve, backoffDelay);
                });
            }
        }
    },
    fetchQuakes: async () => {
        try {
            // Se piden los datos a ambas APIs (USGS y EMSC) en paralelo
            const [res1, res2] = await Promise.allSettled([
                DataService.fetchWithRetry(Config.API_URL),
                DataService.fetchWithRetry(Config.API_URL_2)
            ]);

            let features = [];
            
            if (res1.status === 'fulfilled' && res1.value.features) {
                features = features.concat(res1.value.features);
            }
            if (res2.status === 'fulfilled' && res2.value.features) {
                features = features.concat(res2.value.features);
            }

            // Normaliza y elimina duplicados, guardando en un Map
            const uniqueQuakes = new Map();
            features.forEach(f => {
                const normalized = Utils.normalizeQuake(f);
                if (!uniqueQuakes.has(normalized.id)) {
                    uniqueQuakes.set(normalized.id, normalized);
                }
            });

            // Convertimos a array, ordenamos por tiempo más reciente y limitamos a 150 sismos
            const newQuakes = Array.from(uniqueQuakes.values())
                .sort((a, b) => b.time - a.time)
                .slice(0, 150);
                
            if (Store.userLocation) {
                newQuakes.forEach(eq => {
                    eq.distance = Utils.calcDistance(Store.userLocation.lat, Store.userLocation.lng, eq.lat, eq.lng);
                });
            }
            
            const changed = newQuakes.length !== Store.quakes.length || newQuakes[0]?.id !== Store.quakes[0]?.id;
            if (changed) {
                await DBService.saveQuakes(newQuakes).catch(err => {
                    console.warn('[DBService] No se pudo guardar en caché:', err);
                });
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
            Utils.showToast(`${newQuakes.length} terremotos cargados`);
            Store.retryCount = 0;
        } catch (error) {
            console.error("[DataService] Error crítico:", error);
            try {
                const cached = await DBService.getQuakes();
                if (cached.length > 0) {
                    Store.quakes = cached;
                    UIService.refreshView();
                    Utils.showToast('Mostrando datos en caché (sin conexión)');
                }
            } catch (cacheErr) {
                console.warn('[DataService] No hay caché disponible');
            }
            Utils.showToast('Error al cargar datos. Verifica tu conexión.');
            ConnectionService.requestBackgroundSync();
        } finally {
            ConnectionService.render();
            SpinnerService.hide();
        }
    },
    checkForAlerts: (newQuakes) => {
        const novelty = newQuakes.filter(q => !Store.knownIds[q.id]);
        if (novelty.length > 0) {
            novelty.sort((a, b) => b.mag - a.mag);
            const biggest = novelty[0];
            if (biggest.isHigh || biggest.tsunami) {
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
                    : `<i class="fa-solid fa-rotate-right fa-spin" aria-hidden="true"></i> Actualizando...`;
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
                const count = data.features.length;
                Utils.showToast(`⚠️ ${count} alerta(s) de tsunami activa(s) en el mundo`);
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

/* SERVICIO DE ALERTAS */
const AlertService = {
    sounds: {},
    pool: {},
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
            duration: 15000, detail: 'Ver boletín completo →',
            action: (eq) => TsunamiService.show(eq.id), notify: 'ALERTA TSUNAMI'
        },
        nearby: {
            class: 'eq-alert', 
            // Dinámico: muestra el nombre de la zona favorita si existe, o "(GPS)"
            eyebrow: (eq) => eq.zoneName ? `CERCA DE: ${eq.zoneName.toUpperCase()}` : 'TERREMOTO CERCA (GPS)',
            title: (eq) => `M ${eq.label} a ${Utils.formatDistance(eq.distance)}`, sound: 'NEARBY',
            duration: 0, detail: 'Ver en mapa →',
            action: (eq) => UIService.flyToQuake(eq), 
            notify: (eq) => eq.zoneName ? `Sismo cerca de ${eq.zoneName}` : 'Sismo Cercano'
        },
        high: {
            class: 'eq-alert', eyebrow: 'SISMO DE ALTA MAGNITUD',
            title: (eq) => `Magnitud M ${eq.label} registrada`, sound: 'EARTHQUAKE',
            duration: 10000, detail: 'Ver en mapa →',
            action: (eq) => UIService.flyToQuake(eq), notify: 'Sismo Fuerte'
        }
    },
    play: (type, loop = false, duration = 0) => {
        AlertService.stop(type);
        if (!Config.SOUND_ENABLED) return;
        const base = AlertService.pool[type] || AlertService.pool.EARTHQUAKE;
        const audio = base ? base.cloneNode(true) : new Audio(Config.AUDIO[type] || Config.AUDIO.EARTHQUAKE);
        audio.volume = type === 'TSUNAMI' ? 0.8 : 0.5;
        audio.loop = loop;
        AlertService.sounds[type] = audio;
        audio.play().catch(() => console.warn(`[Audio] ${type} bloqueado por el navegador`));
        if (duration > 0) setTimeout(() => AlertService.stop(type), duration);
    },
    stop: (type) => {
        if (AlertService.sounds[type]) {
            AlertService.sounds[type].pause();
            AlertService.sounds[type] = null;
        }
    },
    stopAll: () => Object.keys(AlertService.sounds).forEach(k => AlertService.stop(k)),
    show: (eq, isTsunami, isNearby) => {
        if (!isTsunami && !isNearby && !eq.isHigh) return;
        AlertService.stopAll();
        const banner = document.getElementById('alert-banner');
        if (!banner) return;
        const cfg = AlertService._config[isTsunami ? 'tsunami' : isNearby ? 'nearby' : 'high'];
        banner.className = `${cfg.class} show`;
        banner.setAttribute('role', 'alert');
        banner.setAttribute('aria-live', 'assertive');
        
        document.getElementById('ab-icon-wrap').innerHTML = isTsunami ? ICONS.tsunami : ICONS.earthquake;
        
        document.getElementById('ab-eyebrow').textContent = typeof cfg.eyebrow === 'function' ? cfg.eyebrow(eq) : cfg.eyebrow;
        document.getElementById('ab-title').textContent = typeof cfg.title === 'function' ? cfg.title(eq) : cfg.title;
        document.getElementById('ab-msg').textContent = `${eq.place} · Prof. ${eq.depth.toFixed(0)} km`;
        
        const detEl = document.getElementById('ab-detail');
        detEl.textContent = cfg.detail;
        detEl.onclick = () => { cfg.action(eq); AlertService.hide(); };
        
        const progress = document.getElementById('ab-progress');
        if (progress) {
            progress.style.animation = 'none';
            progress.offsetHeight;
            progress.style.animation = 'ab-shrink 8000ms linear forwards';
        }
        clearTimeout(Store.timers.alert);
        Store.timers.alert = setTimeout(() => AlertService.hide(), 8000);
        AlertService.play(cfg.sound, false, cfg.duration || 8000);
        
        if ('Notification' in window && Notification.permission === 'granted') {
            const notifyText = typeof cfg.notify === 'function' ? cfg.notify(eq) : cfg.notify;
            new Notification(notifyText, { body: eq.place, icon: './assets/iconoApp.png', requireInteraction: true });
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

/* SERVICIO DE ZONAS FAVORITAS (local) */
const FavoritesService = {
    load: async () => {
        try {
            const saved = await DBService.getSetting('favoriteZones');
            Store.favoriteZones = Array.isArray(saved) ? saved : [];
        } catch (err) {
            console.warn('[FavoritesService] Error al cargar:', err);
            Store.favoriteZones = [];
        }
        FavoritesService.render();
    },

    persist: async () => {
        try {
            await DBService.saveSetting('favoriteZones', Store.favoriteZones);
        } catch (err) {
            console.warn('[FavoritesService] Error al guardar:', err);
            Utils.showToast('No se pudo guardar la zona favorita');
        }
    },

    pending: [],
    pendingQuery: '',

    esc: (v) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),

    add: async (name, lat, lng, address = '', precise = false) => {
        const zone = { id: FavoritesService.uuid(), name, lat, lng, address, precise, synced: false };
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
        const query = document.getElementById('fav-search-city')?.value.trim();
        if (!query) {
            Utils.showToast('Escribe una dirección o ciudad');
            return;
        }
        const results = await MapService.searchAddress(query);
        if (!results.length) {
            Utils.showToast(`No se encontró "${query}"`);
            return;
        }
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
        const note = list[0].precise
            ? 'Elige la ubicación correcta:'
            : 'No se halló el número exacto; estas son ubicaciones aproximadas. Elige una:';
        box.innerHTML = `<p class="fav-results-note">${note}</p>` + list.map((r, i) => `
            <button type="button" class="fav-result" onclick="FavoritesService.pick(${i})">
                <i class="fa-solid fa-location-dot" aria-hidden="true"></i> ${FavoritesService.esc(r.label)}
            </button>`).join('');
    },

    pick: async (i) => {
        const r = FavoritesService.pending[i];
        if (!r) return;
        const nameInput = document.getElementById('fav-search-name');
        const addrInput = document.getElementById('fav-search-city');
        const fallbackName = FavoritesService.pendingQuery.split(',')[0].trim() || r.label.split(',')[0];
        const zone = await FavoritesService.add(nameInput?.value.trim() || fallbackName, r.lat, r.lng, r.label, r.precise);
        if (!r.precise) Utils.showToast('Ubicación aproximada (calle/colonia)');
        FavoritesService.pending = [];
        FavoritesService.renderResults();
        if (nameInput) nameInput.value = '';
        if (addrInput) addrInput.value = '';
        FavoritesService.flyTo(zone.id);
    },

    uuid: () => (crypto.randomUUID
        ? crypto.randomUUID()
        : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
            const r = Math.random() * 16 | 0;
            return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
        })),

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
                        <button class="fav-zone-remove" onclick="FavoritesService.remove('${z.id}')" aria-label="Eliminar ${FavoritesService.esc(z.name)}">
                            <i class="fa-solid fa-trash"></i>
                        </button>
                    </div>
                `).join('');
            }
        }
        FavoritesService.renderMapMarkers();
    },

    renderMapMarkers: () => {
        if (!MapService.instance) return;
        if (!Store.favoriteMarkersLayer) {
            Store.favoriteMarkersLayer = L.layerGroup().addTo(MapService.instance);
        }
        Store.favoriteMarkersLayer.clearLayers();
        Store.favoriteZones.forEach(zone => {
            const marker = L.marker([zone.lat, zone.lng], {
                icon: L.divIcon({
                    className: '',
                    html: `<div class="fav-marker"><i class="fa-solid fa-star" aria-hidden="true"></i></div>`,
                    iconSize: [30, 30],
                    iconAnchor: [15, 30],
                    popupAnchor: [0, -28]
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
            const nearby = Store.quakes.filter(eq => {
                const d = Utils.calcDistance(zone.lat, zone.lng, eq.lat, eq.lng);
                return d <= Config.NEARBY_RADIUS_KM && eq.mag >= Config.ALERT.NEARBY_MIN_MAG;
            });
            if (nearby.length === 0) return;
            nearby.sort((a, b) => b.mag - a.mag);
            const strongest = nearby[0];
            const key = `${zone.id}:${strongest.id}`;
            if (Store.notifiedNearby[key]) return;
            Store.notifiedNearby[key] = true;
            const dist = Utils.calcDistance(zone.lat, zone.lng, strongest.lat, strongest.lng);
            
            // Pasamos el nombre de la zona a la alerta
            const eqForAlert = { ...strongest, distance: dist, zoneName: zone.name };
            
            setTimeout(() => AlertService.show(eqForAlert, false, true), 1500 + idx * 9000);
        });
    }
};

const GEO_ERRORS = {
    1: 'Permiso de ubicación denegado',
    2: 'Información de ubicación no disponible',
    3: 'Tiempo de espera agotado',
    0: 'Error desconocido de ubicación'
};

/* SERVICIO DE CLIMA */
/* SERVICIO DE CLIMA */
const WeatherService = {
    currentData: null,
    dailyData: null, // Guardará el pronóstico de la semana
    
    // Diccionario de la Organización Meteorológica Mundial (WMO) en español
    weatherCodes: {
        0: 'Cielo despejado', 1: 'Mayormente despejado', 2: 'Parcialmente nublado', 3: 'Nublado',
        45: 'Niebla', 48: 'Niebla escarchada', 51: 'Llovizna ligera', 53: 'Llovizna moderada', 55: 'Llovizna densa',
        61: 'Lluvia ligera', 63: 'Lluvia moderada', 65: 'Lluvia fuerte', 71: 'Nieve ligera', 73: 'Nieve moderada',
        75: 'Nieve fuerte', 95: 'Tormenta eléctrica'
    },
    
    // Asigna un icono de FontAwesome basado en el código del clima
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
            // Agregamos los parámetros 'daily' y 'timezone' para obtener la semana
            const url = `${Config.WEATHER_API}?latitude=${lat}&longitude=${lng}&current_weather=true&daily=weathercode,temperature_2m_max,temperature_2m_min&timezone=auto`;
            const res = await fetch(url);
            const data = await res.json();
            
            if (data.current_weather) {
                WeatherService.currentData = data.current_weather; 
                WeatherService.dailyData = data.daily; // Guardamos los 7 días
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
            weeklyHtml = `
                <div class="weather-week-container">
                    <div class="weather-week-title">Pronóstico de la semana</div>
                    <div class="week-scroll">`;
            
            for (let i = 0; i < daily.time.length; i++) {
                const date = new Date(daily.time[i] + 'T00:00:00');
                const dayName = i === 0 ? 'Hoy' : date.toLocaleDateString('es-ES', { weekday: 'short', timeZone: 'UTC' });
                const max = Math.round(daily.temperature_2m_max[i]);
                const min = Math.round(daily.temperature_2m_min[i]);
                const iconClass = WeatherService.getIcon(daily.weathercode[i]);

                weeklyHtml += `
                    <div class="day-card">
                        <div class="day-name">${dayName}</div>
                        <div class="day-icon"><i class="fa-solid ${iconClass}"></i></div>
                        <div class="day-temps">
                            <span class="day-max">${max}°</span>
                            <span class="day-min">${min}°</span>
                        </div>
                    </div>`;
            }
            weeklyHtml += `</div></div>`;
        }
        
        modal.innerHTML = `
            <div class="set-box weather-content">
                <div class="set-head">
                    <div class="set-title">
                        <i class="fa-solid fa-cloud-sun" aria-hidden="true"></i> Clima Local
                    </div>
                    <button class="set-close" onclick="WeatherService.close()" aria-label="Cerrar modal"><i class="fa-solid fa-xmark"></i></button>
                </div>
                <div class="set-body weather-body">
                    <div class="weather-temp-main">${Math.round(weather.temperature)}°C</div>
                    <div class="weather-desc">${desc}</div>
                    <div class="weather-grid">
                        <div class="weather-stat-card">
                            <div class="weather-stat-label">Viento</div>
                            <div class="weather-stat-val"><i class="fa-solid fa-wind" style="color: var(--muted)"></i> ${weather.windspeed} km/h</div>
                        </div>
                        <div class="weather-stat-card">
                            <div class="weather-stat-label">Dirección</div>
                            <div class="weather-stat-val"><i class="fa-regular fa-compass" style="color: var(--muted)"></i> ${weather.winddirection}°</div>
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
                Store.quakes.forEach(eq => {
                    eq.distance = Utils.calcDistance(lat, lng, eq.lat, eq.lng);
                });
                LocationService.renderUserMarker(lat, lng, accuracy);
                if (MapService.instance) {
                    MapService.instance.flyTo([lat, lng], 9, { animate: true, duration: 1.5 });
                }
                UIService.refreshView();
                LocationService.checkNearby();
                
                WeatherService.fetchLocalWeather(lat, lng);
                
                Store.isLocating = false;
                Utils.showToast(`Ubicación encontrada`);
                Utils.announceToScreenReader('Ubicación actualizada');
            },
            (err) => {
                Store.isLocating = false;
                Utils.showToast(GEO_ERRORS[err.code] || 'Error al obtener ubicación');
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
            radius: Math.max(acc, 30),
            color: '#032b5c',
            fillColor: '#60a5fa',
            fillOpacity: 0.1,
            weight: 1
        }).addTo(map);
        Store.userMarker = L.marker([lat, lng], {
            icon: L.divIcon({
                className: '',
                html: '<div class="pulse" role="img" aria-label="Tu ubicación"></div>',
                iconSize: [16, 16],
                iconAnchor: [8, 8]
            }),
            keyboard: false
        }).addTo(map);
    },
    checkNearby: () => {
        if (!Store.userLocation) return;
        const nearby = Store.quakes.filter(eq =>
            eq.distance <= Config.NEARBY_RADIUS_KM &&
            eq.mag >= Config.ALERT.NEARBY_MIN_MAG &&
            !Store.notifiedNearby[eq.id]
        );
        if (nearby.length > 0) {
            nearby.sort((a, b) => b.mag - a.mag);
            const strongest = nearby[0];
            Store.notifiedNearby[strongest.id] = true;
            setTimeout(() => {
                AlertService.show(strongest, false, true);
            }, 1500);
        }
    }
};

/* SERVICIO DE TSUNAMI */
const TsunamiService = {
    show: (id) => {
        const eq = Store.quakes.find(q => q.id === id);
        if (!eq) {
            console.warn('[TsunamiService] Evento no encontrado:', id);
            return;
        }
        const modal = document.getElementById('tsunami-modal');
        if (!modal) {
            console.error('[TsunamiService] Modal no existe en el DOM');
            return;
        }
        modal.innerHTML = TsunamiService.render(eq);
        modal.classList.add('open');
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');
        requestAnimationFrame(() => {
            modal.querySelector('.tsm-close')?.focus();
        });
    },
    render: (eq) => `
        <div class="tsm-box">
            <div class="tsm-head">
                <div class="tsm-title">
                    <i class="fa-solid fa-house-tsunami" aria-hidden="true"></i> 
                    Boletín de Alerta
                </div>
                <button class="tsm-close" onclick="TsunamiService.close()" aria-label="Cerrar modal"><i class="fa-solid fa-xmark"></i></button>
            </div>
            <div class="tsm-body">
                <div class="tsm-warn" role="alert">
                    <i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i>
                    <div><strong>ALERTA ACTIVA:</strong> Potencial tsunamigénico. Evacúe a zonas altas.</div>
                </div>
                <div class="tsm-section">
                    <h3>Datos del Evento</h3>
                    <div class="tsm-grid">
                        <div class="tsm-item">
                            <div class="tsm-label">Magnitud</div>
                            <div class="tsm-val" style="color:${eq.color}">M ${eq.label}</div>
                        </div>
                        <div class="tsm-item">
                            <div class="tsm-label">Profundidad</div>
                            <div class="tsm-val">${eq.depth.toFixed(0)} km</div>
                        </div>
                    </div>
                </div>
                <div class="tsm-actions">
                    <button class="tsm-btn" onclick="TsunamiService.close()">Cerrar</button>
                    ${eq.url ? `<a href="${eq.url}" target="_blank" rel="noopener noreferrer" class="tsm-btn danger">Ver Detalles</a>` : ''}
                </div>
            </div>
        </div>
    `,
    close: () => {
        const modal = document.getElementById('tsunami-modal');
        if (!modal) return;
        modal.classList.remove('open');
        modal.removeAttribute('role');
        modal.removeAttribute('aria-modal');
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
        handle.addEventListener('touchstart', e => {
            startY = e.touches[0].clientY;
            sheet.style.transition = 'none';
        }, { passive: true });
        handle.addEventListener('touchmove', e => {
            currentY = e.touches[0].clientY;
            const diff = startY - currentY;
            const max = -window.innerHeight * 0.75;
            const clamped = Math.max(max, Math.min(0, diff));
            if (pendingFrame) return;
            pendingFrame = requestAnimationFrame(() => {
                sheet.style.transform = `translateY(${clamped}px)`;
                pendingFrame = null;
            });
        }, { passive: true });
        handle.addEventListener('touchend', () => {
            sheet.style.transition = 'transform 0.3s';
            const y = parseInt(sheet.style.transform.replace(/[^\d-]/g, '')) || 0;
            const h = window.innerHeight;
            BottomSheet.set(y < -h * 0.5 ? 'expanded' : y < -h * 0.2 ? 'half' : 'collapsed');
        });
        document.getElementById('sheet-header')?.addEventListener('click', e => {
            if (!e.target.closest('button')) BottomSheet.toggle();
        });
        document.addEventListener('keydown', e => {
            if (e.key === 'Escape') BottomSheet.collapse();
        });
        document.addEventListener('pointerdown', e => {
            if (BottomSheet.state === 'collapsed') return;
            if (sheet.contains(e.target)) return;
            BottomSheet.collapse();
        });
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
    DEFAULTS: {
        nearbyRadiusKm: Config.NEARBY_RADIUS_KM,
        alertThreshold: Config.ALERT.HIGH_THRESHOLD,
        distanceUnit: Config.DISTANCE_UNIT,
        soundEnabled: Config.SOUND_ENABLED
    },
    load: async () => {
        let prefs = SettingsService.DEFAULTS;
        try {
            const saved = await DBService.getSetting(SettingsService.KEY);
            if (saved) prefs = { ...SettingsService.DEFAULTS, ...saved };
        } catch (err) {
            console.warn('[SettingsService] No se pudieron cargar los ajustes:', err);
        }
        SettingsService.apply(prefs);
        SettingsService.populateForm(prefs);
    },
    apply: (prefs) => {
        Config.NEARBY_RADIUS_KM = prefs.nearbyRadiusKm;
        Config.ALERT.HIGH_THRESHOLD = prefs.alertThreshold;
        Config.DISTANCE_UNIT = prefs.distanceUnit;
        Config.SOUND_ENABLED = prefs.soundEnabled;
        if (Store.quakes.length) {
            Store.quakes.forEach(eq => { eq.isHigh = eq.mag >= Config.ALERT.HIGH_THRESHOLD; });
            UIService.refreshView();
        }
    },
    populateForm: (prefs) => {
        const radius = document.getElementById('set-radius');
        const threshold = document.getElementById('set-threshold');
        const unit = document.getElementById('set-unit');
        const sound = document.getElementById('set-sound');
        if (radius) radius.value = String(prefs.nearbyRadiusKm);
        if (threshold) threshold.value = String(prefs.alertThreshold);
        if (unit) unit.value = prefs.distanceUnit;
        if (sound) sound.checked = prefs.soundEnabled;
    },
    save: async (patch) => {
        const current = {
            nearbyRadiusKm: Config.NEARBY_RADIUS_KM,
            alertThreshold: Config.ALERT.HIGH_THRESHOLD,
            distanceUnit: Config.DISTANCE_UNIT,
            soundEnabled: Config.SOUND_ENABLED
        };
        const merged = { ...current, ...patch };
        SettingsService.apply(merged);
        try {
            await DBService.saveSetting(SettingsService.KEY, merged);
            Utils.showToast('Ajustes guardados');
        } catch (err) {
            console.warn('[SettingsService] No se pudieron guardar los ajustes:', err);
            Utils.showToast('No se pudo guardar el ajuste');
        }
    },
    open: () => document.getElementById('settings-modal')?.classList.add('open'),
    close: () => document.getElementById('settings-modal')?.classList.remove('open')
};

/* SERVICIO DE CONEXIÓN (estado online/offline + Background Sync) */
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
        if (!Store.isOnline) {
            txt.textContent = 'Sin conexión';
        } else if (Store.lastFetchTime) {
            txt.textContent = `Actualizado ${Utils.timeAgo(Store.lastFetchTime)}`;
        } else {
            txt.textContent = 'En línea';
        }
    },
    requestBackgroundSync: async () => {
        try {
            if ('serviceWorker' in navigator && 'SyncManager' in window) {
                const reg = await navigator.serviceWorker.ready;
                await reg.sync.register('sync-earthquakes');
            }
        } catch (err) {
            console.warn('[ConnectionService] Background Sync no disponible:', err);
        }
    }
};

/* Inicialización */
document.addEventListener('DOMContentLoaded', async () => {
    await DBService.init?.().catch(err => console.warn('[DB] Error:', err));
    const theme = localStorage.getItem('theme') || 'dark';
    document.documentElement.setAttribute('data-theme', theme);
    MapService.init();
    BottomSheet.init();
    UIService.initDelegation();
    AlertService.init();
    ConnectionService.init();

    setTimeout(() => {
        if (!SpinnerService.hidden) {
            SpinnerService.hide();
            Utils.showToast('La carga está tardando más de lo normal. Revisa tu conexión.');
        }
    }, 12000);

    SettingsService.load().catch(err => console.warn('[Settings] Error:', err));
    FavoritesService.load().catch(err => console.warn('[Favorites] Error:', err));

    if ('Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission();
    }
    DataService.loadCachedFirst();
    DataService.fetchQuakes();
    DataService.startAutoRefresh();
    DataService.fetchActiveTsunamiAlerts(); 

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