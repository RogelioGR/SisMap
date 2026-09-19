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
        const mag = props.mag || 0;
        const depth = coords[2] || 0;
        const colorKey = Utils.getColorKey(mag);
        return {
            id: feature.id,
            mag: mag,
            place: props.place || 'Ubicación desconocida',
            time: props.time,
            url: props.url,
            lng: coords[0],
            lat: coords[1],
            depth: depth,
            tsunami: props.tsunami === 1,
            colorKey: colorKey,
            color: Utils.getColor(colorKey),
            label: mag.toFixed(1),
            isHigh: mag >= Config.ALERT.HIGH_THRESHOLD,
            timeStr: Utils.formatDate(props.time),
            types: props.types || '',       //  Agregado para ShakeMap
            detailUrl: props.detail || '',  // Agregado para ShakeMap
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

    /* BÚSQUEDA DE CIUDADES (Nominatim / OpenStreetMap, gratis, sin API key) */
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

    /* BÚSQUEDA POR DIRECCIÓN COMPLETA con reintentos progresivos (Nominatim).
       Ej: "Emiliano Zapata 21, Centro, 39000 Chilpancingo de los Bravo, Gro."
       Devuelve [{ lat, lng, label, precise }] */
    searchAddress: async function(query) {
        const raw = (query || '').trim();
        if (!raw) return [];
        const parts = raw.split(',').map(p => p.trim()).filter(Boolean);
        const stripNum = s => s.replace(/\s*(#|no\.?|núm\.?|num\.?)?\s*\d+\s*[a-z]?$/i, '').trim();

        // De la más específica a la más general
        const attempts = [{ q: raw, precise: true }];
        if (parts.length > 2) attempts.push({ q: [parts[0], ...parts.slice(2)].join(', '), precise: true }); // sin colonia
        const street = stripNum(parts[0]);
        if (parts.length > 1 && street && street !== parts[0]) {
            attempts.push({ q: [street, ...parts.slice(2)].join(', '), precise: false });                   // calle sin número
        }
        attempts.push({ q: parts.slice(parts.length > 2 ? 2 : 1).join(', '), precise: false });               // CP + ciudad

        Utils.showToast('Buscando dirección…');
        const seen = new Set();
        let first = true;
        try {
            for (const a of attempts) {
                if (!a.q || seen.has(a.q)) continue;
                seen.add(a.q);
                if (!first) await new Promise(r => setTimeout(r, 1100)); // Nominatim: máx. 1 petición/seg
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
const text = `[SISMAP] Sismo M${eq.label} registrado en:\nUbicación: ${eq.place}\nProfundidad: ${eq.depth.toFixed(0)} km\nMás info: ${eq.url || 'SisMap'}`;        if (navigator.share) {
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
                ${eq.url ? `<a href="${eq.url}" target="_blank" rel="noopener noreferrer" class="eq-popup-link">Ver en USGS</a>` : ''}
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
    /* Pinta lo que haya en caché de inmediato (oculta el loader al instante) mientras fetchQuakes trae datos frescos en paralelo */
    loadCachedFirst: async () => {
        try {
            const cached = await DBService.getQuakes();
            if (!cached.length || Store.quakes.length) return; // no pisar datos ya cargados por un fetch más rápido
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
            const data = await DataService.fetchWithRetry(Config.API_URL);
            const newQuakes = data.features
                .sort((a, b) => b.properties.time - a.properties.time)
                .slice(0, 100)
                .map(Utils.normalizeQuake);
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
    /* alertas de tsunami */
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
            class: 'eq-alert', eyebrow: 'TERREMOTO CERCANO',
            title: (eq) => `M ${eq.label} a ${Utils.formatDistance(eq.distance)}`, sound: 'NEARBY',
            duration: 0, detail: 'Ver en mapa →',
            action: (eq) => UIService.flyToQuake(eq), notify: 'Sismo Cercano'
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
        document.getElementById('ab-eyebrow').textContent = cfg.eyebrow;
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
            new Notification(cfg.notify, { body: eq.place, icon: './assets/iconoApp.png', requireInteraction: true });
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

/* SERVICIO DE NUBE (Supabase) — opcional: sin credenciales o sin sesión, la app sigue 100% local */
const CloudService = {
    client: null,
    user: null,

    enabled: () => !!(Config.SUPABASE.URL && Config.SUPABASE.ANON_KEY && window.supabase),

    init: async () => {
        if (!CloudService.enabled()) {
            CloudService.renderAccount();
            return;
        }
        CloudService.client = window.supabase.createClient(Config.SUPABASE.URL, Config.SUPABASE.ANON_KEY);
        CloudService.client.auth.onAuthStateChange((_event, session) => {
            const prevId = CloudService.user?.id;
            CloudService.user = session?.user || null;
            CloudService.renderAccount();
            // Fuera del callback para no bloquear el cliente de auth
            if (CloudService.user && CloudService.user.id !== prevId) {
                setTimeout(() => FavoritesService.sync(), 0);
            }
        });
    },

    mode: 'login', // 'login' | 'signup'
    busy: false,

    setMode: (mode) => {
        const email = document.getElementById('cloud-email')?.value || '';
        CloudService.mode = mode;
        CloudService.renderAccount();
        const el = document.getElementById('cloud-email');
        if (el) el.value = email;
    },

    _errorMsg: (err) => {
        const m = (err?.message || '').toLowerCase();
        if (m.includes('invalid login')) return 'Correo o contraseña incorrectos';
        if (m.includes('not confirmed')) return 'Confirma tu correo antes de iniciar sesión';
        if (m.includes('already registered')) return 'Ese correo ya está registrado';
        if (m.includes('rate limit') || m.includes('security purposes')) return 'Demasiados intentos, espera un minuto';
        if (m.includes('database error')) return 'Error del servidor al crear la cuenta';
        if (m.includes('password')) return 'Contraseña no válida (mínimo 8 caracteres)';
        return 'No se pudo completar la acción';
    },

    submit: async () => {
        if (CloudService.busy || !CloudService.client) return;
        const email = document.getElementById('cloud-email')?.value.trim();
        const password = document.getElementById('cloud-password')?.value || '';
        const isSignup = CloudService.mode === 'signup';

        if (!email || !/^\S+@\S+\.\S+$/.test(email)) { Utils.showToast('Escribe un correo válido'); return; }
        if (password.length < 8) { Utils.showToast('La contraseña debe tener al menos 8 caracteres'); return; }
        if (isSignup && password !== document.getElementById('cloud-password2')?.value) {
            Utils.showToast('Las contraseñas no coinciden');
            return;
        }

        CloudService.busy = true;
        const btn = document.getElementById('cloud-submit');
        if (btn) btn.disabled = true;
        try {
            if (isSignup) {
                const { data, error } = await CloudService.client.auth.signUp({
                    email,
                    password,
                    options: { emailRedirectTo: window.location.origin + window.location.pathname }
                });
                if (error) throw error;
                if (data.user && data.user.identities && data.user.identities.length === 0) {
                    Utils.showToast('Ese correo ya está registrado');
                } else if (!data.session) {
                    Utils.showToast('Cuenta creada. Revisa tu correo para confirmarla', 6000);
                } else {
                    Utils.showToast('Cuenta creada');
                }
            } else {
                const { error } = await CloudService.client.auth.signInWithPassword({ email, password });
                if (error) throw error;
                Utils.showToast('Sesión iniciada');
            }
        } catch (err) {
            console.warn('[Cloud] auth:', err?.message);
            Utils.showToast(CloudService._errorMsg(err), 4000);
        } finally {
            CloudService.busy = false;
            const b = document.getElementById('cloud-submit');
            if (b) b.disabled = false;
        }
    },

    signOut: async () => {
        await CloudService.client.auth.signOut();
        Utils.showToast('Sesión cerrada');
    },

    renderAccount: () => {
        const group = document.getElementById('cloud-group');
        const box = document.getElementById('cloud-account');
        if (!group || !box) return;
        if (!CloudService.enabled()) { group.style.display = 'none'; return; }
        group.style.display = '';
        if (CloudService.user) {
            box.innerHTML = `
                <div class="fav-zone-row">
                    <span class="fav-zone-name"><i class="fa-solid fa-cloud" aria-hidden="true"></i> ${FavoritesService.esc(CloudService.user.email)}</span>
                    <button class="fav-add-btn" onclick="CloudService.signOut()">Cerrar sesión</button>
                </div>
                <p class="fav-hint">Tus zonas favoritas se sincronizan con tu cuenta.</p>`;
        } else {
            const signup = CloudService.mode === 'signup';
            box.innerHTML = `
                <div class="cloud-tabs" role="tablist">
                    <button type="button" class="cloud-tab ${signup ? '' : 'active'}" role="tab" aria-selected="${!signup}" onclick="CloudService.setMode('login')">Iniciar sesión</button>
                    <button type="button" class="cloud-tab ${signup ? 'active' : ''}" role="tab" aria-selected="${signup}" onclick="CloudService.setMode('signup')">Registrarse</button>
                </div>
                <div class="cloud-form">
                    <input type="email" id="cloud-email" class="set-control" placeholder="Correo electrónico" autocomplete="email">
                    <input type="password" id="cloud-password" class="set-control" placeholder="Contraseña (mín. 8 caracteres)"
                           autocomplete="${signup ? 'new-password' : 'current-password'}"
                           onkeydown="if(event.key==='Enter'){CloudService.submit()}">
                    ${signup ? `<input type="password" id="cloud-password2" class="set-control" placeholder="Repite la contraseña" autocomplete="new-password"
                           onkeydown="if(event.key==='Enter'){CloudService.submit()}">` : ''}
                    <button type="button" id="cloud-submit" class="fav-add-btn" onclick="CloudService.submit()">
                        <i class="fa-solid ${signup ? 'fa-user-plus' : 'fa-right-to-bracket'}" aria-hidden="true"></i> ${signup ? 'Crear cuenta' : 'Entrar'}
                    </button>
                </div>
                <p class="fav-hint">Con una cuenta, tus zonas favoritas se sincronizan entre dispositivos. Sin cuenta se guardan solo en este dispositivo.</p>`;
        }
    }
};

/* SERVICIO DE ZONAS FAVORITAS (multi-ubicación) */
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
        FavoritesService.cloudUpsert([zone]);
        return zone;
    },

    remove: async (id) => {
        const zone = Store.favoriteZones.find(z => z.id === id);
        Store.favoriteZones = Store.favoriteZones.filter(z => z.id !== id);
        await FavoritesService.persist();
        FavoritesService.render();
        if (zone) Utils.showToast(`"${zone.name}" eliminada`);
        FavoritesService.cloudDelete(id);
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
        // Un solo resultado exacto: se guarda directo. Si no, el usuario elige.
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

    cloudUpsert: async (zones) => {
        if (!CloudService.user || !CloudService.client || !zones.length) return false;
        const rows = zones.map(z => ({
            id: z.id,
            user_id: CloudService.user.id,
            name: z.name,
            address: z.address || null,
            lat: z.lat,
            lng: z.lng,
            precise: !!z.precise
        }));
        const { error } = await CloudService.client.from('favorite_zones').upsert(rows);
        if (error) {
            console.warn('[Cloud] upsert:', error.message);
            Utils.showToast('No se pudo sincronizar con la nube');
            return false; // quedan con synced:false y se reintentan en la próxima sincronización
        }
        zones.forEach(z => { z.synced = true; });
        await FavoritesService.persist();
        return true;
    },

    cloudDelete: async (id) => {
        if (!CloudService.user || !CloudService.client) return;
        const { error } = await CloudService.client.from('favorite_zones').delete().eq('id', id);
        if (error) console.warn('[Cloud] delete:', error.message);
    },

    /* La nube es la fuente de verdad para zonas ya sincronizadas; las locales nuevas (synced:false) se suben. */
    sync: async () => {
        if (!CloudService.user || !CloudService.client) return;
        const isUuid = v => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
        // Migra ids antiguos (z_123...) al formato uuid que exige la tabla
        Store.favoriteZones.forEach(z => { if (!isUuid(z.id)) { z.id = FavoritesService.uuid(); z.synced = false; } });

        const { data, error } = await CloudService.client.from('favorite_zones').select('*').order('created_at');
        if (error) {
            console.warn('[Cloud] select:', error.message);
            Utils.showToast('No se pudo leer tus zonas de la nube');
            return;
        }
        const cloudIds = new Set(data.map(r => r.id));
        // Ya sincronizadas pero ausentes en la nube = borradas desde otro dispositivo
        Store.favoriteZones = Store.favoriteZones.filter(z => !z.synced || cloudIds.has(z.id));
        const localIds = new Set(Store.favoriteZones.map(z => z.id));
        const fromCloud = data
            .filter(r => !localIds.has(r.id))
            .map(r => ({ id: r.id, name: r.name, address: r.address || '', lat: r.lat, lng: r.lng, precise: !!r.precise, synced: true }));
        Store.favoriteZones.push(...fromCloud);
        const toUpload = Store.favoriteZones.filter(z => !z.synced);
        await FavoritesService.persist();
        await FavoritesService.cloudUpsert(toUpload);
        FavoritesService.render();
        Utils.showToast('Zonas sincronizadas');
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
                        <button class="fav-zone-remove" onclick="FavoritesService.remove('${z.id}')" aria-label="Eliminar ${FavoritesService.esc(z.name)}">
                            <i class="fa-solid fa-trash"></i>
                        </button>
                    </div>
                `).join('');
            }
        }
        FavoritesService.renderMapMarkers();
    },

    /* Pin distintivo (estrella) en el mapa para cada zona guardada, para diferenciarla de sismos y de tu ubicación GPS */
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

    /* Evalúa sismos cercanos a cada zona favorita, independiente del GPS */
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
            const eqForAlert = { ...strongest, distance: dist, place: `${strongest.place} (cerca de ${zone.name})` };
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
                    ${eq.url ? `<a href="${eq.url}" target="_blank" rel="noopener noreferrer" class="tsm-btn danger">Ver USGS</a>` : ''}
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

    // Failsafe: si algo en la carga se cuelga (ej. IndexedDB lento/bloqueado), no dejar el loader pegado para siempre
    setTimeout(() => {
        if (!SpinnerService.hidden) {
            SpinnerService.hide();
            Utils.showToast('La carga está tardando más de lo normal. Revisa tu conexión.');
        }
    }, 12000);

    // Ajustes y favoritos se cargan en paralelo, sin bloquear la carga de sismos (que es lo que oculta el loader)
    SettingsService.load().catch(err => console.warn('[Settings] Error:', err));
    FavoritesService.load()
        .then(() => CloudService.init())
        .catch(err => console.warn('[Favorites] Error:', err));

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