# SisMap - Mapa Sísmico en Tiempo Real

Aplicación web progresiva (PWA) que monitorea terremotos en tiempo real usando la API de USGS.

<img width="1672" height="941" alt="imagenApp" src="https://github.com/user-attachments/assets/dc69eedc-d350-46ac-84d7-74ded9ac5089" />


## Características

- Mapa interactivo con Leaflet y OpenStreetMap
- Geolocalización del usuario
- Alertas en tiempo real para sismos de alta magnitud
- Detección y alertas de tsunami
- Filtros por magnitud (Alto, Medio, Bajo)
- Diseño responsive (mobile-first)
- Modo claro/oscuro
- Funciona offline (Service Worker + IndexedDB)
- Alertas sonoras
- Accesible (ARIA labels, navegación por teclado)

## Tecnologías

- HTML5, CSS3, JavaScript (Vanilla)
- [Leaflet.js](https://leafletjs.com/) - Mapas interactivos
- [USGS Earthquake API](https://earthquake.usgs.gov/) - Datos sísmicos
- [CARTO Basemaps](https://carto.com/) - Mapas oscuros
- [FontAwesome](https://fontawesome.com/) - Iconos
- Service Workers - Offline support

## Instalación

1. Clona el repositorio:
   ```bash
   git clone https://github.com/RogelioGR/SisMap.git
   cd SisMap

