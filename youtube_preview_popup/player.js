// Get Video ID from URL query
const urlParams = new URLSearchParams(window.location.search);
const videoId = urlParams.get('v');
const container = document.getElementById('player-container');
const fallback = document.getElementById('fallback');

if (videoId) {
    const iframe = document.createElement('iframe');

    // Exact standard embed parameters recommended by YouTube
    // Removed autoplay=1 to avoid "user interaction required" blocks or bot detection
    iframe.src = `https://www.youtube.com/embed/${videoId}?rel=0`;

    iframe.allow = "accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share";
    iframe.allowFullscreen = true;

    // Use standard policy provided by YouTube Share
    iframe.referrerPolicy = "strict-origin-when-cross-origin";

    container.appendChild(iframe);

    // Keep fallback link visible just in case
    const link = document.createElement('a');
    link.href = `https://www.youtube.com/watch?v=${videoId}`;
    link.target = "_blank";
    link.innerText = "Open / Watch on YouTube";

    // Style update for fallback
    link.style.display = "block";
    link.style.textAlign = "center";
    link.style.marginTop = "0px";

    fallback.appendChild(link);
} else {
    document.body.innerText = "No Video ID";
    document.body.style.color = "white";
}
