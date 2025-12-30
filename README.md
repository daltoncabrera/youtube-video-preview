# YouTube Preview Popup 🎥

**A Chrome extension to preview YouTube videos without interruptions.**

## 💡 Why this project?

The main goal is to **improve the native YouTube preview experience**.

Although YouTube offers a basic preview when hovering, it is often limited. This project was born to offer a more robust solution: visualizing the full video, with sound and full control, **without needing to open it or lose the current window**.

It is a personal productivity tool designed to navigate more fluidly, avoiding opening unnecessary tabs and maintaining the context of your search.

## ✨ Main Features

*   **"In-Place" Preview:** Opens a floating window over the same page.
    *   🛑 **Without leaving the web:** The video plays on top.
    *   📏 **Resizable and Draggable:** Place it wherever you want.
    *   💾 **Persistence:** Remembers the size and position you gave it for the next video.
    *   🔄 **Smart Update:** If you click on another video, the floating player updates instantly without closing.
*   **Smart Positioning:** Configure where you want the "Preview" button to appear (Top-Left, Top-Right, Center) to avoid conflicts with native YouTube buttons ("Watch Later", etc.).
*   **Zen Mode (Alternative):** Option to open the video in a native popup window without distractions (no comments, no sidebar, just video).
*   **Restriction Bypass:** Uses a smart Hosted Proxy strategy to avoid YouTube "embed" blocks in extensions.

## 🛠️ Installation (Developer Mode)

1.  Clone or download this repository.
2.  Open Google Chrome and go to `chrome://extensions/`.
3.  Activate "Developer mode" (top right).
4.  Click on "Load unpacked".
5.  Select the `youtube_preview_popup` folder of this project.
6.  Ready! You will see the "Preview" button when hovering over any thumbnail on YouTube.

## ⚙️ Configuration

Click on the extension icon (the red eye 👁️) to access the options menu:

*   **Strategy:** Choose between "Embedded Proxy" (Recommended) or "Zen Window".
*   **Button Position:** Decide where the preview button appears on thumbnails.
*   **Default Size/Location:** Define the initial size and position of the floating player.

## ☕ Buy me a Coffee

If you find this extension useful and want to support its development:

[![Donate with PayPal](https://img.shields.io/badge/Donate-PayPal-00457C?style=for-the-badge&logo=paypal&logoColor=white)](https://www.paypal.com/donate/?hosted_button_id=XM558AC2VE3Z6)

---

> **Note:** This project has been developed with the assistance of **Antigravity** (Google DeepMind).
