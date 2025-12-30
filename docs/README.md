# YouTube Embed Host

This is a minimalist project designed to serve as a "Playback Proxy" for the **Youtube Preview Popup** extension.

## What is it for?
By hosting this file on a public server (outside the extension), we "bypass" YouTube's restrictions, as the video will load as if it were on a normal website (like a blog or news site), which is allowed.

## How to use it

### 1. Deployment (Recommended Option: Vercel/Netlify)
It's free and takes 1 minute.

1.  Upload this folder to GitHub (or drag it to the Netlify dashboard).
2.  Get the public URL (e.g. `https://my-youtube-proxy.vercel.app`).

### 2. Extension Configuration
1.  Open the settings of the **Youtube Preview Popup** extension.
2.  Select the **"Embedded Proxy Player"** strategy.
3.  In the "Proxy Server URL" field, paste your URL followed by `?v=`.
    *   **Example:** `https://my-youtube-proxy.vercel.app/?v=`
    *   **Note:** It is important that it ends in `?v=` or `/?v=` so that the extension adds the video ID afterwards.

## Structure
*   `index.html`: Contains the logic to read the `?v=VIDEO_ID` parameter and render the YouTube iframe with the correct permissions.

## Testing
You can test that it works by visiting:
`https://YOUR-DOMAIN.com/?v=dQw4w9WgXcQ`
( It should load the video automatically).
