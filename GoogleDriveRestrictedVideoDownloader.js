// ==UserScript==
// @name         Google Drive Restricted Video Downloader
// @namespace    http://tampermonkey.net/
// @version      1.4
// @description  Detects and downloads restricted Google Drive videos. v1.4: runs on the whole Drive UI + scans <video>/<audio> elements directly + accepts googlevideo URLs (better detection).
// @author       Pilgrimeru
// @match        *://drive.google.com/*
// @match        *://*.drive.google.com/*
// @match        *://*.youtube.googleapis.com/*
// @match        *://*.googlevideo.com/*
// @license      MIT
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_download
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @run-at       document-start
// @downloadURL https://update.greasyfork.org/scripts/566850/Google%20Drive%20Restricted%20Video%20Downloader.user.js
// @updateURL https://update.greasyfork.org/scripts/566850/Google%20Drive%20Restricted%20Video%20Downloader.meta.js
// ==/UserScript==

(function() {
    'use strict';

    const isTopWindow = window === window.top;
    const PARAMS_TO_REMOVE = ['range', 'rn', 'rbuf', 'cpn', 'c', 'cver', 'srfvp', 'ump', 'alr'];
    const ITAG_AUDIO = {
        '139': '48k AAC', '140': '128k AAC', '141': '256k AAC',
        '249': '50k Opus', '250': '70k Opus', '251': '160k Opus'
    };
    const ITAG_VIDEO = {
        '18': '360p MP4', '22': '720p MP4',
        '160': '144p MP4', '133': '240p MP4', '134': '360p MP4', '135': '480p MP4',
        '136': '720p MP4', '137': '1080p MP4', '264': '1440p MP4', '266': '2160p MP4',
        '298': '720p60 MP4', '299': '1080p60 MP4',
        '242': '240p WebM', '243': '360p WebM', '244': '480p WebM',
        '247': '720p WebM', '248': '1080p WebM'
    };
    const TRUSTED_MESSAGE_ORIGIN_RE = /^https:\/\/([a-z0-9-]+\.)*(drive\.google\.com|youtube\.googleapis\.com|googlevideo\.com)$/i;
    const MAX_STREAMS = 40;
    const MAX_PARALLEL_DOWNLOADS = 6;
    const MAX_FRAGMENTED_FILE_SIZE_MB = 1024;
    const CHUNK_SIZE_BYTES = 10 * 1024 * 1024;
    const CHUNK_RETRIES = 3;
    const CHUNK_TIMEOUT_MS = 30000;
    const CHUNK_RETRY_DELAY_MS = 1000;
    const DEFAULT_TOP_ORIGIN = 'https://drive.google.com';
    const RANGE_NOT_SUPPORTED_ERROR = 'RANGE_NOT_SUPPORTED';
    const REQUEST_FAILED_ERROR = 'REQUEST_FAILED';
    const MESSAGE_TARGET_ORIGIN = resolveTopMessageOrigin();

    let downloadPanel = null;
    let floatingIcon = null;
    let streamListContainer = null;
    let isPanelVisible = false;
    let isButtonEnabled = isTopWindow ? GM_getValue('buttonEnabled', true) : false;
    let detectedStreams = new Map();
    let streamNodesByItag = new Map();

    const debug = (...args) => console.log(`[GDrive Downloader${isTopWindow ? '' : ' - Iframe'}]`, ...args);

    debug('Initializing interception script');

    // Una URL "de medios" es cualquier videoplayback o cualquier host googlevideo.com
    function looksLikeMedia(url) {
        return typeof url === 'string' &&
            (url.includes('videoplayback') || /\/\/[^/]*\.googlevideo\.com\//i.test(url));
    }

    // Detect media requests from PerformanceObserver resource entries.
    function setupNetworkObserver() {
        try {
            const observer = new PerformanceObserver((list) => {
                list.getEntries().forEach(entry => {
                    if (looksLikeMedia(entry.name)) {
                        processUrl(entry.name);
                    }
                });
            });
            observer.observe({ entryTypes: ['resource'] });
            debug('PerformanceObserver enabled');
        } catch (e) {
            debug('Error enabling PerformanceObserver', e);
        }
    }

    setupNetworkObserver();

    // Detect media requests from XHR calls.
    const originalOpen = unsafeWindow.XMLHttpRequest.prototype.open;
    unsafeWindow.XMLHttpRequest.prototype.open = function(method, url) {
        if (looksLikeMedia(url)) {
            processUrl(url);
        }
        return originalOpen.apply(this, arguments);
    };

    // Detect media requests from fetch calls.
    const originalFetch = unsafeWindow.fetch;
    unsafeWindow.fetch = async function(...args) {
        try {
            const request = args[0];
            let url = '';
            if (typeof request === 'string') {
                url = request;
            } else if (request?.url) {
                url = request.url;
            }

            if (looksLikeMedia(url)) {
                processUrl(url);
            }
        } catch (e) {
            debug('Fetch interception error', e);
        }
        return originalFetch.apply(this, args);
    };

    // NUEVO: escanea elementos <video>/<audio> directamente. Algunos reproductores
    // no usan fetch/XHR interceptables, pero exponen la URL en el propio elemento.
    function scanMediaElements() {
        try {
            document.querySelectorAll('video, audio').forEach((el) => {
                const src = el.currentSrc || el.src || '';
                if (looksLikeMedia(src)) processUrl(src);
                if (el.querySelectorAll) {
                    el.querySelectorAll('source').forEach((s) => {
                        if (looksLikeMedia(s.src)) processUrl(s.src);
                    });
                }
            });
        } catch (e) { /* silencioso */ }
    }

    // Revisa periódicamente y cuando cambie el DOM/atributos src.
    setInterval(scanMediaElements, 2000);
    try {
        const mediaObserver = new MutationObserver(scanMediaElements);
        const startObserving = () => {
            if (document.documentElement) {
                mediaObserver.observe(document.documentElement, {
                    childList: true, subtree: true, attributes: true, attributeFilter: ['src']
                });
            }
        };
        if (document.documentElement) startObserving();
        else document.addEventListener('DOMContentLoaded', startObserving);
    } catch (e) { /* silencioso */ }

    function resolveTopMessageOrigin() {
        if (isTopWindow) {
            return window.location.origin;
        }

        const parser = document.createElement('a');
        parser.href = document.referrer || '';
        const referrerOrigin = parser.origin || '';
        if (TRUSTED_MESSAGE_ORIGIN_RE.test(referrerOrigin)) {
            return referrerOrigin;
        }
        return DEFAULT_TOP_ORIGIN;
    }

    function processUrl(rawUrl) {
        if (isTopWindow) {
            handleUrl(rawUrl);
        } else if (window.top) {
            // Forward intercepted URL from iframe to the top window.
            window.top.postMessage({ action: 'GDRIVE_STREAM_DETECTED', url: rawUrl }, MESSAGE_TARGET_ORIGIN);
        }
    }

    function handleUrl(rawUrl) {
        try {
            const urlObj = new URL(rawUrl, window.location.origin);
            const itag = urlObj.searchParams.get('itag');
            const mime = urlObj.searchParams.get('mime');

            if (!itag || !mime) return;

            // Remove fragment/range limiting params to build a reusable direct URL.
            PARAMS_TO_REMOVE.forEach(param => urlObj.searchParams.delete(param));
            const cleanUrl = urlObj.toString();

            if (!detectedStreams.has(itag)) {
                const type = mime.includes('audio') ? 'audio' : 'video';
                const quality = getQualityLabel(itag, type);

                debug(`New stream detected: ${type} - ${quality}`, { itag, cleanUrl });

                detectedStreams.set(itag, { url: cleanUrl, type, quality, timestamp: Date.now() });
                trimDetectedStreams();

                if (document.readyState === 'complete' || document.readyState === 'interactive') {
                    upsertStreamItem(itag, detectedStreams.get(itag));
                }
            }
        } catch (e) {
            debug('URL processing error', e);
        }
    }

    function trimDetectedStreams() {
        while (detectedStreams.size > MAX_STREAMS) {
            let oldestItag = null;
            let oldestTimestamp = Number.POSITIVE_INFINITY;
            detectedStreams.forEach((value, key) => {
                if (value.timestamp < oldestTimestamp) {
                    oldestTimestamp = value.timestamp;
                    oldestItag = key;
                }
            });
            if (!oldestItag) break;
            detectedStreams.delete(oldestItag);
            const oldNode = streamNodesByItag.get(oldestItag);
            if (oldNode) {
                oldNode.remove();
                streamNodesByItag.delete(oldestItag);
            }
        }
    }

    function getQualityLabel(itag, type) {
        if (type === 'audio') {
            return ITAG_AUDIO[itag] || `Audio (${itag})`;
        }

        return ITAG_VIDEO[itag] || `Video (${itag})`;
    }

    function getDriveFilename(type, quality) {
        let name = document.title || "";

        if (!name || name.toLowerCase().includes("google drive")) {
            const titleElement =
                document.querySelector('.docs-title-input') ||
                document.querySelector('[aria-label="File name"]') ||
                document.querySelector('[aria-label="Nombre del archivo"]') ||
                document.querySelector('[aria-label="Nom du fichier"]');
            if (titleElement) {
                name = (titleElement.value || titleElement.textContent || name).trim();
            }
        }

        if (name) {
            name = name.replace(/\s*[-–—|]\s*Google\s+(Drive|Docs|Sheets|Slides).*$/i, '').trim();
            name = name.replace(/\.[a-z0-9]{2,5}$/i, '').trim();
        }

        if (!name || name.toLowerCase() === "google drive") {
            name = `gdrive_${type}_${quality.replaceAll(/\s+/g, '')}`;
        }

        name = name.replaceAll(/[\\/:*?"<>|]/g, '_').trim();

        const ext = type === 'video' ? '.mp4' : '.m4a';
        return name + ext;
    }

    // UI logic (top window only).

    if (isTopWindow) {
        window.addEventListener('message', (event) => {
            if (typeof event.origin !== 'string' || !TRUSTED_MESSAGE_ORIGIN_RE.test(event.origin)) return;
            if (event.source == window) return;
            if (!event.data || typeof event.data !== 'object') return;
            if (event.data.action !== 'GDRIVE_STREAM_DETECTED') return;
            if (typeof event.data.url !== 'string' || !looksLikeMedia(event.data.url)) return;
            handleUrl(event.data.url);
        });

        GM_registerMenuCommand('🔴 Disable Download Button', () => {
            GM_setValue('buttonEnabled', false);
            isButtonEnabled = false;
            hideFloatingIcon();
            debug('Button disabled');
        });

        GM_registerMenuCommand('🟢 Enable Download Button', () => {
            GM_setValue('buttonEnabled', true);
            isButtonEnabled = true;
            showFloatingIcon();
            debug('Button enabled');
        });

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', initialize);
        } else {
            initialize();
        }
    }

    function createStyles() {
        const style = document.createElement('style');
        style.textContent = `
            .gdrive-floating-icon {
                position: fixed !important;
                bottom: 24px !important;
                right: 24px !important;
                z-index: 2147483647 !important;
                width: 55px !important;
                height: 55px !important;
                background: linear-gradient(135deg, #007AFF 0%, #5856D6 100%) !important;
                border: none !important;
                border-radius: 18px !important;
                cursor: pointer !important;
                box-shadow: 0 8px 25px rgba(0, 122, 255, 0.3), 0 3px 10px rgba(0, 0, 0, 0.1) !important;
                display: flex !important;
                align-items: center !important;
                justify-content: center !important;
                color: white !important;
                transition: all 0.4s cubic-bezier(0.25, 0.46, 0.45, 0.94) !important;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif !important;
                backdrop-filter: blur(20px) !important;
                -webkit-backdrop-filter: blur(20px) !important;
                opacity: 0 !important;
                transform: translateY(20px) scale(0.8) !important;
                pointer-events: none !important;
            }
            .gdrive-floating-icon.visible {
                opacity: 1 !important;
                transform: translateY(0) scale(1) !important;
                pointer-events: all !important;
            }
            .gdrive-floating-icon:hover {
                background: linear-gradient(135deg, #0056CC 0%, #4A4AE8 100%) !important;
                box-shadow: 0 12px 35px rgba(0, 122, 255, 0.4), 0 6px 15px rgba(0, 0, 0, 0.15) !important;
                transform: translateY(-3px) scale(1.05) !important;
            }
            .gdrive-floating-icon:active {
                transform: translateY(-1px) scale(0.98) !important;
                transition: all 0.1s ease !important;
            }
            .gdrive-download-icon {
                width: 22px !important;
                height: 22px !important;
                position: relative !important;
                display: flex !important;
                align-items: center !important;
                justify-content: center !important;
            }
            .gdrive-download-icon::before {
                content: '' !important;
                position: absolute !important;
                width: 2px !important;
                height: 12px !important;
                background: white !important;
                border-radius: 1px !important;
                top: 2px !important;
            }
            .gdrive-download-icon::after {
                content: '' !important;
                position: absolute !important;
                width: 7px !important;
                height: 7px !important;
                border-right: 2px solid white !important;
                border-bottom: 2px solid white !important;
                transform: rotate(45deg) !important;
                bottom: 5px !important;
                border-radius: 0 1px 0 0 !important;
            }
            .gdrive-popup-panel {
                position: fixed !important;
                bottom: 90px !important;
                right: 24px !important;
                z-index: 2147483646 !important;
                width: 400px !important;
                background: rgba(255, 255, 255, 0.95) !important;
                backdrop-filter: blur(20px) !important;
                -webkit-backdrop-filter: blur(20px) !important;
                border: 1px solid rgba(255, 255, 255, 0.2) !important;
                border-radius: 20px !important;
                box-shadow: 0 20px 60px rgba(0, 0, 0, 0.15), 0 8px 25px rgba(0, 0, 0, 0.1) !important;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif !important;
                overflow: hidden !important;
                opacity: 0 !important;
                transform: translateY(30px) scale(0.9) !important;
                transition: all 0.4s cubic-bezier(0.25, 0.46, 0.45, 0.94) !important;
                pointer-events: none !important;
            }
            .gdrive-popup-panel.visible {
                opacity: 1 !important;
                transform: translateY(0) scale(1) !important;
                pointer-events: all !important;
            }
            .gdrive-panel-header {
                background: rgba(248, 249, 250, 0.8) !important;
                backdrop-filter: blur(20px) !important;
                border-bottom: 1px solid rgba(0, 0, 0, 0.05) !important;
                padding: 12px 24px !important;
                display: flex !important;
                align-items: center !important;
                justify-content: space-between !important;
            }
            .gdrive-panel-title {
                font-size: 17px !important;
                font-weight: 600 !important;
                color: #1d1d1f !important;
                margin: 0 !important;
                display: flex !important;
                align-items: center !important;
                gap: 10px !important;
                letter-spacing: -0.022em !important;
            }
            .gdrive-close-btn {
                background: rgba(120, 120, 128, 0.12) !important;
                border: none !important;
                cursor: pointer !important;
                border-radius: 50% !important;
                color: #8e8e93 !important;
                font-size: 16px !important;
                transition: all 0.2s ease !important;
                width: 30px !important;
                height: 30px !important;
                display: flex !important;
                align-items: center !important;
                justify-content: center !important;
                font-weight: 500 !important;
            }
            .gdrive-close-btn:hover {
                background: rgba(120, 120, 128, 0.2) !important;
                color: #48484a !important;
            }
            .gdrive-panel-content {
                padding: 24px !important;
                max-height: 400px !important;
                overflow-y: auto !important;
            }
            .gdrive-input-label {
                font-size: 15px !important;
                font-weight: 600 !important;
                color: #1d1d1f !important;
                margin-bottom: 6px !important;
                display: block !important;
                letter-spacing: -0.024em !important;
            }
            .gdrive-instruction-text {
                font-size: 13px !important;
                color: #5f6368 !important;
                margin-bottom: 16px !important;
                line-height: 1.4 !important;
            }
            .gdrive-detection-result {
                padding: 12px 16px !important;
                border-radius: 12px !important;
                font-size: 14px !important;
                font-weight: 500 !important;
                margin-bottom: 8px !important;
                letter-spacing: -0.022em !important;
                transition: all 0.2s ease !important;
            }
            .gdrive-detection-result.video {
                background: rgba(52, 199, 89, 0.1) !important;
                color: #248a3d !important;
                border: 1px solid rgba(52, 199, 89, 0.2) !important;
            }
            .gdrive-detection-result.audio {
                background: rgba(255, 69, 58, 0.1) !important;
                color: #d12e26 !important;
                border: 1px solid rgba(255, 69, 58, 0.2) !important;
            }
            .gdrive-detection-result.empty {
                background: rgba(120, 120, 128, 0.08) !important;
                color: #8e8e93 !important;
                border: 1px solid rgba(120, 120, 128, 0.12) !important;
                text-align: center !important;
                display: flex !important;
                justify-content: center !important;
                gap: 8px !important;
            }
            .gdrive-btn-primary {
                background: linear-gradient(135deg, #007AFF 0%, #5856D6 100%) !important;
                color: #ffffff !important;
                border: none !important;
                border-radius: 8px !important;
                cursor: pointer !important;
                font-weight: 600 !important;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif !important;
                transition: all 0.2s ease !important;
                box-shadow: 0 2px 8px rgba(0, 122, 255, 0.25) !important;
                min-width: 100px !important;
            }
            .gdrive-btn-primary:hover:not(:disabled) {
                background: linear-gradient(135deg, #0056CC 0%, #4A4AE8 100%) !important;
                box-shadow: 0 4px 12px rgba(0, 122, 255, 0.35) !important;
                transform: translateY(-1px) !important;
            }
            .gdrive-btn-primary:disabled {
                opacity: 0.7 !important;
                cursor: not-allowed !important;
                box-shadow: none !important;
            }
            @keyframes apple-pulse {
                0% { box-shadow: 0 8px 25px rgba(0, 122, 255, 0.3), 0 0 0 0 rgba(0, 122, 255, 0.7); }
                70% { box-shadow: 0 8px 25px rgba(0, 122, 255, 0.3), 0 0 0 15px rgba(0, 122, 255, 0); }
                100% { box-shadow: 0 8px 25px rgba(0, 122, 255, 0.3), 0 0 0 0 rgba(0, 122, 255, 0); }
            }
            .gdrive-floating-icon.pulse { animation: apple-pulse 2.5s infinite !important; }
            @media (max-width: 480px) {
                .gdrive-popup-panel { width: calc(100vw - 48px) !important; right: 24px !important; }
            }
            @media (prefers-color-scheme: dark) {
                .gdrive-popup-panel { background: rgba(28, 28, 30, 0.95) !important; border: 1px solid rgba(255, 255, 255, 0.1) !important; }
                .gdrive-panel-header { background: rgba(44, 44, 46, 0.8) !important; border-bottom: 1px solid rgba(255, 255, 255, 0.05) !important; }
                .gdrive-panel-title, .gdrive-input-label { color: #f2f2f7 !important; }
                .gdrive-detection-result.video { color: #30d158 !important; }
                .gdrive-detection-result.audio { color: #ff453a !important; }
            }
        `;
        document.head.appendChild(style);
    }

    function showFloatingIcon() {
        if (floatingIcon && isButtonEnabled) {
            floatingIcon.classList.add('visible');
            setTimeout(() => {
                if (isButtonEnabled) floatingIcon.classList.add('pulse');
            }, 1000);
        }
    }

    function hideFloatingIcon() {
        if (floatingIcon) {
            floatingIcon.classList.remove('visible', 'pulse');
            if (isPanelVisible) closePanel();
        }
    }

    function createFloatingIcon() {
        floatingIcon = document.createElement('button');
        floatingIcon.className = 'gdrive-floating-icon';
        floatingIcon.innerHTML = '<div class="gdrive-download-icon"></div>';
        floatingIcon.title = 'Google Drive Auto Downloader';
        floatingIcon.onclick = togglePanel;
        document.body.appendChild(floatingIcon);

        if (isButtonEnabled) showFloatingIcon();
    }

    function createPopupPanel() {
        downloadPanel = document.createElement('div');
        downloadPanel.className = 'gdrive-popup-panel';
        downloadPanel.innerHTML = `
            <div class="gdrive-panel-header">
                <h3 class="gdrive-panel-title">
                    <div class="gdrive-download-icon" style="transform: scale(0.8);"></div>
                    GDrive Downloader
                </h3>
                <button class="gdrive-close-btn" id="gdrive-close-btn">×</button>
            </div>
            <div class="gdrive-panel-content">
                <label class="gdrive-input-label">Detected streams</label>
                <div class="gdrive-instruction-text">
                    Reproduce el video y CAMBIA la calidad (⚙️ → 720p/480p) para forzar la detección. Descarga directa optimizada.
                </div>
                <div id="gdrive-stream-list">
                    <div class="gdrive-detection-result empty">
                        <span>⏳</span>
                        <span>Cambia la calidad del video...</span>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(downloadPanel);
        document.getElementById('gdrive-close-btn').onclick = closePanel;
    }

    function compareStreams(a, b) {
        if (a.type !== b.type) return a.type === 'video' ? -1 : 1;
        return b.timestamp - a.timestamp;
    }

    function createStreamItem(itag, data) {
        const item = document.createElement('div');
        item.className = `gdrive-detection-result ${data.type}`;
        item.dataset.itag = itag;
        item.dataset.type = data.type;
        item.dataset.timestamp = String(data.timestamp);
        item.style.display = 'flex';
        item.style.justifyContent = 'space-between';
        item.style.alignItems = 'center';

        const info = document.createElement('div');
        info.style.display = 'flex';
        info.style.alignItems = 'center';
        info.style.gap = '8px';

        const icon = document.createElement('span');
        icon.textContent = data.type === 'video' ? '🎥' : '🔊';
        const quality = document.createElement('span');
        quality.textContent = data.quality;
        info.appendChild(icon);
        info.appendChild(quality);

        const btn = document.createElement('button');
        btn.className = 'gdrive-btn-primary';
        btn.style.padding = '6px 14px';
        btn.style.fontSize = '12px';
        btn.textContent = 'Download';
        btn.onclick = (e) => {
            e.preventDefault();
            const filename = getDriveFilename(data.type, data.quality);
            downloadFile(data.url, filename, btn);
        };

        item.appendChild(info);
        item.appendChild(btn);
        return item;
    }

    function insertStreamNodeSorted(node, data) {
        if (!streamListContainer) return;
        const currentNodes = Array.from(streamListContainer.children).filter((child) => child !== node);
        let inserted = false;
        for (const child of currentNodes) {
            const childData = {
                type: child.dataset.type,
                timestamp: Number(child.dataset.timestamp || 0)
            };
            if (compareStreams(data, childData) < 0) {
                child.before(node);
                inserted = true;
                break;
            }
        }
        if (!inserted) streamListContainer.appendChild(node);
    }

    function upsertStreamItem(itag, data) {
        streamListContainer = streamListContainer || document.getElementById('gdrive-stream-list');
        if (!streamListContainer || !data) return;
        const emptyNode = streamListContainer.querySelector('.gdrive-detection-result.empty');
        if (emptyNode) emptyNode.remove();

        if (floatingIcon && isButtonEnabled && !floatingIcon.classList.contains('visible')) {
            showFloatingIcon();
        }

        if (floatingIcon && !isPanelVisible) {
            floatingIcon.classList.remove('pulse');
            floatingIcon.getBoundingClientRect();
            floatingIcon.classList.add('pulse');
        }

        const existingNode = streamNodesByItag.get(itag);
        const node = existingNode || createStreamItem(itag, data);
        node.dataset.type = data.type;
        node.dataset.timestamp = String(data.timestamp);
        insertStreamNodeSorted(node, data);
        streamNodesByItag.set(itag, node);
    }

    function updateUI() {
        streamListContainer = streamListContainer || document.getElementById('gdrive-stream-list');
        if (!streamListContainer) return;

        if (detectedStreams.size === 0) return;

        const sortedStreams = Array.from(detectedStreams.entries()).sort((a, b) => compareStreams(a[1], b[1]));
        sortedStreams.forEach(([itag, data]) => upsertStreamItem(itag, data));
    }

    function wait(ms) {
        return new Promise((resolve) => {
            setTimeout(resolve, ms);
        });
    }

    function parseContentLength(headers) {
        const sizeMatch = headers.match(/content-length:\s*(\d+)/i);
        return sizeMatch ? Number.parseInt(sizeMatch[1], 10) : 0;
    }

    function createChunkRanges(totalSize) {
        const ranges = [];
        for (let i = 0; i < totalSize; i += CHUNK_SIZE_BYTES) {
            ranges.push({
                start: i,
                end: Math.min(i + CHUNK_SIZE_BYTES - 1, totalSize - 1),
                index: ranges.length
            });
        }
        return ranges;
    }

    function hasValidContentRange(headers) {
        return /content-range:\s*bytes\s+\d+-\d+\/\d+/i.test(headers);
    }

    function requestHead(url) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'HEAD',
                url: url,
                onload: resolve,
                onerror: () => reject(new Error(REQUEST_FAILED_ERROR))
            });
        });
    }

    function requestChunk(url, range) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: url,
                headers: { 'Range': `bytes=${range.start}-${range.end}` },
                responseType: 'arraybuffer',
                timeout: CHUNK_TIMEOUT_MS,
                onload: resolve,
                onerror: () => reject(new Error('Erreur réseau')),
                ontimeout: () => reject(new Error('Timeout réseau'))
            });
        });
    }

    async function requestChunkWithRetry(url, range) {
        for (let attempt = 0; attempt <= CHUNK_RETRIES; attempt += 1) {
            try {
                const response = await requestChunk(url, range);
                if (response.status === 200) {
                    throw new Error(RANGE_NOT_SUPPORTED_ERROR);
                }
                if (response.status !== 206 || !hasValidContentRange(response.responseHeaders)) {
                    throw new Error(`Erreur HTTP ${response.status}`);
                }
                return response;
            } catch (error) {
                if (error?.message === RANGE_NOT_SUPPORTED_ERROR) throw error;
                if (attempt >= CHUNK_RETRIES) throw error;
                await wait(CHUNK_RETRY_DELAY_MS);
            }
        }
        throw new Error('Échec téléchargement segment');
    }

    async function runWithConcurrency(items, maxParallel, worker) {
        let cursor = 0;
        const workerCount = Math.min(maxParallel, items.length);
        const workers = [];
        const consumeQueue = async () => {
            while (cursor < items.length) {
                const current = items[cursor];
                cursor += 1;
                await worker(current);
            }
        };

        for (let i = 0; i < workerCount; i += 1) {
            workers.push(consumeQueue());
        }
        await Promise.all(workers);
    }

    async function downloadChunks(url, totalSize, btnElement) {
        const ranges = createChunkRanges(totalSize);
        const chunks = new Array(ranges.length);
        let downloadedSize = 0;

        await runWithConcurrency(ranges, MAX_PARALLEL_DOWNLOADS, async (range) => {
            const response = await requestChunkWithRetry(url, range);
            chunks[range.index] = response.response;
            downloadedSize += response.response.byteLength;
            const percent = Math.floor((downloadedSize / totalSize) * 100);
            btnElement.textContent = `${percent}%`;
        });

        return chunks;
    }

    function downloadBlob(chunks, filename) {
        const blob = new Blob(chunks, { type: 'application/octet-stream' });
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);
    }

    async function downloadFile(url, filename, btnElement) {
        const originalText = btnElement.textContent || 'Download';
        btnElement.textContent = '0%';
        btnElement.disabled = true;

        try {
            const headResponse = await requestHead(url);
            const totalSize = parseContentLength(headResponse.responseHeaders);
            const maxFragmentedSizeBytes = MAX_FRAGMENTED_FILE_SIZE_MB * 1024 * 1024;

            if (totalSize === 0) {
                startStandardDownload(url, filename, btnElement, originalText);
                return;
            }

            if (totalSize > maxFragmentedSizeBytes) {
                debug('File too large for chunked mode, falling back to standard download', { totalSize });
                startStandardDownload(url, filename, btnElement, originalText);
                return;
            }

            const chunks = await downloadChunks(url, totalSize, btnElement);
            btnElement.textContent = 'Merging...';
            downloadBlob(chunks, filename);
            btnElement.textContent = 'Done';
            setTimeout(() => {
                btnElement.textContent = originalText;
                btnElement.disabled = false;
            }, 2000);
        } catch (error) {
            if (error?.message === RANGE_NOT_SUPPORTED_ERROR) {
                debug('Server does not support Range (206), falling back to standard download');
            } else {
                debug('Chunked mode failed, falling back to standard download', error);
            }
            startStandardDownload(url, filename, btnElement, originalText);
        }
}

    function startStandardDownload(url, filename, btnElement, originalText) {
        btnElement.textContent = '0%';
        GM_download({
            url: url,
            name: filename,
            onload: () => {
                btnElement.textContent = 'Done';
                setTimeout(() => {
                    btnElement.textContent = originalText;
                    btnElement.disabled = false;
                }, 2000);
            },
            onprogress: (info) => {
                if (info.lengthComputable && info.total > 0) {
                    const percent = Math.floor((info.loaded / info.total) * 100);
                    btnElement.textContent = `${percent}%`;
                }
            },
            onerror: (err) => {
                debug('GM_download error', err);
                fallbackDownload(url, filename);
                btnElement.textContent = originalText;
                btnElement.disabled = false;
            },
            ontimeout: () => {
                debug('GM_download timeout');
                fallbackDownload(url, filename);
                btnElement.textContent = originalText;
                btnElement.disabled = false;
            }
        });
    }

    function fallbackDownload(url, filename) {
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
    }

    function togglePanel() {
        isPanelVisible = !isPanelVisible;
        if (isPanelVisible) {
            downloadPanel.classList.add('visible');
            floatingIcon.classList.remove('pulse');
        } else {
            downloadPanel.classList.remove('visible');
        }
    }

    function closePanel() {
        isPanelVisible = false;
        downloadPanel.classList.remove('visible');
    }

    function handleOutsideClick(event) {
        if (isPanelVisible && !downloadPanel.contains(event.target) && !floatingIcon.contains(event.target)) {
            closePanel();
        }
    }

    function initialize() {
        debug('Creating main UI');
        createStyles();
        createFloatingIcon();
        createPopupPanel();
        updateUI();
        document.addEventListener('click', handleOutsideClick);
    }
})();