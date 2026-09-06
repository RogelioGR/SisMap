
const ENV = {
    CARTO_API_KEY: 'cb1_2xn4_1_038a5c68ca6fbbb0ca36839f',
    USGS_API_URL: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson'
};

const Config = {
  API_URL: ENV.USGS_API_URL,
  REFRESH_INTERVAL: 60,
  NEARBY_RADIUS_KM: 1500,
  MAX_RETRY_ATTEMPTS: 3,
  RETRY_DELAY: 1000,
  
  // Colores por magnitud
  COLORS: {
    HIGH: '#ef4444',
    MED: '#f97316',
    LOW: '#22c55e',
    TSUNAMI_BORDER: '#fca5a5'
  },
  
  AUDIO: {
    EARTHQUAKE: 'https://assets.mixkit.co/active_storage/sfx/2869/2869-preview.mp3',
    TSUNAMI: 'https://assets.mixkit.co/active_storage/sfx/2869/2869-preview.mp3',
    NEARBY: 'https://assets.mixkit.co/active_storage/sfx/2568/2568-preview.mp3'
  },
  
  MAP: {
    DEFAULT_CENTER: [20, -30],
    DEFAULT_ZOOM: 3,
    MIN_ZOOM: 2,
    MAX_ZOOM: 19,
    TILE_LIGHT: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    TILE_DARK: `https://basemaps.cartocdn.com/rastertiles/dark_all/{z}/{x}/{y}.png?key=${ENV.CARTO_API_KEY}`,
    ATTRIBUTION: '&copy; OpenStreetMap contributors',
    ATTRIBUTION_DARK: '&copy; OpenStreetMap contributors &copy; CARTO'
  },
  
  DB: {
    NAME: 'seismic-db',
    VERSION: 1,
    STORES: {
      EARTHQUAKES: 'earthquakes',
      SETTINGS: 'settings'
    }
  }
};

/* ESTADO GLOBAL */
const Store = {
  quakes: [],
  markers: {},
  knownIds: {},
  userLocation: null,
  filter: 'all',
  isLocating: false,
  notifiedNearby: {},
  isFirstLoad: true,
  userMarker: null,
  userAccuracyCircle: null,
  timers: {
    refresh: null,
    toast: null,
    alert: null,
    retry: null
  },
  audioContext: {},
  retryCount: 0,
  lastFetchTime: 0
};

const ICONS = {
  earthquake: '<svg viewBox="0 0 24 24" fill="none"><path d="M2 12h3l2-7 3 14 2-9 2 4h8" stroke="#f97316" stroke-width="2" stroke-linecap="round"/></svg>',
  tsunami: '<svg viewBox="0 0 24 24" fill="none"><path d="M2 18c2-4 4-6 6-4s4 4 6 0 4-4 6-2" stroke="#ef4444" stroke-width="2" stroke-linecap="round"/></svg>'
};

/* SERVICIO DE INDEXEDDB */
const DBService = {
  db: null,
  
  async init() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(Config.DB.NAME, Config.DB.VERSION);
      
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        this.db = request.result;
        resolve(this.db);
      };
      
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        
        // Store de terremotos
        if (!db.objectStoreNames.contains(Config.DB.STORES.EARTHQUAKES)) {
          const quakeStore = db.createObjectStore(Config.DB.STORES.EARTHQUAKES, { keyPath: 'id' });
          quakeStore.createIndex('time', 'time', { unique: false });
          quakeStore.createIndex('mag', 'mag', { unique: false });
        }
        
        // Store de configuraciones
        if (!db.objectStoreNames.contains(Config.DB.STORES.SETTINGS)) {
          db.createObjectStore(Config.DB.STORES.SETTINGS, { keyPath: 'key' });
        }
      };
    });
  },
  
  async saveQuakes(quakes) {
    if (!this.db) await this.init();
    
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([Config.DB.STORES.EARTHQUAKES], 'readwrite');
      const store = transaction.objectStore(Config.DB.STORES.EARTHQUAKES);
      
      quakes.forEach(quake => {
        store.put({ ...quake, cachedAt: Date.now() });
      });
      
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  },
  
  async getQuakes() {
    if (!this.db) await this.init();
    
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([Config.DB.STORES.EARTHQUAKES], 'readonly');
      const store = transaction.objectStore(Config.DB.STORES.EARTHQUAKES);
      const request = store.getAll();
      
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  },
  
  async clearQuakes() {
    if (!this.db) await this.init();
    
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([Config.DB.STORES.EARTHQUAKES], 'readwrite');
      const store = transaction.objectStore(Config.DB.STORES.EARTHQUAKES);
      const request = store.clear();
      
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  },
  
  async saveSetting(key, value) {
    if (!this.db) await this.init();
    
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([Config.DB.STORES.SETTINGS], 'readwrite');
      const store = transaction.objectStore(Config.DB.STORES.SETTINGS);
      
      store.put({ key, value });
      
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  },
  
  async getSetting(key) {
    if (!this.db) await this.init();
    
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([Config.DB.STORES.SETTINGS], 'readonly');
      const store = transaction.objectStore(Config.DB.STORES.SETTINGS);
      const request = store.get(key);
      
      request.onsuccess = () => resolve(request.result?.value);
      request.onerror = () => reject(request.error);
    });
  }
};