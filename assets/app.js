
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
        const options = {
            day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit'
        };
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
            isHigh: mag >= 5.9,
            timeStr: Utils.formatDate(props.time),
            distance: null
        };
    },

    // ✅ DEBOUNCE PARA PERFORMANCE
    debounce: (fn, delay) => {
        let timer;
        return (...args) => {
            clearTimeout(timer);
            timer = setTimeout(() => fn(...args), delay);
        };
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

    /* ANUNCIO PARA LECTORES DE PANTALLA */
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
    markerCluster: null,

    init: () => {
        if (!document.getElementById('map')) return;

        MapService.instance = L.map('map', {
            center: Config.MAP.DEFAULT_CENTER,
            zoom: Config.MAP.DEFAULT_ZOOM,
            minZoom: Config.MAP.MIN_ZOOM,
            maxZoom: Config.MAP.MAX_ZOOM,
            zoomControl: false,
            maxBounds: L.latLngBounds([-85, -180], [85, 180]),
            preferCanvas: true // ✅ MEJOR PERFORMANCE
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

    /* SINCRONIZAR MARKERS */
    syncMarkers: (quakes) => {
        if (!MapService.instance) return;

        const map = MapService.instance;
        const currentIds = new Set();
        const visibleFilter = Store.filter;

        const isVisible = (eq) => {
            if (visibleFilter === 'all') return true;
            if (visibleFilter === 'red') return eq.mag >= 5.9;
            if (visibleFilter === 'orange') return eq.mag >= 3.9 && eq.mag < 5.9;
            if (visibleFilter === 'green') return eq.mag < 3.9;
            return true;
        };

        quakes.forEach(eq => {
            currentIds.add(eq.id);

            /* Verificar si el marker ya existe */
            if (Store.markers[eq.id]) {
                const marker = Store.markers[eq.id];
                const wasVisible = map.hasLayer(marker);
                const shouldBeVisible = isVisible(eq);

                if (wasVisible !== shouldBeVisible) {
                    if (shouldBeVisible) marker.addTo(map);
                    else map.removeLayer(marker);
                }

                if (typeof UIService.createPopupContent === 'function') {
                    marker.setPopupContent(UIService.createPopupContent(eq));
                }
            } else {
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
                    marker.bindPopup(UIService.createPopupContent(eq), {
                        maxWidth: 280,
                        closeButton: true
                    });
                }
                /* Eventos de popup */
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

                if (isVisible(eq)) {
                    marker.addTo(map);
                }
            }
        });

        /* Limpiar markers eliminados */

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

        MapService.instance.flyTo([eq.lat, eq.lng], 7, {
            animate: true,
            duration: 1.5,
            easeLinearity: 0.25
        });

        setTimeout(() => {
            const m = Store.markers[eq.id];
            if (m) {
                m.openPopup();
                m.getElement()?.focus();
            }
        }, 1400);
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

    createPopupContent: (eq) => {
        const fecha = Utils.formatDate(eq.time, true);
        const depthLbl = eq.depth < 70 ? 'superficial' : eq.depth < 300 ? 'intermedia' : 'profunda';
        
        const tsAlert = eq.tsunami ? `
            <div class="ts-popup-alert">
                <i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i> 
                ALERTA DE TSUNAMI
            </div>` : '';

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
                ${tsAlert}
            </div>
        `;
    },

    renderCards: () => {
        const container = document.getElementById('cards');
        const countEl = document.getElementById('count-text');
        if (!container) return;

        const filtered = Store.quakes.filter(UIService.shouldShow);
        
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

        const fragment = document.createDocumentFragment();
        const colorMap = { HIGH: 'r', MED: 'o', LOW: 'g' };

        filtered.forEach((eq, index) => {
            const card = document.createElement('div');
            card.className = `eq-card c${colorMap[eq.colorKey] || 'g'}`;
            card.style.animationDelay = `${index * 25}ms`;
            card.setAttribute('role', 'button');
            card.setAttribute('tabindex', '0');
            card.setAttribute('aria-label', `Sismo magnitud ${eq.label} en ${eq.place}`);

            const distBadge = Store.userLocation && eq.distance
                ? `<span class="dist-badge" aria-label="A ${Math.round(eq.distance)} kilómetros">${Math.round(eq.distance)} km</span>`
                : '';

            const tsBadge = eq.tsunami
                ? `<span class="ts-badge" onclick="event.stopPropagation(); TsunamiService.show('${eq.id}')" role="alert"> Tsunami</span>`
                : '';

            card.innerHTML = `
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
            `;

            const handler = () => UIService.flyToQuake(eq);
            card.onclick = handler;
            card.onkeydown = (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    handler();
                }
            };

            fragment.appendChild(card);
        });

        container.innerHTML = '';
        container.appendChild(fragment);
    },

    flyToQuake: (eq) => {
        BottomSheet.collapse();
        MapService.flyTo(eq);
    },

   setFilter: (filterType) => {
    Store.filter = filterType;
    
    // Buscar botón por texto
    const map = { all: 'Todos', red: 'Alto', orange: 'Medio', green: 'Bajo' };
    document.querySelectorAll('.fbtn').forEach(btn => {
        btn.classList.toggle('active', btn.textContent.trim() === map[filterType]);
    });
    
    UIService.renderCards();
    MapService.syncMarkers(Store.quakes);
}
};

/* SERVICIO DE DATOS */
const DataService = {
    fetchWithRetry: async (url, retries = Config.MAX_RETRY_ATTEMPTS, delay = Config.RETRY_DELAY) => {
        for (let i = 0; i < retries; i++) {
            try {
                const response = await fetch(url, {
                    method: 'GET',
                    headers: { 'Accept': 'application/json' },
                    signal: AbortSignal.timeout(10000) // Timeout de 10s
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

            /* Calcular distancias si hay ubicación */
            if (Store.userLocation) {
                newQuakes.forEach(eq => {
                    eq.distance = Utils.calcDistance(
                        Store.userLocation.lat, Store.userLocation.lng,
                        eq.lat, eq.lng
                    );
                });
            }
            /* Guardar en IndexedDB */
            await DBService.saveQuakes(newQuakes).catch(err => {
                console.warn('[DBService] No se pudo guardar en caché:', err);
            });

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

            MapService.syncMarkers(newQuakes);
            UIService.renderCards();

            if (Store.userLocation) LocationService.checkNearby();

            Utils.showToast(`${newQuakes.length} terremotos cargados`);
            Store.retryCount = 0;

        } catch (error) {
            console.error("[DataService] Error crítico:", error);

            // Intentar cargar desde caché
            try {
                const cached = await DBService.getQuakes();
                if (cached.length > 0) {
                    Store.quakes = cached;
                    MapService.syncMarkers(cached);
                    UIService.renderCards();
                    Utils.showToast('Mostrando datos en caché (sin conexión)');
                }
            } catch (cacheErr) {
                console.warn('[DataService] No hay caché disponible');
            }

            Utils.showToast('Error al cargar datos. Verifica tu conexión.');
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
            }
        };

        Store.timers.refresh = setInterval(updateCountdown, 1000);
    }
};

/* SERVICIO DE ALERTAS */
const AlertService = {
    sounds: {},

/* configuración centralizada */
    _config: {
        tsunami: {
            class: 'ts-alert', eyebrow: 'ALERTA DE TSUNAMI',
            title: '¡Potencial tsunami detectado!', sound: 'TSUNAMI',
            duration: 15000, detail: 'Ver boletín completo →',
            action: (eq) => TsunamiService.show(eq.id), notify: 'ALERTA TSUNAMI'
        },
        nearby: {
            class: 'eq-alert', eyebrow: 'TERREMOTO CERCANO',
            title: (eq) => `M ${eq.label} a ${Math.round(eq.distance)} km`, sound: 'NEARBY',
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
        
        const url = Config.AUDIO[type] || Config.AUDIO.EARTHQUAKE;
        const audio = new Audio(url);
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
            progress.offsetHeight; // Trigger reflow
            progress.style.animation = 'ab-shrink 8000ms linear forwards';
        }

        clearTimeout(Store.timers.alert);
        Store.timers.alert = setTimeout(() => AlertService.hide(), 8000);

        if ('Notification' in window && Notification.permission === 'granted') {
            new Notification(cfg.notify, { body: eq.place, icon: './assets/logo-Photoroom.png', requireInteraction: true });
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

                // Calcular distancias
                Store.quakes.forEach(eq => {
                    eq.distance = Utils.calcDistance(lat, lng, eq.lat, eq.lng);
                });

                LocationService.renderUserMarker(lat, lng, accuracy);

                if (MapService.instance) {
                    MapService.instance.flyTo([lat, lng], 9, {
                        animate: true,
                        duration: 1.5
                    });
                }

                UIService.renderCards();
                LocationService.checkNearby();
                Store.isLocating = false;

                Utils.showToast(`Ubicación encontrada`);
                Utils.announceToScreenReader('Ubicación actualizada');
            },
            (err) => {
                Store.isLocating = false;
                Utils.showToast(GEO_ERRORS[err.code] || 'Error al obtener ubicación');
            },
            {
                enableHighAccuracy: true,
                timeout: 10000,
                maximumAge: 300000 // 5 minutos en caché
            }
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
            eq.mag >= 3.0 &&
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

/* servicio de tsunami */
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
    <div class="tsm-head">
      <div class="tsm-title">
        <i class="fa-solid fa-house-tsunami" aria-hidden="true"></i> 
        Boletín de Alerta
      </div>
      <button class="tsm-close" onclick="TsunamiService.close()" aria-label="Cerrar modal"></button>
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
  `,
  
  close: () => {
    const modal = document.getElementById('tsunami-modal');
    if (!modal) return;
    
    modal.classList.remove('open');
    modal.removeAttribute('role');
    modal.removeAttribute('aria-modal');
  }
};

/* bottom sheet */
const BottomSheet = {
    state: 'collapsed',
    
    init: () => {
        const sheet = document.getElementById('bottom-sheet');
        const handle = document.getElementById('sheet-handle');
        if (!sheet || !handle) return;

        let startY, currentY;

        handle.addEventListener('touchstart', e => {
            startY = e.touches[0].clientY;
            sheet.style.transition = 'none';
        }, { passive: true });

        handle.addEventListener('touchmove', e => {
            currentY = e.touches[0].clientY;
            const diff = startY - currentY;
            const max = -window.innerHeight * 0.75;
            sheet.style.transform = `translateY(${Math.max(max, Math.min(0, diff))}px)`;
        }, { passive: false });

        handle.addEventListener('touchend', () => {
            sheet.style.transition = 'transform 0.3s';
            const y = parseInt(sheet.style.transform.replace(/[^\d-]/g, '')) || 0;
            const h = window.innerHeight;
            
            BottomSheet.set(y < -h * 0.5 ? 'expanded' : y < -h * 0.2 ? 'half' : 'collapsed');
        });

        // Click en header
        document.getElementById('sheet-header')?.addEventListener('click', e => {
            if (!e.target.closest('button')) BottomSheet.toggle();
        });

        // Tecla Escape
        document.addEventListener('keydown', e => {
            if (e.key === 'Escape') BottomSheet.collapse();
        });
    },

    toggle: () => BottomSheet.set(BottomSheet.state === 'collapsed' ? 'expanded' : 'collapsed'),
    
    collapse: () => BottomSheet.set('collapsed'),
    
    set: (state) => {
        const sheet = document.getElementById('bottom-sheet');
        if (!sheet) return;
        
        BottomSheet.state = state;
        sheet.className = `bottom-sheet ${state}`;
        
        // Rotar icono
        const icon = document.getElementById('chevron-icon');
        if (icon) icon.style.transform = state === 'collapsed' ? 'rotate(180deg)' : 'rotate(0)';
        
        // Actualizar mapa después de la animación
        setTimeout(() => MapService.instance?.invalidateSize(), 300);
    }
};

/* Inicialización */
document.addEventListener('DOMContentLoaded', async () => {
    await DBService.init?.().catch(err => console.warn('[DB] Error:', err));

    const theme = localStorage.getItem('theme') || 'dark';
    document.documentElement.setAttribute('data-theme', theme);
    
    MapService.init();
    BottomSheet.init();

/* Permisos y carga de datos */
    if ('Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission();
    }
    DataService.fetchQuakes();
    DataService.startAutoRefresh();

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
        toggleFilters: () => document.getElementById('navbar')?.classList.toggle('show')
    });

    /* Limpieza al cerrar la pestaña */
    window.addEventListener('beforeunload', () => {
        Object.values(Store.timers).forEach(timer => timer && clearTimeout(timer));
        AlertService.stopAll();
        MapService.instance?.remove();
    });

    /* Service Worker */
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('./sw.js')
            .then(reg => console.log('[SW] Registrado:', reg.scope))
            .catch(err => console.error('[SW] Error:', err));
    }
});
