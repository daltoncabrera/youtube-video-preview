# YouTube Embed Host

Este es un proyecto minimalista diseñado para servir como "Proxy de Reproducción" para la extensión **Youtube Preview Popup**.

## ¿Para qué sirve?
Al alojar este archivo en un servidor público (fuera de la extensión), "engañamos" a las restricciones de YouTube, ya que el video se cargará como si estuviera en una web normal (como un blog o noticia), lo cual está permitido.

## Cómo usarlo

### 1. Despliegue (Opción Recomendada: Vercel/Netlify)
Es gratis y toma 1 minuto.

1.  Sube esta carpeta a GitHub (o arrástrala al dashboard de Netlify).
2.  Obtén la URL pública (ej: `https://mi-proxy-youtube.vercel.app`).

### 2. Configuración en la Extensión
1.  Abre la configuración de la extensión **Youtube Preview Popup**.
2.  Selecciona la estrategia **"Embedded Proxy Player"**.
3.  En el campo "Proxy Server URL", pega tu URL seguido de `?v=`.
    *   **Ejemplo:** `https://mi-proxy-youtube.vercel.app/?v=`
    *   **Nota:** Es importante que termine en `?v=` o `/?v=` para que la extensión añada el ID del video a continuación.

## Estructura
*   `index.html`: Contiene la lógica para leer el parámetro `?v=VIDEO_ID` y renderizar el iframe de YouTube con los permisos correctos.

## Pruebas
Puedes probar que funcione visitando:
`https://TU-DOMINIO.com/?v=dQw4w9WgXcQ`
(Debería cargar el video automáticamente).
