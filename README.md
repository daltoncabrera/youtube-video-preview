# YouTube Preview Popup 🎥

**Una extensión de Chrome para previsualizar videos de YouTube sin interrupciones.**

## 💡 ¿Por qué surge este proyecto?

El objetivo principal es **mejorar la experiencia de previsualización nativa de YouTube**.

Aunque YouTube ofrece una vista previa básica al pasar el mouse, esta suele ser limitada. Este proyecto nace para ofrecer una solución más robusta: visualizar el video completo, con sonido y control total, **sin necesidad de abrirlo ni perder la ventana actual**.

Es una herramienta de productividad personal diseñada para navegar de forma más fluida, evitando abrir pestañas innecesarias y manteniendo el contexto de tu búsqueda.

## ✨ Características Principales

*   **Preview "In-Place" (Incrustado):** Abre una ventana flotante sobre la misma página.
    *   🛑 **Sin salir de la web:** El video se reproduce encima.
    *   📏 **Redimensionable y Arrastrable:** Colócalo donde quieras.
    *   💾 **Persistencia:** Recuerda el tamaño y posición que le diste para el siguiente video.
    *   🔄 **Actualización Inteligente:** Si haces click en otro video, el reproductor volador se actualiza instantáneamente sin cerrarse.
*   **Posicionamiento Inteligente:** Configura dónde quieres que aparezca el botón de "Preview" (Top-Left, Top-Right, Center) para evitar conflictos con los botones nativos de YouTube ("Ver más tarde", etc.).
*   **Modo Zen (Alternativo):** Opción para abrir el video en una ventana popup nativa sin distracciones (sin comentarios, sin barra lateral, solo video).
*   **Bypass de Restricciones:** Utiliza una estrategia de Proxy Hosted inteligente para evitar los bloqueos de "embed" de YouTube en extensiones.

## 🛠️ Instalación (Modo Desarrollador)

1.  Clona o descarga este repositorio.
2.  Abre Google Chrome y ve a `chrome://extensions/`.
3.  Activa el "Modo de desarrollador" (arriba a la derecha).
4.  Haz click en "Cargar descomprimida" (Load unpacked).
5.  Selecciona la carpeta `youtube_preview_popup` de este proyecto.
6.  ¡Listo! Verás el botón "Preview" al pasar el mouse sobre cualquier miniatura en YouTube.

## ⚙️ Configuración

Haz click en el icono de la extensión (el ojo rojo 👁️) para acceder al menú de opciones:

*   **Strategy:** Elige entre "Embedded Proxy" (Recomendado) o "Zen Window".
*   **Button Position:** Decide dónde aparece el botón de preview en las miniaturas.
*   **Default Size/Location:** Define el tamaño y posición inicial del reproductor flotante.


## ☕ Buy me a Coffee

Si encuentras útil esta extensión y quieres apoyar su desarrollo:


[![Donate with PayPal](https://img.shields.io/badge/Donate-PayPal-00457C?style=for-the-badge&logo=paypal&logoColor=white)](https://www.paypal.com/donate/?hosted_button_id=XM558AC2VE3Z6)

---
*Hecho con ❤️ y código para productividad personal.*

> **Nota:** Este proyecto ha sido desarrollado con la asistencia de **Antigravity** (Google DeepMind).
