// ==UserScript==
// @name         Enhanced Google Drive PDF Downloader
// @namespace    GoogleDrivePDFDownloader
// @version      8
// @description  Download protected PDF files from Google Drive — v8: CSP/Trusted-Types safe (no innerHTML) + fixed filename detection for the new Drive viewer.
// @author       akvabhi (improved by Claude)
// @match        https://drive.google.com/*
// @grant        none
// @homepage     https://github.com/Akv2021/Enhanced-Google-Drive-PDF-Downloader
// @license      MIT
// @downloadURL https://update.greasyfork.org/scripts/538272/Enhanced%20Google%20Drive%20PDF%20Downloader.user.js
// @updateURL https://update.greasyfork.org/scripts/538272/Enhanced%20Google%20Drive%20PDF%20Downloader.meta.js
// ==/UserScript==

(function () {
    'use strict';

    const COLORS = { fast: '#2ecc71', slow: '#e74c3c', hover: '#3367d6', default: '#4285f4' };

    const log = (msg, type = 'info') => {
        const t = new Date().toLocaleTimeString();
        (type === 'error' ? console.error : console.log)(`[PDF Downloader ${t}] ${msg}`);
    };
    const delay = ms => new Promise(r => setTimeout(r, ms));

    window.pdfQualityMode = 'FAST';

    // ─────────────────────────────────────────────
    // PROGRESS INDICATOR
    // ─────────────────────────────────────────────
    const progressIndicator = {
        element: null,
        create() {
            const el = document.createElement('div');
            el.style.cssText = `position:fixed;top:65px;right:20px;z-index:9999;padding:8px 16px;background:#4285f4;color:#fff;border-radius:4px;font-family:Arial,sans-serif;font-size:14px;box-shadow:0 2px 5px rgba(0,0,0,.2);min-height:20px;display:none;align-items:center;transition:all .3s ease;`;
            document.body.appendChild(el);
            this.element = el;
        },
        show(message) {
            if (!this.element) this.create();
            this.element.style.display = 'flex';
            this.element.textContent = message;
            this.element.style.opacity = '1';
            const c = document.querySelector('#pdfDownloadContainer');
            if (c) c.style.display = 'none';
        },
        hide() {
            if (!this.element) return;
            this.element.style.opacity = '0';
            setTimeout(() => {
                this.element.style.display = 'none';
                const c = document.querySelector('#pdfDownloadContainer');
                if (c) { c.style.display = 'flex'; c.style.opacity = '1'; }
            }, 300);
        }
    };

    // ─────────────────────────────────────────────
    // DOM HELPERS
    // ─────────────────────────────────────────────

    function blobImages(root) {
        return Array.from((root || document).getElementsByTagName('img')).filter(img =>
            img.src && img.src.startsWith('blob:') &&
            img.naturalWidth > 0 && img.naturalHeight > 0
        );
    }

    function absoluteTop(el) {
        let top = 0, e = el;
        while (e) { top += e.offsetTop || 0; e = e.offsetParent; }
        return top;
    }

    function getScrollContainer() {
        const imgs = blobImages(document);
        if (!imgs.length) return document.scrollingElement || document.documentElement;
        const anchor = imgs.reduce((a, b) => (a.naturalHeight >= b.naturalHeight ? a : b));
        let el = anchor.parentElement;
        let best = null;
        while (el && el !== document.body) {
            if (el.scrollHeight > el.clientHeight + 40) {
                const oy = getComputedStyle(el).overflowY;
                if (oy === 'auto' || oy === 'scroll' || oy === 'overlay') best = el;
            }
            el = el.parentElement;
        }
        return best || document.scrollingElement || document.documentElement;
    }

    function pageImagesIn(container) {
        const imgs = blobImages(container);
        if (!imgs.length) return [];
        const maxH = Math.max(...imgs.map(i => i.naturalHeight));
        return imgs.filter(i => i.naturalHeight >= maxH * 0.5 && i.naturalHeight > 150);
    }

    async function waitImagesReady(container, maxWait = 1600) {
        const start = performance.now();
        while (performance.now() - start < maxWait) {
            await delay(70);
            const imgs = pageImagesIn(container);
            if (imgs.length && imgs.every(i => i.complete && i.naturalWidth > 0)) {
                await delay(50);
                return;
            }
        }
    }

    /**
     * Lee el TOTAL de páginas del visor (ej. "Página 15 de 16" o "13 / 14").
     * Busca un input con número (la página actual) y en su texto cercano
     * el patrón "de N" o "/ N". Devuelve null si no lo encuentra.
     */
    function getTotalPages() {
        const inputs = document.querySelectorAll('input');
        for (const inp of inputs) {
            const v = (inp.value || '').trim();
            if (!/^\d+$/.test(v)) continue;
            let node = inp;
            for (let up = 0; up < 4 && node; up++) {
                node = node.parentElement;
                if (!node) break;
                const txt = (node.textContent || '').replace(/\s+/g, ' ').trim();
                const m = txt.match(/(?:\bde\b|\/)\s*(\d{1,4})/i);
                if (m) {
                    const n = parseInt(m[1], 10);
                    if (n > 0 && n < 5000) return n;
                }
            }
        }
        return null;
    }

    // ─────────────────────────────────────────────
    // NOMBRE DEL ARCHIVO
    // ─────────────────────────────────────────────

    function ensurePdfExt(name) {
        const clean = (name || '').trim().replace(/[\\/:*?"<>|]+/g, '_');
        if (!clean) return 'documento.pdf';
        return /\.pdf$/i.test(clean) ? clean : `${clean}.pdf`;
    }

    // Textos de la interfaz de Drive que NUNCA son el nombre del archivo.
    function isJunkName(txt) {
        return /^(archivo|ver|herramientas|ayuda|compartir|p[áa]gina|de|buscar|abrir con|descargar|download|share|file|edit|view|help|tools|google drive|mi unidad|p[áa]gina principal|proyectos|computadoras|compartidos conmigo|recientes|destacados|spam|papelera|almacenamiento|obtener m[áa]s|preguntarle a gemini|transcripci[óo]n)$/i.test(txt.trim());
    }

    /**
     * v8: detecta el nombre del PDF SIN exigir que termine en ".pdf".
     * El visor de Drive muestra el nombre sin extensión (ej. "Nuevo Taller N3 -
     * Biología Macro CAL A 2026"), por eso el detector anterior fallaba y caía
     * al título de la pestaña (que es el nombre de la CARPETA, no del archivo).
     */
    function detectFileName() {
        // 1) Meta oficial de Drive (la más fiable cuando existe).
        const meta = document.querySelector('meta[itemprop="name"]')?.content;
        if (meta && meta.trim() && !isJunkName(meta)) return ensurePdfExt(meta);

        // 2) Ancla "Mostrando <nombre>" / "Showing <name>": identifica el archivo ACTIVO.
        for (const el of document.querySelectorAll('div, span')) {
            if (el.children.length !== 0) continue; // solo nodos de texto hoja
            const txt = (el.textContent || '').trim();
            const m = txt.match(/^(?:Mostrando|Showing|Affichage de)\s+(.+)$/i);
            if (m && m[1]) {
                const name = m[1].trim();
                if (name && name.length < 200 && !isJunkName(name)) return ensurePdfExt(name);
            }
        }

        // 3) Cualquier texto que SÍ traiga extensión .pdf (caso del visor clásico).
        for (const el of document.querySelectorAll('span, div, h1, h2, [role="heading"], [aria-label]')) {
            const aria = el.getAttribute && el.getAttribute('aria-label');
            const txt = (aria || el.textContent || '').trim();
            if (txt && txt.length < 200 && !txt.includes('\n') && /\.pdf$/i.test(txt)) {
                return ensurePdfExt(txt);
            }
        }

        // 4) Encabezado del visor: texto VISIBLE en la franja superior de la pantalla,
        //    con fuente grande, que no sea parte del menú ni de la barra lateral.
        //    Aquí es donde vive "Nuevo Taller N3 - Biología Macro CAL A 2026".
        const candidates = [];
        for (const el of document.querySelectorAll('div, span, h1, h2, [role="heading"]')) {
            if (el.children.length !== 0) continue;
            const txt = (el.textContent || '').trim();
            if (!txt || txt.length < 3 || txt.length > 200 || txt.includes('\n')) continue;
            if (isJunkName(txt)) continue;
            if (!/[A-Za-z0-9]/.test(txt)) continue;
            const rect = el.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) continue; // invisible
            if (rect.top > 160) continue;                      // fuera del encabezado
            if (rect.left > window.innerWidth * 0.6) continue;  // el nombre va a la izquierda
            const size = parseFloat(getComputedStyle(el).fontSize) || 0;
            candidates.push({ txt, size, top: rect.top });
        }
        if (candidates.length) {
            // El nombre del archivo es el texto más grande del encabezado.
            candidates.sort((a, b) => b.size - a.size || a.top - b.top);
            return ensurePdfExt(candidates[0].txt);
        }

        // 5) Respaldo: título de la pestaña sin el sufijo de Google.
        const title = document.title.replace(/\s*[-–|]\s*Google Drive\s*$/i, '').trim();
        if (title && !isJunkName(title)) return ensurePdfExt(title);

        return 'documento.pdf';
    }

    // ─────────────────────────────────────────────
    // CAPTURA INCREMENTAL
    // ─────────────────────────────────────────────

    const captured = new Map(); // blobURL -> { top, data, format, w, h }

    // Nº de páginas ÚNICAS por posición (evita contar de más si un blob se recrea)
    function uniquePageCount() {
        const set = new Set();
        for (const p of captured.values()) set.add(Math.round(p.top / 10));
        return set.size;
    }

    async function captureVisiblePages(container) {
        const imgs = pageImagesIn(container);
        for (const img of imgs) {
            if (captured.has(img.src)) continue;
            try { if (img.decode) await img.decode(); } catch (e) {}
            const canvas = document.createElement('canvas');
            canvas.width = img.naturalWidth;
            canvas.height = img.naturalHeight;
            canvas.getContext('2d').drawImage(img, 0, 0);
            const fast = window.pdfQualityMode === 'FAST';
            const data = fast ? canvas.toDataURL('image/jpeg', 0.92) : canvas.toDataURL('image/png', 1.0);
            captured.set(img.src, {
                top: absoluteTop(img),
                data,
                format: fast ? 'JPEG' : 'PNG',
                w: img.naturalWidth,
                h: img.naturalHeight
            });
        }
    }

    /**
     * Espera paciente a que APAREZCAN páginas nuevas (no solo que carguen las
     * ya presentes). Sirve para la cola: fuerza a que Drive renderice las
     * últimas páginas. Captura conforme aparecen.
     */
    async function waitForMorePages(container, baseline, maxWait = 3200) {
        const start = performance.now();
        while (performance.now() - start < maxWait) {
            await delay(110);
            await captureVisiblePages(container);
            if (uniquePageCount() > baseline) return true;
        }
        return false;
    }

    /**
     * Verificación de la cola. Solo hace trabajo extra si faltan páginas.
     * Estrategia: si no llegamos al total, subimos un poco y bajamos de golpe
     * al fondo (esto obliga a Drive a re-renderizar las últimas páginas),
     * y esperamos con paciencia a que aparezcan.
     */
    async function ensureAllCaptured(container, vh, total) {
        const maxAttempts = total ? 10 : 3;
        let attempts = 0;

        while (attempts < maxAttempts) {
            const have = uniquePageCount();
            if (total && have >= total) break;
            attempts++;

            // "Empujón": subir ~1.5 pantallas y volver al fondo real
            const nudgeTo = Math.max(0, container.scrollHeight - Math.floor(vh * 1.5));
            container.scrollTo({ top: nudgeTo, behavior: 'instant' });
            await delay(150);
            await captureVisiblePages(container);

            container.scrollTo({ top: container.scrollHeight, behavior: 'instant' });
            const grew = await waitForMorePages(container, have);

            progressIndicator.show(total
                ? `🔎 Verificando cola... (${uniquePageCount()}/${total})`
                : `🔎 Verificando cola... (${uniquePageCount()})`);

            // Si no aparecieron nuevas y (no hay total o ya lo alcanzamos) → terminamos
            if (!grew) {
                if (!total || uniquePageCount() >= total) break;
                // hay total y aún faltan pero no creció: un intento más con pausa
                await delay(400);
            }
        }
    }

    async function scrollAndCaptureAll() {
        captured.clear();
        const container = getScrollContainer();
        const vh = container.clientHeight || window.innerHeight;
        const total = getTotalPages();
        log(`Contenedor: visible ${vh}px, total ${container.scrollHeight}px. Páginas esperadas: ${total ?? '?'}`);

        const label = () => total ? `(${uniquePageCount()}/${total})` : `(${captured.size})`;

        // Inicio
        container.scrollTo({ top: 0, behavior: 'instant' });
        await waitImagesReady(container);
        await captureVisiblePages(container);
        progressIndicator.show(`📸 Capturando páginas... ${label()}`);

        const STEP = Math.max(200, Math.floor(vh * 0.75));
        let pos = 0, bottomHits = 0, guard = 0;

        while (guard++ < 500) {
            pos += STEP;
            const before = container.scrollTop;
            container.scrollTo({ top: pos, behavior: 'instant' });
            await delay(30);
            if (Math.abs(container.scrollTop - before) < 2 && pos < container.scrollHeight) {
                window.scrollTo({ top: pos, behavior: 'instant' });
                await delay(30);
            }
            await waitImagesReady(container);
            await captureVisiblePages(container);
            progressIndicator.show(`📸 Capturando páginas... ${label()}`);

            // Si ya tenemos todas las esperadas, no seguimos scrolleando de gusto
            if (total && uniquePageCount() >= total) break;

            if (container.scrollTop + vh >= container.scrollHeight - 4) {
                bottomHits++;
                if (bottomHits >= 2) break;
            } else bottomHits = 0;
        }

        // COMPROBACIÓN: solo trabaja si faltan páginas
        await ensureAllCaptured(container, vh, total);

        container.scrollTo({ top: 0, behavior: 'instant' });

        const finalUnique = uniquePageCount();
        log(`Captura terminada: ${finalUnique} páginas únicas (esperadas: ${total ?? '?'}).`);
        return { count: finalUnique, total };
    }

    // ─────────────────────────────────────────────
    // JSPDF
    // ─────────────────────────────────────────────

    async function loadJsPDF() {
        if (window.jspdf) return;
        return new Promise((resolve, reject) => {
            progressIndicator.show('Cargando librería PDF...');
            const script = document.createElement('script');
            const url = 'https://unpkg.com/jspdf@latest/dist/jspdf.umd.min.js';
            if (window.trustedTypes && trustedTypes.createPolicy) {
                const policy = trustedTypes.createPolicy('pdfDownloaderPolicy', { createScriptURL: i => i });
                script.src = policy.createScriptURL(url);
            } else {
                script.src = url;
            }
            script.onload = () => { log('jsPDF cargado.'); resolve(); };
            script.onerror = e => { log('Error cargando jsPDF', 'error'); reject(e); };
            document.body.appendChild(script);
        });
    }

    async function buildPDF() {
        const { jsPDF } = window.jspdf;

        let pages = [...captured.values()].sort((a, b) => a.top - b.top);
        const deduped = [];
        for (const p of pages) {
            const prev = deduped[deduped.length - 1];
            if (prev && Math.abs(prev.top - p.top) < 6) continue;
            deduped.push(p);
        }
        pages = deduped;
        log(`Construyendo PDF: ${pages.length} páginas (tras dedup).`);

        const PORTRAIT_W = 210;   // mm
        const LANDSCAPE_W = 297;  // mm

        let pdf = null;
        for (let i = 0; i < pages.length; i++) {
            const p = pages[i];
            const aspect = p.w / p.h;
            const orientation = aspect > 1 ? 'l' : 'p';
            const pageW = orientation === 'l' ? LANDSCAPE_W : PORTRAIT_W;
            const pageH = pageW / aspect;

            if (!pdf) {
                pdf = new jsPDF({ orientation, unit: 'mm', format: [pageW, pageH] });
            } else {
                pdf.addPage([pageW, pageH], orientation);
            }
            pdf.addImage(p.data, p.format, 0, 0, pageW, pageH, undefined, window.pdfQualityMode);
            progressIndicator.show(`📄 Armando PDF: ${i + 1}/${pages.length}`);
            if (i % 5 === 0) await delay(0);
        }
        return { pdf, count: pages.length };
    }

    // ─────────────────────────────────────────────
    // FLUJO PRINCIPAL
    // ─────────────────────────────────────────────

    async function downloadPDF() {
        const button = document.querySelector('#pdfDownloadButton');
        const t0 = performance.now();
        try {
            button.disabled = true;
            button.textContent = '⏳ Procesando...';

            const { count: found, total } = await scrollAndCaptureAll();
            if (found === 0) throw new Error('No se detectaron páginas. Abre el PDF en el visor de Drive y reintenta.');

            await loadJsPDF();

            progressIndicator.show(`📄 Generando PDF (${found} páginas)...`);
            const { pdf, count } = await buildPDF();
            if (count === 0) throw new Error('No se pudieron procesar las páginas capturadas.');

            const fileName = detectFileName();
            progressIndicator.show(`💾 Guardando ${fileName}...`);
            await pdf.save(fileName, { returnPromise: true });

            const secs = ((performance.now() - t0) / 1000).toFixed(1);
            log(`Listo: "${fileName}", ${count}/${total ?? '?'} páginas, ${secs}s.`);

            // Aviso claro si por alguna razón no se alcanzó el total
            if (total && count < total) {
                progressIndicator.show(`⚠️ ${count}/${total} páginas (faltaron algunas) · ${secs}s`);
            } else {
                progressIndicator.show(`✅ ${fileName} · ${count} páginas · ${secs}s`);
            }

            button.disabled = false;
            button.textContent = window.pdfQualityMode === 'SLOW' ? 'Download PDF (Best Quality)' : 'Download PDF (Fast)';
            setTimeout(() => progressIndicator.hide(), 6000);

        } catch (error) {
            log(`Error: ${error.message}`, 'error');
            progressIndicator.show(`❌ ${error.message}`);
            button.disabled = false;
            button.textContent = window.pdfQualityMode === 'SLOW' ? 'Download PDF (Best Quality)' : 'Download PDF (Fast)';
            alert(`Error al generar PDF: ${error.message}`);
        }
    }

    // ─────────────────────────────────────────────
    // UI
    // ─────────────────────────────────────────────

    function updateDownloadButtonText(hq) {
        const b = document.querySelector('#pdfDownloadButton');
        if (!b) return;
        const txt = hq ? 'Download PDF (Best Quality)' : 'Download PDF (Fast)';
        b.style.opacity = '0';
        setTimeout(() => { b.textContent = txt; b.style.opacity = '1'; }, 150);
    }

    function createToggleSwitch() {
        const wrap = document.createElement('div');
        wrap.style.cssText = `display:flex;flex-direction:column;align-items:center;margin:12px 0;width:100%;`;
        const label = document.createElement('div');
        label.textContent = 'Modo de calidad:';
        label.style.marginBottom = '8px';
        const ctrl = document.createElement('div');
        ctrl.style.cssText = `display:flex;flex-direction:column;align-items:center;width:100%;`;
        const sw = document.createElement('label');
        sw.style.cssText = `position:relative;display:inline-block;width:46px;height:24px;`;
        const input = document.createElement('input');
        input.type = 'checkbox'; input.checked = false;
        input.style.cssText = `opacity:0;width:0;height:0;`;
        const slider = document.createElement('span');
        slider.style.cssText = `position:absolute;cursor:pointer;top:0;left:0;right:0;bottom:0;background:${COLORS.fast};transition:.4s;border-radius:24px;`;
        const ball = document.createElement('span');
        ball.style.cssText = `position:absolute;height:18px;width:18px;left:3px;bottom:3px;background:#fff;transition:.4s;border-radius:50%;transform:translateX(0);`;
        const labels = document.createElement('div');
        labels.style.cssText = `display:flex;justify-content:space-between;width:200px;margin-top:8px;font-size:12px;color:#888;`;
        const low = document.createElement('span');
        low.textContent = 'Baja (Rápida)'; low.style.cssText = `transition:color .3s ease;color:#4285f4;`;
        const high = document.createElement('span');
        high.textContent = 'Alta (Lenta)'; high.style.cssText = `transition:color .3s ease;color:#888;`;
        input.addEventListener('change', e => {
            const hq = e.target.checked;
            ball.style.transform = hq ? 'translateX(22px)' : 'translateX(0)';
            slider.style.background = hq ? COLORS.slow : COLORS.fast;
            window.pdfQualityMode = hq ? 'SLOW' : 'FAST';
            low.style.color = hq ? '#888' : '#fff';
            high.style.color = hq ? '#fff' : '#888';
            updateDownloadButtonText(hq);
        });
        slider.appendChild(ball); sw.appendChild(input); sw.appendChild(slider);
        labels.appendChild(low); labels.appendChild(high);
        ctrl.appendChild(sw); ctrl.appendChild(labels);
        wrap.appendChild(label); wrap.appendChild(ctrl);
        return wrap;
    }

    function addDownloadButton() {
        const container = document.createElement('div');
        container.id = 'pdfDownloadContainer';
        container.style.cssText = `position:fixed;top:65px;right:20px;z-index:9999;display:flex;align-items:center;gap:8px;transition:opacity .3s ease;`;

        const button = document.createElement('button');
        button.id = 'pdfDownloadButton';
        button.textContent = 'Download PDF (Fast)';
        button.style.cssText = `padding:8px 16px;background:#4285f4;color:#fff;border:none;border-radius:4px;cursor:pointer;font-family:Arial,sans-serif;font-size:14px;box-shadow:0 2px 5px rgba(0,0,0,.2);height:36px;display:flex;align-items:center;transition:all .3s ease;opacity:1;`;

        const info = document.createElement('div');
        info.id = 'pdfInfoIcon';
        info.textContent = 'ℹ️';
        info.style.cssText = `cursor:help;font-size:16px;position:relative;width:36px;height:36px;background:#4285f4;border-radius:4px;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 5px rgba(0,0,0,.2);transition:background .3s ease;`;

        const tooltip = document.createElement('div');
        tooltip.id = 'pdfDownloadTooltip';
        tooltip.style.cssText = `position:absolute;top:calc(100% + 8px);right:0;background:#333;color:#fff;padding:16px;border-radius:4px;font-size:13px;width:290px;display:none;z-index:10000;font-family:Arial,sans-serif;box-shadow:0 2px 10px rgba(0,0,0,.2);transition:opacity .3s ease;`;

        const t1 = document.createElement('div');
        // CSP-safe: sin innerHTML (Google Drive activó Trusted Types y lo bloquea)
        const t1a = document.createElement('strong');
        t1a.textContent = '✅ v8: ';
        t1.appendChild(t1a);
        t1.appendChild(document.createTextNode('CSP-safe. Lee cuántas páginas tiene el PDF y verifica que no falte ninguna.'));
        t1.style.marginBottom = '8px';

        const t2 = document.createElement('div');
        t2.style.cssText = `margin-bottom:2px;padding:8px;background:rgba(255,255,255,.1);border-radius:4px;`;
        // CSP-safe: construido con DOM en vez de innerHTML
        const t2title = document.createElement('div');
        t2title.style.cssText = 'margin-bottom:8px;font-weight:bold;';
        t2title.textContent = 'Verás:';
        const t2body = document.createElement('div');
        t2body.style.cssText = 'font-size:12px;line-height:1.4;';
        t2body.textContent = 'El contador muestra páginas capturadas / total, ej. "14/16". Si detecta que faltan, revisa la cola automáticamente.';
        t2.appendChild(t2title);
        t2.appendChild(t2body);

        const toggle = createToggleSwitch();

        const footer = document.createElement('div');
        footer.style.cssText = `display:flex;align-items:center;justify-content:center;margin-top:4px;padding-top:12px;border-top:1px solid rgba(255,255,255,.1);`;
        const author = document.createElement('span');
        author.textContent = 'Reportar problemas '; author.style.marginRight = '8px';
        const gh = document.createElement('a');
        gh.href = 'https://github.com/Akv2021/Enhanced-Google-Drive-PDF-Downloader/issues';
        gh.target = '_blank';
        gh.style.cssText = `color:#fff;text-decoration:none;display:flex;align-items:center;`;
        // CSP-safe: SVG creado con createElementNS en vez de innerHTML
        const NS = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(NS, 'svg');
        svg.setAttribute('height', '20');
        svg.setAttribute('width', '20');
        svg.setAttribute('viewBox', '0 0 16 16');
        svg.style.fill = '#fff';
        const path = document.createElementNS(NS, 'path');
        path.setAttribute('d', 'M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z');
        svg.appendChild(path);
        gh.appendChild(svg);

        let timer = null, hovered = false;
        function startTimer() {
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => {
                if (!hovered) {
                    tooltip.style.opacity = '0';
                    setTimeout(() => tooltip.style.display = 'none', 300);
                    info.style.background = '#4285f4';
                }
            }, 60000);
        }
        tooltip.addEventListener('mouseenter', () => { hovered = true; if (timer) clearTimeout(timer); });
        tooltip.addEventListener('mouseleave', () => { hovered = false; startTimer(); });
        info.addEventListener('mouseenter', () => {
            tooltip.style.display = 'block'; tooltip.style.opacity = '0';
            setTimeout(() => tooltip.style.opacity = '1', 10);
            info.style.background = '#3367d6'; startTimer();
        });
        info.addEventListener('mouseleave', () => { if (!hovered) startTimer(); });
        button.addEventListener('mouseover', () => { if (!button.disabled) button.style.background = '#3367d6'; });
        button.addEventListener('mouseout', () => { if (!button.disabled) button.style.background = '#4285f4'; });
        button.addEventListener('click', downloadPDF);

        tooltip.appendChild(t1); tooltip.appendChild(t2); tooltip.appendChild(toggle);
        footer.appendChild(author); footer.appendChild(gh); tooltip.appendChild(footer);
        info.appendChild(tooltip);
        container.appendChild(button); container.appendChild(info);
        document.body.appendChild(container);
    }

    function setupClickOutside() {
        document.addEventListener('click', e => {
            const tooltip = document.querySelector('#pdfDownloadTooltip');
            const info = document.querySelector('#pdfInfoIcon');
            if (tooltip && !tooltip.contains(e.target) && !info.contains(e.target)) {
                tooltip.style.opacity = '0';
                setTimeout(() => tooltip.style.display = 'none', 300);
                info.style.background = COLORS.default;
            }
        });
    }

    function initialize() {
        log('Iniciando PDF Downloader v8 (CSP-safe)...');
        // v8: cada paso va aislado. Antes, un error de CSP en la creación de la UI
        // rompía addDownloadButton a media ejecución y dejaba el script inservible.
        const boot = () => {
            try {
                addDownloadButton();
            } catch (e) {
                log(`Error creando la interfaz: ${e.message}`, 'error');
            }
            try {
                setupClickOutside();
            } catch (e) {
                log(`Error en setupClickOutside: ${e.message}`, 'error');
            }
            try {
                log(`Nombre detectado para este archivo: "${detectFileName()}"`);
            } catch (e) {
                log(`No se pudo detectar el nombre: ${e.message}`, 'error');
            }
        };
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', boot);
        } else {
            boot();
        }
    }

    initialize();
})();